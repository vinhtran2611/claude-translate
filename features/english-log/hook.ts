// English log: two Claude Code hooks that save the English the user types (an English check) and the mistakes Claude
// finds in it (English mistakes), as docs/data-model-proposal.md §3.6 describes them.
//   submit (UserPromptSubmit): saves the check with a running run and asks Claude to start its reply with the check block.
//   stop (Stop): finds that block in Claude's reply, ends the run and saves one row per mistake. It runs in the
//   foreground (about 0.1 s) because a background hook is killed when a `claude -p` run exits.
// Both always exit 0, so a failure can never block or delay a message. Errors go to stderr (the hook debug log).
// The hook that actually runs lives in its own repo (~/workspace/english-log); this copy is the one kept in step with
// the data model here.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { ModelRun, Timestamp } from '../../shared/api.ts';
import {
  RUN_CHECKS, RUN_FINISH_SET, RUN_INSERT_COLUMNS, RUN_INSERT_VALUES, runColumns, runRowOf, sqlList, TIME_COLUMNS,
} from '../../shared/server/model-run.ts';
import { openDatabase } from '../../shared/server/sqlite.ts';

const APP_DIRECTORY = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const DATABASE_PATH = process.env.ENGLISH_LOG_DATABASE_PATH ?? join(APP_DIRECTORY, 'data', 'english-log.sqlite');
const SCHEMA_VERSION = 2;
const MIN_WORDS = 4;
const NO_CHECK_BLOCK_MESSAGE = 'The reply had no check block.';
const INTERRUPTED_MESSAGE = 'A new message came before the reply to this one ended.';

// A fixed list of category names, so the mistakes can be counted by kind.
export const CATEGORIES = [
  'article', 'singular_plural', 'subject_verb_agreement', 'verb_tense', 'verb_form', 'word_form', 'word_choice',
  'collocation', 'preposition', 'pronoun', 'sentence_structure', 'run_on', 'punctuation', 'spelling', 'linking',
  'register', 'other',
] as const;

export type MistakeCategory = (typeof CATEGORIES)[number];

