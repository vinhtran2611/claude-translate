// The shared SQL helpers (sqlite.ts, and the run columns of model-run.ts) on scratch files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ModelRun } from '../api-types.ts';
import { RUN_CHECKS, RUN_INSERT_COLUMNS, RUN_INSERT_VALUES, runColumns, runOf, runRowOf, timeCheck, type RunRow } from './model-run.ts';
import { renameDatabaseOnce } from './sqlite.ts';

function scratchDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'shared-sqlite-'));
}

// A scratch database with one row of text, at a schema version.
function makeDatabase(databasePath: string, text: string, userVersion: number): void {
  const database = new DatabaseSync(databasePath);
  database.exec(`CREATE TABLE notes (text TEXT); PRAGMA user_version = ${userVersion}`);
  database.prepare('INSERT INTO notes VALUES (?)').run(text);
  database.close();
}

function noteIn(databasePath: string): unknown {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const row = { ...database.prepare('SELECT text FROM notes').get() };
  database.close();
  return row.text;
}

test('a database file is renamed once, after a backup; a file already migrated is never replaced', () => {
  const directory = scratchDirectory();
  const oldPath = join(directory, 'history.sqlite');
  const newPath = join(directory, 'translate.sqlite');
  makeDatabase(oldPath, 'kept', 4);

  assert.equal(renameDatabaseOnce(oldPath, newPath, 5), 'renamed');
  assert.equal(existsSync(oldPath), false);
  assert.equal(noteIn(newPath), 'kept');
  assert.equal(noteIn(join(directory, 'backups', 'history-before-rename.sqlite')), 'kept');

  // Nothing to rename now. An old file showing up again never replaces one at the new schema.
  assert.equal(renameDatabaseOnce(oldPath, newPath, 5), 'nothing');
  const database = new DatabaseSync(newPath);
  database.exec('PRAGMA user_version = 5');
  database.close();
  makeDatabase(oldPath, 'stray', 4);
  assert.equal(renameDatabaseOnce(oldPath, newPath, 5), 'nothing');
  assert.equal(noteIn(newPath), 'kept');
});

test('an older file left at the new name (before practice-v2) is moved to backups/, then the rename is done', () => {
  const directory = scratchDirectory();
  const oldPath = join(directory, 'practice-v2.sqlite');
  const newPath = join(directory, 'practice.sqlite');
  makeDatabase(oldPath, 'current', 2);
  makeDatabase(newPath, 'very old', 0);

  assert.equal(renameDatabaseOnce(oldPath, newPath, 3), 'renamed_after_set_aside');
  assert.equal(noteIn(newPath), 'current');
  assert.equal(noteIn(join(directory, 'backups', 'practice-set-aside.sqlite')), 'very old');
});

// A table that holds only a run, to check the run rules the CHECKs enforce.
function runTable(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec(`CREATE TABLE runs (id INTEGER PRIMARY KEY, ${runColumns(true)}, ${RUN_CHECKS}) STRICT`);
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
