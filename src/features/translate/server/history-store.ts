// The one place that reads and writes the translate database: one row per translate run (docs/data-model-proposal.md
// §3.5 and §4). The row is saved when the run starts, its output at checkpoints while it runs, and the row updated when
// it ends.
import type { DatabaseSync } from 'node:sqlite';
import type { Effort, Language, ModelId, ModelRun, RunErrorCode } from '../../../shared/api-types.ts';
import {
  RUN_CHECKS, RUN_FINISH_SET, RUN_INSERT_COLUMNS, RUN_INSERT_VALUES, runColumns, runOf, runRowOf, thinkingTextOf, TIME_COLUMNS, type RunRow,
} from '../../../shared/server/model-run.ts';
import { openDatabase } from '../../../shared/server/sqlite.ts';
import type { SourceFormat, TranslatedBlock, Translation, TranslationSummary } from '../api-types.ts';

export const SCHEMA_VERSION = 6;
const HISTORY_LIST_LIMIT = 200;
const PREVIEW_CHARS = { source: 200, output: 160 };
const INTERRUPTED_MESSAGE = 'The server stopped during the translation.';
// What an old failed translation says: schema 4 kept no error details.
const UNKNOWN_ERROR = 'Unknown (saved before error details were kept).';

// Schema 6: 1 when the run ended with no page watching it, until it is opened. Last among the columns, where ADD COLUMN puts
// it in a schema 5 file, so both files read the same.
const IS_UNREAD_COLUMN = 'is_unread INTEGER NOT NULL DEFAULT 0 CHECK (is_unread IN (0, 1))';

// AUTOINCREMENT: a deleted id is never reused, so a stale open or delete from the page cannot hit a newer entry.
const CREATE_TABLES = [
  `CREATE TABLE translations (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    source_language     TEXT    NOT NULL CHECK (source_language IN ('en', 'vi')),
    target_language     TEXT    NOT NULL CHECK (target_language IN ('en', 'vi')),
    source_format       TEXT    NOT NULL CHECK (source_format IN ('plain_text', 'markdown')),
    source_text         TEXT    NOT NULL,
    blocks_json         TEXT    NOT NULL CHECK (json_valid(blocks_json)),
    text_outside_blocks TEXT    CHECK (text_outside_blocks IS NULL OR text_outside_blocks <> ''),${runColumns(true)},${TIME_COLUMNS},
    ${IS_UNREAD_COLUMN},${RUN_CHECKS},
    CHECK (source_language <> target_language)
  ) STRICT`,
  'CREATE INDEX translations_by_created_at ON translations (created_at)',
  'CREATE INDEX translations_by_run_status ON translations (run_status)',
];

// ---- Schemas 1 to 4 (the old translations table; these steps move an old file to schema 4 first) ----

// Schema 1 -> 2: the thinking columns.
const ADD_THINKING_COLUMNS = [
  "ALTER TABLE translations ADD COLUMN thinking_text TEXT NOT NULL DEFAULT ''",
  'ALTER TABLE translations ADD COLUMN thinking_duration_ms INTEGER',
];
// Schema 2 -> 3: before it the model and effort were constants, Sonnet 5.5 at 'low', so the defaults are what every
// older row was asked for.
const ADD_CHOICE_COLUMNS = [
  'ALTER TABLE translations RENAME COLUMN model TO served_model_id',
  "ALTER TABLE translations ADD COLUMN requested_model_id TEXT NOT NULL DEFAULT 'claude-sonnet-5-5'",
  "ALTER TABLE translations ADD COLUMN effort TEXT NOT NULL DEFAULT 'low' CHECK (effort IN ('low', 'medium', 'high', 'xhigh', 'max'))",
];
// Schema 3 -> 4: before it there was one mode, so the DEFAULT is what every older row was.
const ADD_MODE_COLUMN = [
  "ALTER TABLE translations ADD COLUMN mode TEXT NOT NULL DEFAULT 'translate' CHECK (mode IN ('translate', 'translate_markdown'))",
];

interface Schema4Row {
  id: number;
  created_at: string;
  source_language: Language;
  target_language: Language;
  input_text: string;
  pairs_json: string;
  unpaired_text: string;
  outcome: 'done' | 'error' | 'cancelled';
  served_model_id: string;
  duration_ms: number;
  thinking_text: string;
  thinking_duration_ms: number | null;
  requested_model_id: string;
  effort: Effort;
  mode: 'translate' | 'translate_markdown';
}

interface Schema4Pair {
  pair_type: TranslatedBlock['blockType'];
  level: number;
  marker: string;
  source_text: string;
  translation_text: string;
}

