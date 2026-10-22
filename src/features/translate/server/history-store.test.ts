// The translate database (history-store.ts) on scratch files: the run saved at its start, and the migration from
// schema 4 (the spec's §5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openHistoryStore, type NewTranslation } from './history-store.ts';

function scratchPath(): { directory: string; databasePath: string } {
  const directory = mkdtempSync(join(tmpdir(), 'translate-store-'));
  return { directory, databasePath: join(directory, 'translate.sqlite') };
}

function readRows(databasePath: string, sql: string): Record<string, unknown>[] {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const rows = database.prepare(sql).all().map((row) => ({ ...row }));
  database.close();
  return rows;
}

const REQUEST: NewTranslation = {
  sourceLanguage: 'en', targetLanguage: 'vi', sourceFormat: 'markdown', sourceText: 'Hello', requestedModelId: 'claude-sonnet-5-5',
  effort: 'low', startedAt: '2026-10-21T08:30:00.000Z',
};

test('a run is saved as it starts, then finished once with its output', () => {
  const store = openHistoryStore(scratchPath().databasePath);
  const id = store.startTranslation(REQUEST);
  const running = store.readTranslation(id)!;
  assert.equal(running.run.status, 'running');
  assert.equal(running.run.servedModelId, null);
  assert.deepEqual(running.blocks, []);
  assert.equal(running.createdAt, '2026-10-21T08:30:00.000Z');

  const block = { blockType: 'paragraph' as const, level: 0, marker: null, sourceText: 'Hello', translatedText: 'Xin chào' };
  store.finishTranslation(id, {
    status: 'succeeded', blocks: [block], textOutsideBlocks: '', servedModelId: 'claude-haiku-5-5', thinkingText: '', thinkingMs: null,
    errorCode: null, errorMessage: null,
  });
  // A late cancel does not overwrite it.
  store.finishTranslation(id, {
    status: 'cancelled', blocks: [], textOutsideBlocks: '', servedModelId: 'x', thinkingText: '', thinkingMs: null, errorCode: null, errorMessage: null,
  });
  const done = store.readTranslation(id)!;
  assert.equal(done.run.status, 'succeeded');
  assert.equal(done.run.servedModelId, 'claude-haiku-5-5');
  assert.equal(done.run.thinkingText, null);
  assert.deepEqual(done.blocks, [block]);
  assert.equal(done.textOutsideBlocks, null);
  assert.equal(done.updatedAt, done.run.finishedAt);

  const [summary] = store.listTranslations();
  assert.equal(summary.outputPreview, 'Xin chào');
  assert.equal(summary.sourceFormat, 'markdown');
  assert.equal(store.deleteTranslation(id), true);
  assert.equal(store.readTranslation(id), null);
});

test('a server restart fails the runs it interrupted', () => {
  const { databasePath } = scratchPath();
  const store = openHistoryStore(databasePath);
  const id = store.startTranslation(REQUEST);
  assert.equal(openHistoryStore(databasePath).failInterruptedTranslations(), 1);
  const run = store.readTranslation(id)!.run;
  assert.equal(run.status, 'failed');
  assert.equal(run.errorCode, 'interrupted');
});

test('the table refuses the same language on both sides', () => {
  const store = openHistoryStore(scratchPath().databasePath);
  assert.throws(() => store.startTranslation({ ...REQUEST, targetLanguage: 'en' }), /CHECK constraint failed/);
});

// Schema 4 as it shipped.
const SCHEMA_4 = `
  CREATE TABLE translations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, source_language TEXT NOT NULL, target_language TEXT NOT NULL,
    input_text TEXT NOT NULL, pairs_json TEXT NOT NULL, unpaired_text TEXT NOT NULL, outcome TEXT NOT NULL, served_model_id TEXT NOT NULL,
    duration_ms INTEGER NOT NULL, thinking_text TEXT NOT NULL DEFAULT '', thinking_duration_ms INTEGER,
    requested_model_id TEXT NOT NULL DEFAULT 'claude-sonnet-5-5', effort TEXT NOT NULL DEFAULT 'low', mode TEXT NOT NULL DEFAULT 'translate'
  ) STRICT;
  PRAGMA user_version = 4;`;

