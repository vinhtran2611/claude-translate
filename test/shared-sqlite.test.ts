// The shared SQL helpers (shared/server/sqlite.ts, shared/server/model-run.ts) on scratch files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ModelRun } from '../shared/api.ts';
import { RUN_INSERT_COLUMNS, RUN_INSERT_VALUES, runColumns, runOf, runRowOf, timeCheck, type RunRow } from '../shared/server/model-run.ts';
import { renameDatabaseOnce } from '../shared/server/sqlite.ts';

function scratchDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'shared-sqlite-'));
}

test('a database file is renamed once, after a backup, and never over an existing file', () => {
  const directory = scratchDirectory();
  const old_path = join(directory, 'history.sqlite');
  const new_path = join(directory, 'translate.sqlite');
  const database = new DatabaseSync(old_path);
  database.exec('CREATE TABLE notes (text TEXT); INSERT INTO notes VALUES (\'kept\')');
  database.close();

  assert.equal(renameDatabaseOnce(old_path, new_path), true);
  assert.equal(existsSync(old_path), false);
  const renamed = new DatabaseSync(new_path, { readOnly: true });
  assert.deepEqual({ ...renamed.prepare('SELECT text FROM notes').get() }, { text: 'kept' });
  renamed.close();
  const backup = new DatabaseSync(join(directory, 'backups', 'history-before-rename.sqlite'), { readOnly: true });
  assert.deepEqual({ ...backup.prepare('SELECT text FROM notes').get() }, { text: 'kept' });
  backup.close();

  // Nothing to rename now; and a new file is never replaced by an old one.
  assert.equal(renameDatabaseOnce(old_path, new_path), false);
  new DatabaseSync(old_path).close();
  assert.equal(renameDatabaseOnce(old_path, new_path), false);
  assert.equal(existsSync(old_path), true);
});

// A table that holds only a run, to check the run rules the CHECKs enforce.
function runTable(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec(`CREATE TABLE runs (id INTEGER PRIMARY KEY, ${runColumns(true)}) STRICT`);
  return database;
}

const SUCCEEDED: ModelRun = {
  status: 'succeeded', requestedModelId: 'claude-sonnet-5-5', servedModelId: 'claude-haiku-5-5', effort: 'low', thinkingText: null,
  thinkingMs: null, errorCode: null, errorMessage: null, startedAt: '2026-10-21T08:30:00.000Z', finishedAt: '2026-10-21T08:30:05.000Z',
};

function insertRun(database: DatabaseSync, run: ModelRun): void {
  database.prepare(`INSERT INTO runs (${RUN_INSERT_COLUMNS}) VALUES (${RUN_INSERT_VALUES})`).run({ ...runRowOf(run) });
}

test('a run is stored in its run_* columns and read back the same', () => {
  const database = runTable();
  insertRun(database, SUCCEEDED);
  const row = database.prepare('SELECT * FROM runs').get() as unknown as RunRow;
  assert.deepEqual(runOf(row), SUCCEEDED);
});

test('the CHECKs refuse a run that breaks the run rules', () => {
  const database = runTable();
  const broken: ModelRun[] = [
    { ...SUCCEEDED, finishedAt: null },
    { ...SUCCEEDED, status: 'running' },
    { ...SUCCEEDED, status: 'failed' },
    { ...SUCCEEDED, status: 'cancelled', errorCode: 'claude_error', errorMessage: 'x' },
    { ...SUCCEEDED, errorCode: 'claude_error', errorMessage: null },
    { ...SUCCEEDED, effort: null },
    { ...SUCCEEDED, startedAt: '21/10/2026' },
    { ...SUCCEEDED, thinkingText: '' },
  ];
  for (const run of broken) {
    assert.throws(() => insertRun(database, run), /CHECK constraint failed|NOT NULL constraint failed/, JSON.stringify(run));
  }
  insertRun(database, { ...SUCCEEDED, status: 'failed', errorCode: 'interrupted', errorMessage: 'The server stopped.' });
  insertRun(database, { ...SUCCEEDED, status: 'running', finishedAt: null, servedModelId: null });
});

test('a time column takes only an ISO time in UTC', () => {
  const database = new DatabaseSync(':memory:');
  database.exec(`CREATE TABLE times (at TEXT ${timeCheck('at', true)}) STRICT`);
  database.prepare('INSERT INTO times VALUES (?)').run('2026-10-21T08:30:00.000Z');
  database.prepare('INSERT INTO times VALUES (?)').run(null);
  assert.throws(() => database.prepare('INSERT INTO times VALUES (?)').run('2026-10-21 08:30'), /CHECK constraint failed/);
});