const RUN_STATUS_OF_OUTCOME = { done: 'succeeded', error: 'failed', cancelled: 'cancelled' } as const;
const SOURCE_FORMAT_OF_MODE = { translate: 'plain_text', translate_markdown: 'markdown' } as const;

function blockOf(pair: Schema4Pair): TranslatedBlock {
  let marker: string | null = pair.marker;
  if (marker === '') marker = null;
  return { blockType: pair.pair_type, level: pair.level, marker, sourceText: pair.source_text, translatedText: pair.translation_text };
}

function emptyAsNull(text: string): string | null {
  if (text === '') return null;
  return text;
}

// Schema 4 -> 5 (the spec's §5): every row moved in code to the new table; ids and the AUTOINCREMENT counter are kept.
// finishedAt = createdAt + duration_ms; updatedAt = createdAt. The new table is CREATE_TABLES, today's schema, so it
// lands straight at SCHEMA_VERSION (no row is unread). The caller has made a backup and runs this in one transaction;
// any error rolls all of it back.
function migrateFrom4(database: DatabaseSync): void {
  const rows = database.prepare('SELECT * FROM translations ORDER BY id').all() as unknown as Schema4Row[];
  const sequence = database.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'translations'").get() as { seq: number } | undefined;
  database.exec('DROP TABLE translations');
  for (const statement of CREATE_TABLES) database.exec(statement);

  const insert = database.prepare(`
    INSERT INTO translations (id, source_language, target_language, source_format, source_text, blocks_json, text_outside_blocks,
                              ${RUN_INSERT_COLUMNS}, created_at, updated_at)
    VALUES ($id, $source_language, $target_language, $source_format, $source_text, $blocks_json, $text_outside_blocks,
            ${RUN_INSERT_VALUES}, $created_at, $created_at)`);
  for (const row of rows) {
    const pairs = JSON.parse(row.pairs_json) as Schema4Pair[];
    const status = RUN_STATUS_OF_OUTCOME[row.outcome];
    let errorCode: RunErrorCode | null = null;
    let errorMessage: string | null = null;
    if (status === 'failed') {
      errorCode = 'claude_error';
      errorMessage = UNKNOWN_ERROR;
    }
    const run: ModelRun = {
      status,
      requestedModelId: row.requested_model_id,
      servedModelId: row.served_model_id,
      effort: row.effort,
      thinkingText: thinkingTextOf(row.thinking_text),
      thinkingMs: row.thinking_duration_ms,
      errorCode,
      errorMessage,
      startedAt: row.created_at,
      finishedAt: new Date(Date.parse(row.created_at) + row.duration_ms).toISOString(),
    };
    insert.run({
      id: row.id,
      source_language: row.source_language,
      target_language: row.target_language,
      source_format: SOURCE_FORMAT_OF_MODE[row.mode],
      source_text: row.input_text,
      blocks_json: JSON.stringify(pairs.map(blockOf)),
      text_outside_blocks: emptyAsNull(row.unpaired_text),
      ...runRowOf(run),
      created_at: row.created_at,
    });
  }
  const count = (database.prepare('SELECT count(*) AS count FROM translations').get() as { count: number }).count;
  if (count !== rows.length) throw new Error(`migrating translations to schema ${SCHEMA_VERSION} would lose rows (${rows.length} -> ${count})`);
  if (sequence !== undefined) {
    database.prepare("UPDATE sqlite_sequence SET seq = max(seq, ?) WHERE name = 'translations'").run(sequence.seq);
    database.prepare("INSERT INTO sqlite_sequence (name, seq) SELECT 'translations', ? WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'translations')").run(sequence.seq);
  }
}

// Brings any older file to SCHEMA_VERSION. A file at 5 only gains the unread column. A file at 1 to 4 goes to schema 4 with
// the old steps, then to the new table, which migrateFrom4 builds at today's schema: it must not fall through to the
// ADD COLUMN, whose column that table already has. openDatabase calls it at every open; a file at SCHEMA_VERSION needs
// nothing.
function migrate(database: DatabaseSync, fileSchemaVersion: number): void {
  if (fileSchemaVersion === SCHEMA_VERSION) return;
  if (fileSchemaVersion === 0) {
    for (const statement of CREATE_TABLES) database.exec(statement);
    return;
  }
  if (fileSchemaVersion === 5) {
    database.exec(`ALTER TABLE translations ADD COLUMN ${IS_UNREAD_COLUMN}`);
    return;
  }
  if (fileSchemaVersion === 1) for (const statement of ADD_THINKING_COLUMNS) database.exec(statement);
  if (fileSchemaVersion <= 2) for (const statement of ADD_CHOICE_COLUMNS) database.exec(statement);
  if (fileSchemaVersion <= 3) for (const statement of ADD_MODE_COLUMN) database.exec(statement);
  migrateFrom4(database);
}

