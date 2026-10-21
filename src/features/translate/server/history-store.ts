// The one place that reads and writes the translation history database.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Pair } from '../../../shared/api-types.ts';
import type { HistoryEntry, HistorySummary } from '../api-types.ts';

const SCHEMA_VERSION = 4;
const HISTORY_LIST_LIMIT = 200;

// AUTOINCREMENT: a deleted id is never reused, so a stale open or delete from the page cannot hit a newer entry.
const CREATE_TRANSLATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS translations (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at           TEXT    NOT NULL,
    source_language      TEXT    NOT NULL CHECK (source_language IN ('en', 'vi')),
    target_language      TEXT    NOT NULL CHECK (target_language IN ('en', 'vi')),
    input_text           TEXT    NOT NULL,
    pairs_json           TEXT    NOT NULL,
    unpaired_text        TEXT    NOT NULL,
    outcome              TEXT    NOT NULL CHECK (outcome IN ('done', 'error', 'cancelled')),
    served_model_id      TEXT    NOT NULL,
    duration_ms          INTEGER NOT NULL,
    thinking_text        TEXT    NOT NULL DEFAULT '',
    thinking_duration_ms INTEGER,
    requested_model_id   TEXT    NOT NULL DEFAULT 'claude-sonnet-5-5',
    effort               TEXT    NOT NULL DEFAULT 'low' CHECK (effort IN ('low', 'medium', 'high', 'xhigh', 'max')),
    mode                 TEXT    NOT NULL DEFAULT 'translate' CHECK (mode IN ('translate', 'translate_markdown'))
  ) STRICT`;

// The same column definitions as in CREATE_TRANSLATIONS_TABLE, so a migrated file matches a new one.
const ADD_THINKING_COLUMNS = [
  "ALTER TABLE translations ADD COLUMN thinking_text TEXT NOT NULL DEFAULT ''",
  'ALTER TABLE translations ADD COLUMN thinking_duration_ms INTEGER',
];
// Before version 3 the model and effort were constants, Sonnet 5.5 at 'low', so the defaults are what every older
// row was asked for. The CHECK allows every CLI effort, so offering another one needs no migration.
const ADD_CHOICE_COLUMNS = [
  'ALTER TABLE translations RENAME COLUMN model TO served_model_id',
  "ALTER TABLE translations ADD COLUMN requested_model_id TEXT NOT NULL DEFAULT 'claude-sonnet-5-5'",
  "ALTER TABLE translations ADD COLUMN effort TEXT NOT NULL DEFAULT 'low' CHECK (effort IN ('low', 'medium', 'high', 'xhigh', 'max'))",
];
// Before version 4 there was one mode, so the DEFAULT is what every older row was.
const ADD_MODE_COLUMN = [
  "ALTER TABLE translations ADD COLUMN mode TEXT NOT NULL DEFAULT 'translate' CHECK (mode IN ('translate', 'translate_markdown'))",
];

// What saveEntry stores: an entry as the server knows it before the database gives it an id.
export type NewHistoryEntry = Omit<HistoryEntry, 'id' | 'is_fallback'>;

export interface HistoryStore {
  saveEntry(entry: NewHistoryEntry): number;
  listEntries(): HistorySummary[];
  readEntry(entry_id: number): Omit<HistoryEntry, 'is_fallback'> | null;
  deleteEntry(entry_id: number): boolean;
}

// Throws when the file was written by a newer version of this code, rather than risk damaging it.
export function openHistoryStore(database_path: string): HistoryStore {
  mkdirSync(dirname(database_path), { recursive: true });
  const database = new DatabaseSync(database_path);
  database.exec('PRAGMA busy_timeout = 2000');
  const { user_version: file_schema_version } = database.prepare('PRAGMA user_version').get() as { user_version: number };
  if (file_schema_version > SCHEMA_VERSION) {
    throw new Error(`history database ${database_path} is at schema version ${file_schema_version}, newer than this code (${SCHEMA_VERSION})`);
  }
  database.exec('BEGIN IMMEDIATE');
  database.exec(CREATE_TRANSLATIONS_TABLE);
  // A new file just got every column from the CREATE; an older file gets the columns its version lacks, in order.
  if (file_schema_version === 1) for (const statement of ADD_THINKING_COLUMNS) database.exec(statement);
  if (file_schema_version === 1 || file_schema_version === 2) for (const statement of ADD_CHOICE_COLUMNS) database.exec(statement);
  if (file_schema_version >= 1 && file_schema_version <= 3) for (const statement of ADD_MODE_COLUMN) database.exec(statement);
  database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  database.exec('COMMIT');

  const insert_entry = database.prepare(`
    INSERT INTO translations (created_at, source_language, target_language, input_text, pairs_json, unpaired_text, outcome,
                              served_model_id, duration_ms, thinking_text, thinking_duration_ms, requested_model_id, effort, mode)
    VALUES ($created_at, $source_language, $target_language, $input_text, $pairs_json, $unpaired_text, $outcome,
            $served_model_id, $duration_ms, $thinking_text, $thinking_duration_ms, $requested_model_id, $effort, $mode)`);
  // output_preview is derived at read time from the stored pairs (first pair with a translation), so it can
  // never disagree with them; unpaired text stands in when the reply had no pairs.
  const select_summaries = database.prepare(`
    SELECT id, created_at, source_language, target_language, outcome, served_model_id, requested_model_id, effort, mode,
            substr(input_text, 1, 200) AS input_preview,
            substr(coalesce(
              (SELECT json_extract(pair.value, '$.translation_text') FROM json_each(pairs_json) AS pair
              WHERE json_extract(pair.value, '$.translation_text') <> '' ORDER BY pair.key LIMIT 1),
              unpaired_text), 1, 160) AS output_preview
    FROM translations ORDER BY created_at DESC, id DESC LIMIT ${HISTORY_LIST_LIMIT}`);
  const select_entry = database.prepare('SELECT * FROM translations WHERE id = $id');
  const delete_entry = database.prepare('DELETE FROM translations WHERE id = $id');

  // entry: { created_at, source_language, target_language, input_text, pairs, unpaired_text, outcome, duration_ms,
  //     served_model_id (the model that answered), requested_model_id (the one chosen; differs after a fallback),
  //     effort, mode, thinking_text ('' when there is no summary), thinking_duration_ms (null when the model did not think) }
  // input_text is what was pasted; in mode 'translate_markdown' the pairs' source_text is its reformatted form.
  function saveEntry(entry: NewHistoryEntry): number {
    const { pairs, ...columns } = entry;
    return Number(insert_entry.run({ ...columns, pairs_json: JSON.stringify(pairs) }).lastInsertRowid);
  }

  // Newest first, at most HISTORY_LIST_LIMIT.
  function listEntries(): HistorySummary[] {
    return select_summaries.all() as unknown as HistorySummary[];
  }

  // null when no entry has this id.
  function readEntry(entry_id: number): Omit<HistoryEntry, 'is_fallback'> | null {
    const row = select_entry.get({ id: entry_id }) as (Omit<HistoryEntry, 'is_fallback' | 'pairs'> & { pairs_json: string }) | undefined;
    if (!row) return null;
    const { pairs_json, ...columns } = row;
    return { ...columns, pairs: JSON.parse(pairs_json) as Pair[] };
  }

  // false when no entry had this id.
  function deleteEntry(entry_id: number): boolean {
    return delete_entry.run({ id: entry_id }).changes > 0;
  }

  return { saveEntry, listEntries, readEntry, deleteEntry };
}
