// English log: two Claude Code hooks that save the English the user types and the correction Claude shows for it.
//   submit (UserPromptSubmit): stores the message and asks Claude to start its reply with the check block.
//   stop (Stop): finds that block in Claude's reply and stores the correction in the same row. It runs in the
//   foreground (about 0.1 s) because a background hook is killed when a `claude -p` run exits.
// Both always exit 0, so a failure can never block or delay a message. Errors go to stderr (the hook debug log).
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const APP_DIRECTORY = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const DATABASE_PATH = process.env.ENGLISH_LOG_DATABASE_PATH ?? join(APP_DIRECTORY, 'data', 'english-log.sqlite');
const SCHEMA_VERSION = 1;
const MIN_WORDS = 4;

// A fixed list of category names, so the corrections can be counted by kind.
export const CATEGORIES = [
  'article', 'singular_plural', 'subject_verb_agreement', 'verb_tense', 'verb_form', 'word_form', 'word_choice',
  'collocation', 'preposition', 'pronoun', 'sentence_structure', 'run_on', 'punctuation', 'spelling', 'linking',
  'register', 'other',
] as const;

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

const CREATE_MESSAGES_TABLE = `
  CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at  TEXT    NOT NULL,
    session_id  TEXT    NOT NULL,
    cwd         TEXT    NOT NULL,
    original    TEXT    NOT NULL,
    corrected   TEXT,
    errors_json TEXT,
    status      TEXT    NOT NULL CHECK (status IN ('pending', 'checked', 'clean', 'parse_failed')),
    checked_at  TEXT
  ) STRICT`;

export interface CheckError {
  wrong: string;
  right: string;
  category: string;
}

export type CheckResult = { status: 'clean' } | { status: 'checked'; corrected: string; errors: CheckError[] };

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
function categoryOf(written: string): string {
  const name = written.toLowerCase().replace(/[\s-]+/g, '_');
  if (/^capital/.test(name)) return 'punctuation';
  return (CATEGORIES as readonly string[]).includes(name) ? name : 'other';
}

// Reads the first check block in the reply. null when the reply has none.
export function parseCheckBlock(reply: string): CheckResult | null {
  const lines = reply.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (CLEAN_LINE.test(line)) return { status: 'clean' };
    const corrected_match = CORRECTED_LINE.exec(line);
    if (!corrected_match) continue;
    const corrected_parts = [corrected_match[1].trim()];
    const errors: CheckError[] = [];
    // The block ends at the first line that is not a quote line.
    for (let next = index + 1; next < lines.length && lines[next].trim().startsWith('>'); next++) {
      const next_line = lines[next].trim();
      if (/^>\s*-\s/.test(next_line)) {
        // A mistake line; one in an unexpected shape is skipped rather than mixed into the corrected text.
        const error_match = ERROR_LINE.exec(next_line);
        if (error_match) errors.push({ wrong: error_match[1].trim(), right: error_match[2].trim(), category: categoryOf(error_match[3]) });
      } else if (errors.length === 0) {
        // A long correction can wrap onto more quote lines before the first mistake line.
        const continuation = next_line.replace(/^>\s*/, '');
        if (continuation) corrected_parts.push(continuation);
      }
    }
    return { status: 'checked', corrected: corrected_parts.filter(Boolean).join('\n'), errors };
  }
  return null;
}

// Claude's text since the user's last message, oldest first, read from the session transcript (JSON lines).
// The check block is at the start of the reply, often before tool calls, so the Stop hook's last message is not enough.
export function replyTextSinceLastPrompt(transcript: string): string[] {
  const texts: string[] = [];
  const lines = transcript.trim().split('\n');
  for (let index = lines.length - 1; index >= 0; index--) {
    let entry;
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

export function openEnglishLog(database_path: string): DatabaseSync {
  mkdirSync(dirname(database_path), { recursive: true });
  const database = new DatabaseSync(database_path);
  database.exec('PRAGMA busy_timeout = 2000');
  database.exec('PRAGMA synchronous = FULL');
  const { user_version: file_schema_version } = database.prepare('PRAGMA user_version').get() as { user_version: number };
  if (file_schema_version > SCHEMA_VERSION) {
    throw new Error(`english log ${database_path} is at schema version ${file_schema_version}, newer than this code (${SCHEMA_VERSION})`);
  }
  database.exec('BEGIN IMMEDIATE');
  database.exec(CREATE_MESSAGES_TABLE);
  database.exec('CREATE INDEX IF NOT EXISTS messages_by_session ON messages (session_id, id)');
  database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  database.exec('COMMIT');
  return database;
}

interface HookInput {
  session_id: string;
  cwd?: string;
  prompt?: string;
  transcript_path?: string;
  last_assistant_message?: string;
}

function handleSubmit(input: HookInput): void {
  const text = ownText(input.prompt ?? '');
  if (!shouldCheck(text)) return;
  // The instruction goes out even if saving fails: seeing the correction is the main point.
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: CHECK_INSTRUCTION } }));
  const database = openEnglishLog(DATABASE_PATH);
  database.prepare(`INSERT INTO messages (created_at, session_id, cwd, original, status) VALUES (?, ?, ?, ?, 'pending')`)
    .run(new Date().toISOString(), input.session_id, input.cwd ?? '', text);
  database.close();
}

function handleStop(input: HookInput): void {
  const database = openEnglishLog(DATABASE_PATH);
  const pending = database.prepare(`SELECT id FROM messages WHERE session_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1`)
    .get(input.session_id) as { id: number } | undefined;
  if (pending) {
    const texts = input.transcript_path && existsSync(input.transcript_path)
      ? replyTextSinceLastPrompt(readFileSync(input.transcript_path, 'utf8'))
      : [];
    // The transcript can lag behind the last message, so that one is checked too.
    if (input.last_assistant_message) texts.push(input.last_assistant_message);
    const result = texts.map(parseCheckBlock).find((found) => found !== null) ?? null;
    database.prepare(`UPDATE messages SET status = ?, corrected = ?, errors_json = ?, checked_at = ? WHERE id = ?`).run(
      result?.status ?? 'parse_failed',
      result?.status === 'checked' ? result.corrected : null,
      result === null ? null : JSON.stringify(result.status === 'checked' ? result.errors : []),
      new Date().toISOString(),
      pending.id,
    );
  }
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