// ---- The store ----

// What startTranslation saves: the request, before the model has answered.
export interface NewTranslation {
  sourceLanguage: Language;
  targetLanguage: Language;
  sourceFormat: SourceFormat;
  sourceText: string;
  requestedModelId: ModelId;
  effort: Effort;
  startedAt: string;
}

// What a running run has produced so far.
export interface TranslationProgress {
  blocks: TranslatedBlock[];
  textOutsideBlocks: string;
  servedModelId: ModelId;
  thinkingText: string;
  thinkingMs: number | null;
}

// A row a restart cut short, and how many blocks its last checkpoint kept.
export interface InterruptedTranslation {
  id: number;
  blockCount: number;
}

// How a run ended, and what it produced (complete when it succeeded, partial or none otherwise).
interface TranslationOutcome extends TranslationProgress {
  status: 'succeeded' | 'failed' | 'cancelled';
  // True when no page watched the run end, so the sidebar marks it until it is opened.
  isUnread: boolean;
  // Set for 'failed' only.
  errorCode: RunErrorCode | null;
  errorMessage: string | null;
}

export interface HistoryStore {
  // Saves a run as it starts (status running); its id.
  startTranslation(translation: NewTranslation): number;
  // Saves what a running run has produced so far, so a crash keeps it; a row no longer running is left as it is.
  saveProgress(id: number, progress: TranslationProgress): void;
  // Saves how the run ended; a row that is no longer running is left as it is.
  finishTranslation(id: number, outcome: TranslationOutcome): void;
  // A server stopped mid-run leaves running rows nobody will finish: they become failed with 'interrupted', and unread,
  // so the sidebar points at them. The rows it changed, by id.
  failInterruptedTranslations(): InterruptedTranslation[];
  // Clears the unread mark of an opened entry; false when no translation had this id.
  markRead(id: number): boolean;
  listTranslations(): TranslationSummary[];
  readTranslation(id: number): Translation | null;
  deleteTranslation(id: number): boolean;
}

interface TranslationRow extends RunRow {
  id: number;
  source_language: Language;
  target_language: Language;
  source_format: SourceFormat;
  source_text: string;
  blocks_json: string;
  text_outside_blocks: string | null;
  created_at: string;
  updated_at: string;
  is_unread: 0 | 1;
}

interface SummaryRow extends Omit<TranslationRow, 'source_text' | 'blocks_json' | 'text_outside_blocks'> {
  source_preview: string;
  output_preview: string | null;
}