// One message the user typed, checked by Claude.
export interface EnglishCheck {
  id: number;
  claudeSessionId: string;
  workingDirectory: string | null;
  // The user's own words, without pasted text or code.
  sourceText: string;
  // The output; null when there are no mistakes.
  correctedText: string | null;
  run: ModelRun;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// One mistake found in a check.
export interface EnglishMistake {
  id: number;
  englishCheckId: number;
  // 1, 2, 3... in the check.
  position: number;
  wrongText: string;
  correctText: string;
  category: MistakeCategory;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export const CHECK_INSTRUCTION = `English check. The user is practising English for IELTS and asked for this on every message.
Start your reply, before anything else, with this block about the English the user typed in this message.
Check only the user's own words: ignore pasted text, quoted text, code, logs and images.

If there are mistakes:
> ✏️ **Corrected:** <the whole message, corrected; if it is over 60 words, only the sentences that had mistakes>
> - *<the exact wrong words>* → **<the right words>** · <category>
(one "> -" line per mistake)

If there are none:
> ✓ No mistakes.

<category> is one of: ${CATEGORIES.join(', ')}.
Write <category> exactly as one of those names; capital letters count as punctuation.
Fix real mistakes only (grammar, word choice, spelling, punctuation, capital letters). Keep the user's meaning and tone.
After the block, answer the message as usual.`;

// The tables of the spec's §4. Mistakes are a table, not JSON, because the point of the log is to count them by category.
// The run's model and effort are NULL: Claude Code chooses them, not the hook.
const CREATE_TABLES = [
  `CREATE TABLE english_checks (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    claude_session_id TEXT    NOT NULL,
    working_directory TEXT    CHECK (working_directory IS NULL OR working_directory <> ''),
    source_text       TEXT    NOT NULL,
    corrected_text    TEXT,${runColumns(false)},${TIME_COLUMNS},${RUN_CHECKS}
  ) STRICT`,
  'CREATE INDEX english_checks_by_claude_session_id_id ON english_checks (claude_session_id, id)',
  'CREATE INDEX english_checks_by_run_status ON english_checks (run_status)',
  `CREATE TABLE english_mistakes (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    english_check_id INTEGER NOT NULL REFERENCES english_checks (id) ON DELETE CASCADE,
    position         INTEGER NOT NULL CHECK (position >= 1),
    wrong_text       TEXT    NOT NULL,
    correct_text     TEXT    NOT NULL,
    category         TEXT    NOT NULL CHECK (category IN ${sqlList(CATEGORIES)}),${TIME_COLUMNS},
    UNIQUE (english_check_id, position)
  ) STRICT`,
  'CREATE INDEX english_mistakes_by_category ON english_mistakes (category)',
];

// One mistake line of a check block.
export interface ParsedMistake {
  wrongText: string;
  correctText: string;
  category: MistakeCategory;
}

// What a check block says. correctedText is null when there are no mistakes.
export interface ParsedCheck {
  correctedText: string | null;
  mistakes: ParsedMistake[];
}

// The user's own words: pasted blocks and fenced code removed.
export function ownText(prompt: string): string {
  return prompt
    .replace(/<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content\b[^>]*>/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .trim();
}

// Slash commands, app events (they start with a tag) and very short replies like "yes, do it" are not worth checking.
export function shouldCheck(text: string): boolean {
  if (text.startsWith('/') || text.startsWith('<')) return false;
  return (text.match(/[A-Za-z]+/g) ?? []).length >= MIN_WORDS;
}

const CORRECTED_LINE = /^>\s*(?:✏️?\s*)?\*\*Corrected:\*\*\s*(.*)$/;
const ERROR_LINE = /^>\s*-\s*\*(.+?)\*\s*→\s*\*\*(.+?)\*\*\s*·\s*(.+?)\s*$/;
const CLEAN_LINE = /^>\s*✓\s*No mistakes/;

// Models sometimes write a category in their own words ("capital letters"); map those, and anything unknown to 'other'.
export function categoryOf(written: string): MistakeCategory {
  const name = written.toLowerCase().replace(/[\s-]+/g, '_');
  if (/^capital/.test(name)) return 'punctuation';
  const known = CATEGORIES.find((category) => category === name);
  return known ?? 'other';
}

// Reads the first check block in the reply. null when the reply has none.
export function parseCheckBlock(reply: string): ParsedCheck | null {
  const lines = reply.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (CLEAN_LINE.test(line)) return { correctedText: null, mistakes: [] };
    const corrected_match = CORRECTED_LINE.exec(line);
    if (!corrected_match) continue;
    const corrected_parts = [corrected_match[1].trim()];
    const mistakes: ParsedMistake[] = [];
    // The block ends at the first line that is not a quote line.
    for (let next = index + 1; next < lines.length && lines[next].trim().startsWith('>'); next++) {
      const next_line = lines[next].trim();
      if (/^>\s*-\s/.test(next_line)) {
        // A mistake line; one in an unexpected shape is skipped rather than mixed into the corrected text.
        const mistake_match = ERROR_LINE.exec(next_line);
        if (mistake_match === null) continue;
        mistakes.push({ wrongText: mistake_match[1].trim(), correctText: mistake_match[2].trim(), category: categoryOf(mistake_match[3]) });
      } else if (mistakes.length === 0) {
        // A long correction can wrap onto more quote lines before the first mistake line.
        const continuation = next_line.replace(/^>\s*/, '');
        if (continuation) corrected_parts.push(continuation);
      }
    }
    const corrected_text = corrected_parts.filter(Boolean).join('\n');
    return { correctedText: corrected_text === '' ? null : corrected_text, mistakes };
  }
  return null;
}

// Claude's text since the user's last message, oldest first, read from the session transcript (JSON lines).
// The check block is at the start of the reply, often before tool calls, so the Stop hook's last message is not enough.
export function replyTextSinceLastPrompt(transcript: string): string[] {
  const texts: string[] = [];
  const lines = transcript.trim().split('\n');
  for (let index = lines.length - 1; index >= 0; index--) {
    let entry: { type?: string; isMeta?: boolean; isSidechain?: boolean; message?: { content?: unknown } };
    try {
      entry = JSON.parse(lines[index]);
    } catch {
      continue;
    }
    const content = entry.message?.content;
    if (entry.type === 'user' && !entry.isMeta && !entry.isSidechain) {
      const is_tool_result = Array.isArray(content) && content.some((part: { type?: string }) => part.type === 'tool_result');
      if (!is_tool_result) break;
    }
    if (entry.type === 'assistant' && !entry.isSidechain && Array.isArray(content)) {
      const text = content.filter((part: { type?: string }) => part.type === 'text').map((part: { text: string }) => part.text).join('\n');
      if (text) texts.unshift(text);
    }
  }
  return texts;
}

// ---- Schema 1 -> 2 (the spec's §5) ----

interface Schema1Row {
  id: number;
  created_at: string;
  session_id: string;
  cwd: string;
  original: string;
  corrected: string | null;
  errors_json: string | null;
  status: 'pending' | 'checked' | 'clean' | 'parse_failed';
  checked_at: string | null;
}

const RUN_STATUS_OF_SCHEMA_1 = { pending: 'running', checked: 'succeeded', clean: 'succeeded', parse_failed: 'failed' } as const;

// messages -> english_checks, and each errors_json item -> one english_mistakes row. Ids and the counter are kept;
// updatedAt = createdAt. The caller (openDatabase) has made a backup and runs this in one transaction.
function migrateFrom1(database: DatabaseSync): void {
  const rows = database.prepare('SELECT * FROM messages ORDER BY id').all() as unknown as Schema1Row[];
  const sequence = database.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'messages'").get() as { seq: number } | undefined;
  database.exec('DROP TABLE messages');
  for (const statement of CREATE_TABLES) database.exec(statement);

  const insert_check = database.prepare(`
    INSERT INTO english_checks (id, claude_session_id, working_directory, source_text, corrected_text, ${RUN_INSERT_COLUMNS}, created_at, updated_at)
    VALUES ($id, $claude_session_id, $working_directory, $source_text, $corrected_text, ${RUN_INSERT_VALUES}, $created_at, $created_at)`);
  const insert_mistake = database.prepare(`
    INSERT INTO english_mistakes (english_check_id, position, wrong_text, correct_text, category, created_at, updated_at)
    VALUES ($english_check_id, $position, $wrong_text, $correct_text, $category, $created_at, $created_at)`);
  for (const row of rows) {
    const status = RUN_STATUS_OF_SCHEMA_1[row.status];
    let finished_at: string | null = null;
    if (status !== 'running') finished_at = row.checked_at ?? row.created_at;
    const run: ModelRun = {
      status,
      requestedModelId: null,
      servedModelId: null,
      effort: null,
      thinkingText: null,
      thinkingMs: null,
      errorCode: status === 'failed' ? 'no_check_block' : null,
      errorMessage: status === 'failed' ? NO_CHECK_BLOCK_MESSAGE : null,
      startedAt: row.created_at,
      finishedAt: finished_at,
    };
    let working_directory: string | null = row.cwd;
    if (working_directory === '') working_directory = null;
    insert_check.run({
      id: row.id,
      claude_session_id: row.session_id,
      working_directory,
      source_text: row.original,
      corrected_text: row.corrected,
      ...runRowOf(run),
      created_at: row.created_at,
    });
    const old_mistakes = JSON.parse(row.errors_json ?? '[]') as { wrong: string; right: string; category: string }[];
    old_mistakes.forEach((mistake, index) => {
      insert_mistake.run({
        english_check_id: row.id,
        position: index + 1,
        wrong_text: mistake.wrong,
        correct_text: mistake.right,
        category: categoryOf(mistake.category),
        created_at: finished_at ?? row.created_at,
      });
    });
  }
  const count = (database.prepare('SELECT count(*) AS count FROM english_checks').get() as { count: number }).count;
  if (count !== rows.length) throw new Error(`migrating the english log to schema 2 would lose rows (${rows.length} -> ${count})`);
  if (sequence !== undefined) {
    database.prepare("UPDATE sqlite_sequence SET seq = max(seq, ?) WHERE name = 'english_checks'").run(sequence.seq);
    database.prepare("INSERT INTO sqlite_sequence (name, seq) SELECT 'english_checks', ? WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'english_checks')").run(sequence.seq);
  }
}

// Opens the log, making or migrating it as needed (after a backup to backups/ next to it).
export function openEnglishLog(database_path: string): DatabaseSync {
  const database = openDatabase(database_path, SCHEMA_VERSION, (migrating_database, file_schema_version) => {
    if (file_schema_version === 0) {
      for (const statement of CREATE_TABLES) migrating_database.exec(statement);
    } else if (file_schema_version === 1) {
      migrateFrom1(migrating_database);
    }
  });
  database.exec('PRAGMA foreign_keys = ON');
  return database;
}

interface HookInput {
  session_id: string;
  cwd?: string;
  prompt?: string;
  transcript_path?: string;
  last_assistant_message?: string;
}

// Saves a check whose run has just started. A check of the same session still running never got its Stop (the user
// stopped the reply): it becomes failed with 'interrupted', as the run rules say for a run that was cut off.
export function saveNewCheck(database: DatabaseSync, claude_session_id: string, working_directory: string | null, source_text: string): number {
  const now = new Date().toISOString();
  database.prepare(`
    UPDATE english_checks
    SET run_status = 'failed', run_error_code = 'interrupted', run_error_message = ?, run_finished_at = ?, updated_at = ?
    WHERE claude_session_id = ? AND run_status = 'running'`).run(INTERRUPTED_MESSAGE, now, now, claude_session_id);
  const run: ModelRun = {
    status: 'running', requestedModelId: null, servedModelId: null, effort: null, thinkingText: null, thinkingMs: null,
    errorCode: null, errorMessage: null, startedAt: now, finishedAt: null,
  };
  const inserted = database.prepare(`
    INSERT INTO english_checks (claude_session_id, working_directory, source_text, corrected_text, ${RUN_INSERT_COLUMNS}, created_at, updated_at)
    VALUES ($claude_session_id, $working_directory, $source_text, NULL, ${RUN_INSERT_VALUES}, $now, $now)`)
    .run({ claude_session_id, working_directory, source_text, ...runRowOf(run), now });
  return Number(inserted.lastInsertRowid);
}

// Ends the session's running check: succeeded with its mistakes, or failed when the reply had no check block.
export function finishCheck(database: DatabaseSync, claude_session_id: string, parsed: ParsedCheck | null): void {
  const running = database.prepare(`
    SELECT id FROM english_checks WHERE claude_session_id = ? AND run_status = 'running' ORDER BY id DESC LIMIT 1`)
    .get(claude_session_id) as { id: number } | undefined;
  if (running === undefined) return;
  const now = new Date().toISOString();
  const is_found = parsed !== null;
  database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare(`UPDATE english_checks SET corrected_text = $corrected_text, ${RUN_FINISH_SET}, updated_at = $run_finished_at WHERE id = $id`).run({
      id: running.id,
      corrected_text: parsed?.correctedText ?? null,
      run_status: is_found ? 'succeeded' : 'failed',
      run_served_model_id: null,
      run_thinking_text: null,
      run_thinking_ms: null,
      run_error_code: is_found ? null : 'no_check_block',
      run_error_message: is_found ? null : NO_CHECK_BLOCK_MESSAGE,
      run_finished_at: now,
    });
    const insert_mistake = database.prepare(`
      INSERT INTO english_mistakes (english_check_id, position, wrong_text, correct_text, category, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const mistakes = parsed?.mistakes ?? [];
    mistakes.forEach((mistake, index) => {
      insert_mistake.run(running.id, index + 1, mistake.wrongText, mistake.correctText, mistake.category, now, now);
    });
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function handleSubmit(input: HookInput): void {
  const text = ownText(input.prompt ?? '');
  if (!shouldCheck(text)) return;
  // The instruction goes out even if saving fails: seeing the correction is the main point.
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: CHECK_INSTRUCTION } }));
  const database = openEnglishLog(DATABASE_PATH);
  let working_directory: string | null = input.cwd ?? null;
  if (working_directory === '') working_directory = null;
  saveNewCheck(database, input.session_id, working_directory, text);
  database.close();
}

function handleStop(input: HookInput): void {
  const database = openEnglishLog(DATABASE_PATH);
  let texts: string[] = [];
  if (input.transcript_path && existsSync(input.transcript_path)) texts = replyTextSinceLastPrompt(readFileSync(input.transcript_path, 'utf8'));
  // The transcript can lag behind the last message, so that one is checked too.
  if (input.last_assistant_message) texts.push(input.last_assistant_message);
  const parsed = texts.map(parseCheckBlock).find((found) => found !== null) ?? null;
  finishCheck(database, input.session_id, parsed);
  database.close();
}

if (import.meta.main) {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8')) as HookInput;
    if (process.argv[2] === 'submit') handleSubmit(input);
    else if (process.argv[2] === 'stop') handleStop(input);
    else throw new Error(`unknown mode ${process.argv[2]}; use submit or stop`);
  } catch (error) {
    process.stderr.write(`english-log: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exit(0);
}