function schema4File() {
  const { directory, databasePath } = scratchPath();
  const database = new DatabaseSync(databasePath);
  database.exec(SCHEMA_4);
  const insert = database.prepare(`
    INSERT INTO translations (created_at, source_language, target_language, input_text, pairs_json, unpaired_text, outcome, served_model_id,
                              duration_ms, thinking_text, thinking_duration_ms, requested_model_id, effort, mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const pairs = JSON.stringify([
    { pair_type: 'list_item', level: 1, marker: '-', source_text: 'One', translation_text: 'Một' },
    { pair_type: 'paragraph', level: 0, marker: '', source_text: 'Two', translation_text: 'Hai' },
  ]);
  insert.run('2026-10-18T10:00:00.000Z', 'en', 'vi', '- One\n\nTwo', pairs, '', 'done', 'claude-haiku-5-5', 2500, 'Plan.', 800,
    'claude-sonnet-5-5', 'medium', 'translate_markdown');
  insert.run('2026-10-18T11:00:00.000Z', 'vi', 'en', 'Xin chào', '[]', 'Partial text', 'error', 'claude-sonnet-5-5', 1000, '', null,
    'claude-sonnet-5-5', 'low', 'translate');
  insert.run('2026-10-18T12:00:00.000Z', 'en', 'vi', 'Stop', '[]', 'x', 'cancelled', 'claude-sonnet-5-5', 300, '', null, 'claude-sonnet-5-5', 'low', 'translate');
  insert.run('2026-10-18T13:00:00.000Z', 'en', 'vi', 'Gone', '[]', 'x', 'done', 'claude-sonnet-5-5', 300, '', null, 'claude-sonnet-5-5', 'low', 'translate');
  database.exec('DELETE FROM translations WHERE id = 4');
  database.close();
  return { directory, databasePath };
}

test('the schema 4 migration backs the file up, then maps every row as the spec says', () => {
  const { directory, databasePath } = schema4File();
  const store = openHistoryStore(databasePath);
  assert.deepEqual(readRows(join(directory, 'backups', 'translate-before-schema-5.sqlite'), 'PRAGMA user_version'), [{ user_version: 4 }]);
  assert.deepEqual(readRows(databasePath, 'PRAGMA user_version'), [{ user_version: 5 }]);

  assert.deepEqual(store.readTranslation(1), {
    id: 1, sourceLanguage: 'en', targetLanguage: 'vi', sourceFormat: 'markdown', sourceText: '- One\n\nTwo',
    blocks: [
      { blockType: 'list_item', level: 1, marker: '-', sourceText: 'One', translatedText: 'Một' },
      { blockType: 'paragraph', level: 0, marker: null, sourceText: 'Two', translatedText: 'Hai' },
    ],
    textOutsideBlocks: null,
    run: {
      status: 'succeeded', requestedModelId: 'claude-sonnet-5-5', servedModelId: 'claude-haiku-5-5', effort: 'medium', thinkingText: 'Plan.',
      thinkingMs: 800, errorCode: null, errorMessage: null, startedAt: '2026-10-18T10:00:00.000Z', finishedAt: '2026-10-18T10:00:02.500Z',
    },
    createdAt: '2026-10-18T10:00:00.000Z',
    updatedAt: '2026-10-18T10:00:00.000Z',
  });
  const failed = store.readTranslation(2)!;
  assert.equal(failed.sourceFormat, 'plain_text');
  assert.equal(failed.textOutsideBlocks, 'Partial text');
  assert.equal(failed.run.status, 'failed');
  assert.equal(failed.run.errorCode, 'claude_error');
  assert.equal(failed.run.errorMessage, 'Unknown (saved before error details were kept).');
  const cancelled = store.readTranslation(3)!.run;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.errorCode, null);
});

test('after the schema 4 migration an id is never given twice', () => {
  const { databasePath } = schema4File();
  const store = openHistoryStore(databasePath);
  assert.equal(store.startTranslation(REQUEST), 5);
  assert.equal(store.listTranslations().length, 4);
});

test('a schema 1 file still goes through the old steps to schema 4, then to 5', () => {
  const { databasePath } = scratchPath();
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE translations (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, source_language TEXT NOT NULL,
      target_language TEXT NOT NULL, input_text TEXT NOT NULL, pairs_json TEXT NOT NULL, unpaired_text TEXT NOT NULL, outcome TEXT NOT NULL,
      model TEXT NOT NULL, duration_ms INTEGER NOT NULL) STRICT;
    INSERT INTO translations (created_at, source_language, target_language, input_text, pairs_json, unpaired_text, outcome, model, duration_ms)
    VALUES ('2026-01-01T00:00:00.000Z', 'en', 'vi', 'Hi', '[]', 'Chào', 'done', 'claude-sonnet-5-5', 100);
    PRAGMA user_version = 1;`);
  database.close();
  const translation = openHistoryStore(databasePath).readTranslation(1)!;
  assert.equal(translation.run.effort, 'low');
  assert.equal(translation.sourceFormat, 'plain_text');
  assert.equal(translation.textOutsideBlocks, 'Chào');
});