// Throws when the file was written by a newer version of this code, rather than risk damaging it. An older file is
// migrated after a backup (shared/server/sqlite.ts).
export function openHistoryStore(databasePath: string): HistoryStore {
  const database = openDatabase(databasePath, SCHEMA_VERSION, migrate);

  const insertTranslation = database.prepare(`
    INSERT INTO translations (source_language, target_language, source_format, source_text, blocks_json, text_outside_blocks,
                              ${RUN_INSERT_COLUMNS}, created_at, updated_at)
    VALUES ($source_language, $target_language, $source_format, $source_text, '[]', NULL, ${RUN_INSERT_VALUES}, $run_started_at, $run_started_at)`);
  // The run rules allow a running row "none yet, or partial" output (docs/data-model-proposal.md), so no column is added.
  const saveProgressRow = database.prepare(`
    UPDATE translations
    SET blocks_json = $blocks_json, text_outside_blocks = $text_outside_blocks, run_served_model_id = $run_served_model_id,
        run_thinking_text = $run_thinking_text, run_thinking_ms = $run_thinking_ms, updated_at = $now
    WHERE id = $id AND run_status = 'running'`);
  const finishTranslationRow = database.prepare(`
    UPDATE translations SET blocks_json = $blocks_json, text_outside_blocks = $text_outside_blocks, ${RUN_FINISH_SET},
                            is_unread = $is_unread, updated_at = $run_finished_at
    WHERE id = $id AND run_status = 'running'`);
  const failInterrupted = database.prepare(`
    UPDATE translations
    SET run_status = 'failed', run_error_code = 'interrupted', run_error_message = $message, run_finished_at = $now, is_unread = 1,
        updated_at = $now
    WHERE run_status = 'running'
    RETURNING id, json_array_length(blocks_json) AS block_count`);
  // updated_at is left alone: opening an entry does not change the translation.
  const markReadRow = database.prepare('UPDATE translations SET is_unread = 0 WHERE id = $id');
  // The output preview is worked out from the stored blocks (the first with a translation), so it can never disagree with
  // them; the text outside blocks stands in when the reply had none.
  const selectSummaries = database.prepare(`
    SELECT id, source_language, target_language, source_format, run_status, run_requested_model_id, run_served_model_id, run_effort,
           run_thinking_ms, run_error_code, run_error_message, run_started_at, run_finished_at, created_at, updated_at, is_unread,
           substr(source_text, 1, ${PREVIEW_CHARS.source}) AS source_preview,
           substr(coalesce(
             (SELECT block.value ->> '$.translatedText' FROM json_each(blocks_json) AS block
              WHERE block.value ->> '$.translatedText' <> '' ORDER BY block.key LIMIT 1),
             text_outside_blocks), 1, ${PREVIEW_CHARS.output}) AS output_preview
    FROM translations ORDER BY created_at DESC, id DESC LIMIT ${HISTORY_LIST_LIMIT}`);
  const selectTranslation = database.prepare('SELECT * FROM translations WHERE id = $id');
  const deleteTranslationRow = database.prepare('DELETE FROM translations WHERE id = $id');

  function startTranslation(translation: NewTranslation): number {
    const run: ModelRun = {
      status: 'running',
      requestedModelId: translation.requestedModelId,
      servedModelId: null,
      effort: translation.effort,
      thinkingText: null,
      thinkingMs: null,
      errorCode: null,
      errorMessage: null,
      startedAt: translation.startedAt,
      finishedAt: null,
    };
    const inserted = insertTranslation.run({
      source_language: translation.sourceLanguage,
      target_language: translation.targetLanguage,
      source_format: translation.sourceFormat,
      source_text: translation.sourceText,
      ...runRowOf(run),
    });
    return Number(inserted.lastInsertRowid);
  }

  function saveProgress(id: number, progress: TranslationProgress): void {
    saveProgressRow.run({
      id,
      blocks_json: JSON.stringify(progress.blocks),
      text_outside_blocks: emptyAsNull(progress.textOutsideBlocks),
      run_served_model_id: progress.servedModelId,
      run_thinking_text: thinkingTextOf(progress.thinkingText),
      run_thinking_ms: progress.thinkingMs,
      now: new Date().toISOString(),
    });
  }

  function finishTranslation(id: number, outcome: TranslationOutcome): void {
    finishTranslationRow.run({
      id,
      blocks_json: JSON.stringify(outcome.blocks),
      text_outside_blocks: emptyAsNull(outcome.textOutsideBlocks),
      run_status: outcome.status,
      run_served_model_id: outcome.servedModelId,
      run_thinking_text: thinkingTextOf(outcome.thinkingText),
      run_thinking_ms: outcome.thinkingMs,
      run_error_code: outcome.errorCode,
      run_error_message: outcome.errorMessage,
      run_finished_at: new Date().toISOString(),
      is_unread: outcome.isUnread ? 1 : 0,
    });
  }

  // RETURNING gives the rows in no set order, so they are sorted for the log.
  function failInterruptedTranslations(): InterruptedTranslation[] {
    const rows = failInterrupted.all({ message: INTERRUPTED_MESSAGE, now: new Date().toISOString() }) as unknown as { id: number; block_count: number }[];
    const interrupted = rows.map((row) => ({ id: row.id, blockCount: row.block_count }));
    return interrupted.sort((first, second) => first.id - second.id);
  }

  function markRead(id: number): boolean {
    return markReadRow.run({ id }).changes > 0;
  }

  // Newest first, at most HISTORY_LIST_LIMIT. The list leaves out the thinking text (null here), which only an open
  // entry shows.
  function listTranslations(): TranslationSummary[] {
    const rows = selectSummaries.all() as unknown as SummaryRow[];
    return rows.map((row) => ({
      id: row.id,
      sourceLanguage: row.source_language,
      targetLanguage: row.target_language,
      sourceFormat: row.source_format,
      run: { ...runOf(row), thinkingText: null },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      sourcePreview: row.source_preview,
      outputPreview: row.output_preview ?? '',
      isUnread: row.is_unread === 1,
    }));
  }

  function readTranslation(id: number): Translation | null {
    const row = selectTranslation.get({ id }) as TranslationRow | undefined;
    if (row === undefined) return null;
    return {
      id: row.id,
      sourceLanguage: row.source_language,
      targetLanguage: row.target_language,
      sourceFormat: row.source_format,
      sourceText: row.source_text,
      blocks: JSON.parse(row.blocks_json) as TranslatedBlock[],
      textOutsideBlocks: row.text_outside_blocks,
      run: runOf(row),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // false when no translation had this id.
  function deleteTranslation(id: number): boolean {
    return deleteTranslationRow.run({ id }).changes > 0;
  }

  return { startTranslation, saveProgress, finishTranslation, failInterruptedTranslations, markRead, listTranslations, readTranslation, deleteTranslation };
}
