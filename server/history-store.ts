// The one place that reads and writes the translate database: one row per translate run (docs/data-model-proposal.md
// §3.5 and §4). The row is saved when the run starts and updated when it ends.
import type { DatabaseSync } from 'node:sqlite';
import type { Effort, Language, ModelId, ModelRun, RunErrorCode, SourceFormat, TranslatedBlock, Translation, TranslationSummary } from '../shared/api.ts';
import {
  RUN_CHECKS, RUN_FINISH_SET, RUN_INSERT_COLUMNS, RUN_INSERT_VALUES, runColumns, runOf, runRowOf, thinkingTextOf, TIME_COLUMNS, type RunRow,
} from '../shared/server/model-run.ts';
import { openDatabase } from '../shared/server/sqlite.ts';

const SCHEMA_VERSION = 5;
const HISTORY_LIST_LIMIT = 200;
const PREVIEW_CHARS = { source: 200, output: 160 };
const INTERRUPTED_MESSAGE = 'The server stopped during the translation.';
// What an old failed translation says: schema 4 kept no error details.
const UNKNOWN_ERROR = 'Unknown (saved before error details were kept).';

// AUTOINCREMENT: a deleted id is never reused, so a stale open or delete from the page cannot hit a newer entry.
const CREATE_TABLES = [
  `CREATE TABLE translations (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    source_language     TEXT    NOT NULL CHECK (source_language IN ('en', 'vi')),
    target_language     TEXT    NOT NULL CHECK (target_language IN ('en', 'vi')),
    source_format       TEXT    NOT NULL CHECK (source_format IN ('plain_text', 'markdown')),
    source_text         TEXT    NOT NULL,
    blocks_json         TEXT    NOT NULL CHECK (json_valid(blocks_json)),
    text_outside_blocks TEXT    CHECK (text_outside_blocks IS NULL OR text_outside_blocks <> ''),${runColumns(true)},${TIME_COLUMNS},${RUN_CHECKS},
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
// finishedAt = createdAt + duration_ms; updatedAt = createdAt. The caller has made a backup and runs this in one
// transaction; any error rolls all of it back.
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
    let error_code: RunErrorCode | null = null;
    let error_message: string | null = null;
    if (status === 'failed') {
      error_code = 'claude_error';
      error_message = UNKNOWN_ERROR;
    }
    const run: ModelRun = {
      status,
      requestedModelId: row.requested_model_id,
      servedModelId: row.served_model_id,
      effort: row.effort,
      thinkingText: thinkingTextOf(row.thinking_text),
      thinkingMs: row.thinking_duration_ms,
      errorCode: error_code,
      errorMessage: error_message,
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
  if (count !== rows.length) throw new Error(`migrating translations to schema 5 would lose rows (${rows.length} -> ${count})`);
  if (sequence !== undefined) {
    database.prepare("UPDATE sqlite_sequence SET seq = max(seq, ?) WHERE name = 'translations'").run(sequence.seq);
    database.prepare("INSERT INTO sqlite_sequence (name, seq) SELECT 'translations', ? WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'translations')").run(sequence.seq);
  }
}

// Brings any older file to schema 5: first to schema 4 with the old steps, then to the new table.
// openDatabase calls it at every open; a file already at SCHEMA_VERSION needs nothing.
function migrate(database: DatabaseSync, file_schema_version: number): void {
  if (file_schema_version === SCHEMA_VERSION) return;
  if (file_schema_version === 0) {
    for (const statement of CREATE_TABLES) database.exec(statement);
    return;
  }
  if (file_schema_version === 1) for (const statement of ADD_THINKING_COLUMNS) database.exec(statement);
  if (file_schema_version <= 2) for (const statement of ADD_CHOICE_COLUMNS) database.exec(statement);
  if (file_schema_version <= 3) for (const statement of ADD_MODE_COLUMN) database.exec(statement);
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

// How a run ended, and what it produced (complete when it succeeded, partial or none otherwise).
export interface TranslationOutcome {
  status: 'succeeded' | 'failed' | 'cancelled';
  blocks: TranslatedBlock[];
  textOutsideBlocks: string;
  servedModelId: ModelId;
  thinkingText: string;
  thinkingMs: number | null;
  // Set for 'failed' only.
  errorCode: RunErrorCode | null;
  errorMessage: string | null;
}

export interface HistoryStore {
  // Saves a run as it starts (status running); its id.
  startTranslation(translation: NewTranslation): number;
  // Saves how the run ended; a row that is no longer running is left as it is.
  finishTranslation(id: number, outcome: TranslationOutcome): void;
  // A server stopped mid-run leaves running rows nobody will finish: they become failed with 'interrupted'.
  failInterruptedTranslations(): number;
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
}

interface SummaryRow extends Omit<TranslationRow, 'source_text' | 'blocks_json' | 'text_outside_blocks'> {
  source_preview: string;
  output_preview: string | null;
}

// Throws when the file was written by a newer version of this code, rather than risk damaging it. An older file is
// migrated after a backup (shared/server/sqlite.ts).
export function openHistoryStore(database_path: string): HistoryStore {
  const database = openDatabase(database_path, SCHEMA_VERSION, migrate);

  const insert_translation = database.prepare(`
    INSERT INTO translations (source_language, target_language, source_format, source_text, blocks_json, text_outside_blocks,
                              ${RUN_INSERT_COLUMNS}, created_at, updated_at)
    VALUES ($source_language, $target_language, $source_format, $source_text, '[]', NULL, ${RUN_INSERT_VALUES}, $run_started_at, $run_started_at)`);
  const finish_translation = database.prepare(`
    UPDATE translations SET blocks_json = $blocks_json, text_outside_blocks = $text_outside_blocks, ${RUN_FINISH_SET},
                            updated_at = $run_finished_at
    WHERE id = $id AND run_status = 'running'`);
  const fail_interrupted = database.prepare(`
    UPDATE translations
    SET run_status = 'failed', run_error_code = 'interrupted', run_error_message = $message, run_finished_at = $now, updated_at = $now
    WHERE run_status = 'running'`);
  // The output preview is worked out from the stored blocks (the first with a translation), so it can never disagree with
  // them; the text outside blocks stands in when the reply had none.
  const select_summaries = database.prepare(`
    SELECT id, source_language, target_language, source_format, run_status, run_requested_model_id, run_served_model_id, run_effort,
           run_thinking_ms, run_error_code, run_error_message, run_started_at, run_finished_at, created_at, updated_at,
           substr(source_text, 1, ${PREVIEW_CHARS.source}) AS source_preview,
           substr(coalesce(
             (SELECT block.value ->> '$.translatedText' FROM json_each(blocks_json) AS block
              WHERE block.value ->> '$.translatedText' <> '' ORDER BY block.key LIMIT 1),
             text_outside_blocks), 1, ${PREVIEW_CHARS.output}) AS output_preview
    FROM translations ORDER BY created_at DESC, id DESC LIMIT ${HISTORY_LIST_LIMIT}`);
  const select_translation = database.prepare('SELECT * FROM translations WHERE id = $id');
  const delete_translation = database.prepare('DELETE FROM translations WHERE id = $id');

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
    const inserted = insert_translation.run({
      source_language: translation.sourceLanguage,
      target_language: translation.targetLanguage,
      source_format: translation.sourceFormat,
      source_text: translation.sourceText,
      ...runRowOf(run),
    });
    return Number(inserted.lastInsertRowid);
  }

  function finishTranslation(id: number, outcome: TranslationOutcome): void {
    finish_translation.run({
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
    });
  }

  function failInterruptedTranslations(): number {
    const result = fail_interrupted.run({ message: INTERRUPTED_MESSAGE, now: new Date().toISOString() });
    return Number(result.changes);
  }

  // Newest first, at most HISTORY_LIST_LIMIT. The list leaves out the thinking text (null here), which only an open
  // entry shows.
  function listTranslations(): TranslationSummary[] {
    const rows = select_summaries.all() as unknown as SummaryRow[];
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
    }));
  }

  function readTranslation(id: number): Translation | null {
    const row = select_translation.get({ id }) as TranslationRow | undefined;
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
    return delete_translation.run({ id }).changes > 0;
  }

  return { startTranslation, finishTranslation, failInterruptedTranslations, listTranslations, readTranslation, deleteTranslation };
}
