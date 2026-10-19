// The practice database (features/practice/server/store.ts) on a scratch file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FileExercise, ProjectFile } from '../features/practice/api.ts';
import { keyFromName, openPracticeStore } from '../features/practice/server/store.ts';

const card = (key: string, front: string): FileExercise => ({ key, type: 'flashcard', topic: null, tags: [], content: { front, back: 'b' } });
const rewrite = (key: string, text: string): FileExercise => ({ key, type: 'rewrite', topic: 'topic', tags: [], content: { instruction: 'Fix', text, length: 'sentence' } });
const file = (...exercises: FileExercise[]): ProjectFile => ({ name: 'Week 1', description: '', exercises });

function scratchStore() {
  const database_path = join(mkdtempSync(join(tmpdir(), 'practice-store-')), 'practice-v2.sqlite');
  return { store: openPracticeStore(database_path), database_path };
}

function answer(store: ReturnType<typeof openPracticeStore>, exercise_id: number, outcome: object | null, grader: 'ai' | 'self' = 'self') {
  const exercise = store.readExercise(exercise_id)!;
  const text = exercise.type === 'flashcard' ? { rating: 'known' } : { text: 'My answer.' };
  return store.createAttempt({ exercise, answer: text as never, writing_ms: 1500, grader, outcome: outcome as never });
}

test('a project is created with its exercises in file order, and counted by type', () => {
  const { store } = scratchStore();
  const id = store.createProject(file(card('c1', 'one'), rewrite('r1', 'Two.'), card('c2', 'three')));
  const detail = store.readProject(id)!;
  assert.deepEqual(detail.exercises.map(({ preview, kind }) => [preview, kind]), [['one', 'Flashcard'], ['Two.', 'Rewrite sentence'], ['three', 'Flashcard']]);
  assert.equal(detail.project.exercise_count, 3);
  assert.equal(detail.project.done_count, 0);
  assert.equal(detail.project.last_activity_at, null);
  assert.deepEqual(detail.project.type_counts, { flashcard: 2, rewrite: 1 });
  assert.equal(store.readProject(999), null);
});

test('adding exercises appends them; a key already in the project adds nothing', () => {
  const { store } = scratchStore();
  const id = store.createProject(file(card('c1', 'one')));
  assert.deepEqual(store.addExercises(id, [card('c2', 'two'), card('c3', 'three')]), { added: 2 });
  assert.deepEqual(store.addExercises(id, [card('c4', 'four'), card('c1', 'again')]), { duplicate_keys: ['c1'] });
  assert.deepEqual(store.readProject(id)!.exercises.map(({ preview }) => preview), ['one', 'two', 'three']);
  assert.equal(store.addExercises(999, [card('x', 'x')]), null);
  const other = store.createProject(file(card('c1', 'same key, other project')));
  assert.equal(store.readProject(other)!.exercises.length, 1);
});

test('History is the latest attempt of each exercise, newest first; done counts graded exercises', () => {
  const { store } = scratchStore();
  const id = store.createProject(file(card('c1', 'one'), card('c2', 'two'), card('c3', 'three')));
  const [first, second] = store.readProject(id)!.exercises;
  answer(store, first.id, { result: { rating: 'known' }, summary: 'Knew it' });
  answer(store, second.id, { result: { rating: 'almost' }, summary: 'Almost' });
  const retry = answer(store, first.id, { result: { rating: 'unknown' }, summary: "Didn't know" });
  const detail = store.readProject(id)!;
  assert.deepEqual(detail.history.map(({ preview, summary }) => [preview, summary]), [['one', "Didn't know"], ['two', 'Almost']]);
  assert.equal(detail.history[0].attempt_id, retry.id);
  assert.deepEqual(detail.exercises.map(({ done }) => done), [true, true, false]);
  assert.equal(detail.project.done_count, 2);
  assert.notEqual(detail.project.last_activity_at, null);
});

test('an AI attempt starts grading, is finished once, and a failed one can be restarted', () => {
  const { store } = scratchStore();
  const id = store.createProject(file(rewrite('r1', 'Text.')));
  const exercise_id = store.readProject(id)!.exercises[0].id;
  const attempt = answer(store, exercise_id, null, 'ai');
  assert.equal(attempt.status, 'grading');
  assert.equal(store.readProject(id)!.history[0].status, 'grading');
  assert.equal(store.readProject(id)!.project.done_count, 0);
  store.finishGrading(attempt.id, { status: 'failed', error: 'boom', model: null, grading_ms: 10 });
  assert.equal(store.readAttempt(attempt.id)!.error, 'boom');
  assert.equal(store.restartGrading(attempt.id), true);
  assert.equal(store.restartGrading(attempt.id), false);
  store.finishGrading(attempt.id, { status: 'graded', text: '**Good.** One verb to fix.', thinking_text: 'Looking.', thinking_ms: 1500, model: 'claude-sonnet-5-5', effort: 'high', grading_ms: 20 });
  store.finishGrading(attempt.id, { status: 'failed', error: 'late', model: null, grading_ms: 30 });
  const graded = store.readAttempt(attempt.id)!;
  assert.deepEqual([graded.status, graded.summary, graded.error], ['graded', 'Graded', null]);
  assert.deepEqual(graded.result, { text: '**Good.** One verb to fix.', thinking_text: 'Looking.', thinking_ms: 1500, model: 'claude-sonnet-5-5', effort: 'high', ms: 20 });
  assert.equal(store.readProject(id)!.project.done_count, 1);
  assert.equal(store.readAttempt(999), null);
});

test('a result written before the thinking summary and the effort were kept reads with empty ones', () => {
  const { store, database_path } = scratchStore();
  const id = store.createProject(file(rewrite('r1', 'Text.')));
  const exercise_id = store.readProject(id)!.exercises[0].id;
  const attempt = answer(store, exercise_id, null, 'ai');
  store.finishGrading(attempt.id, { status: 'graded', text: 'x', thinking_text: '', thinking_ms: null, model: 'm', effort: 'low', grading_ms: 1 });
  const database = new DatabaseSync(database_path);
  database.prepare('UPDATE attempts SET result_json = ? WHERE id = ?').run('{"text":"Old feedback.","model":"claude-sonnet-5-5","ms":8105}', attempt.id);
  database.close();
  assert.deepEqual(store.readAttempt(attempt.id)!.result, { text: 'Old feedback.', thinking_text: '', thinking_ms: null, effort: null, model: 'claude-sonnet-5-5', ms: 8105 });
});

test('an attempt keeps the exercise as it was and reads without touching exercises', () => {
  const { store, database_path } = scratchStore();
  const id = store.createProject(file(card('c1', 'before')));
  const exercise_id = store.readProject(id)!.exercises[0].id;
  const attempt = answer(store, exercise_id, { result: { rating: 'known' }, summary: 'Knew it' });
  const database = new DatabaseSync(database_path);
  database.prepare('UPDATE exercises SET content_json = ? WHERE id = ?').run('{"front":"after","back":"b"}', exercise_id);
  database.close();
  assert.equal((store.readAttempt(attempt.id)!.exercise.content as { front: string }).front, 'before');
  assert.deepEqual(store.readAttempt(attempt.id)!.answer, { rating: 'known' });
});

test('a row whose JSON has the wrong shape still lists, and a server restart fails interrupted gradings', () => {
  const { store, database_path } = scratchStore();
  const id = store.createProject(file(card('c1', 'one')));
  const exercise_id = store.readProject(id)!.exercises[0].id;
  new DatabaseSync(database_path).prepare("UPDATE exercises SET content_json = 'null' WHERE id = ?").run(exercise_id);
  assert.deepEqual(store.readProject(id)!.exercises.map(({ kind, preview }) => [kind, preview]), [['flashcard', '']]);
  const { store: other, database_path: other_path } = scratchStore();
  const other_id = other.createProject(file(rewrite('r', 'T.')));
  const attempt = answer(other, other.readProject(other_id)!.exercises[0].id, null, 'ai');
  assert.equal(openPracticeStore(other_path).failInterruptedGradings(), 1);
  assert.equal(other.readAttempt(attempt.id)!.status, 'failed');
});

// Schema 1 as it shipped, to test the migration on a file that looks like the real one.
const SCHEMA_1 = `
  CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80), description TEXT NOT NULL,
    created_at TEXT NOT NULL, last_activity_at TEXT) STRICT;
  CREATE TABLE exercises (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects (id), key TEXT NOT NULL,
    position INTEGER NOT NULL, type TEXT NOT NULL, topic TEXT, tags_json TEXT NOT NULL, content_json TEXT NOT NULL, UNIQUE (project_id, key)) STRICT;
  CREATE TABLE attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects (id),
    exercise_id INTEGER NOT NULL REFERENCES exercises (id), submitted_at TEXT NOT NULL, type TEXT NOT NULL, exercise_snapshot_json TEXT NOT NULL,
    answer_json TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT, summary TEXT, grader TEXT NOT NULL, model TEXT, grading_ms INTEGER,
    error TEXT, writing_ms INTEGER, graded_at TEXT) STRICT;
  CREATE INDEX attempts_by_exercise ON attempts (exercise_id, id);
  CREATE INDEX attempts_by_project ON attempts (project_id, id);
  PRAGMA user_version = 1;`;

function schema1File() {
  const directory = mkdtempSync(join(tmpdir(), 'practice-migrate-'));
  const database_path = join(directory, 'practice-v2.sqlite');
  const database = new DatabaseSync(database_path);
  database.exec(SCHEMA_1);
  const project = database.prepare('INSERT INTO projects (name, description, created_at, last_activity_at) VALUES (?, ?, ?, ?)');
  project.run('Test', '', '2026-10-18T15:38:46.581Z', '2026-10-18T16:24:42.538Z');
  project.run('Day 1 - 19/10/2026', '', '2026-10-19T13:39:35.305Z', '2026-10-19T13:42:01.965Z');
  project.run('Day 1 - 19/10/2026 - v2', 'Đề số 1', '2026-10-19T13:48:07.177Z', null);
  project.run('Test', '', '2026-10-19T14:00:00.000Z', null);
  const exercise = database.prepare('INSERT INTO exercises (project_id, key, position, type, topic, tags_json, content_json) VALUES (?, ?, ?, ?, ?, ?, ?)');
  exercise.run(1, 'r1', 1, 'rewrite', 'transport', '["passive"]', '{"instruction":"Fix","text":"It go.","length":"sentence"}');
  exercise.run(2, 'd1-card-1', 1, 'flashcard', null, '[]', '{"front":"cheap","back":"rẻ"}');
  exercise.run(2, 'd1-fix-1', 2, 'rewrite', null, '[]', '{"instruction":"Fix","text":"He go.","length":"sentence","prefill":true}');
  exercise.run(3, 'd1-card-1', 1, 'flashcard', null, '[]', '{"front":"cheap","back":"rẻ"}');
  const attempt = database.prepare(`INSERT INTO attempts (project_id, exercise_id, submitted_at, type, exercise_snapshot_json, answer_json, status, result_json,
    summary, grader, model, grading_ms, error, writing_ms, graded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const snapshot = (id: number) => JSON.stringify({ type: id === 2 ? 'flashcard' : 'rewrite', topic: null, tags: [], content: JSON.parse((database.prepare('SELECT content_json FROM exercises WHERE id = ?').get(id) as { content_json: string }).content_json) });
  attempt.run(1, 1, '2026-10-18T16:00:00.000Z', 'rewrite', snapshot(1), '{"text":"It goes."}', 'graded', '{"text":"Old feedback.","model":"claude-sonnet-5-5","ms":8105}', 'Graded', 'ai', 'claude-sonnet-5-5', 8105, null, 30000, '2026-10-18T16:00:09.000Z');
  attempt.run(1, 1, '2026-10-18T16:24:42.538Z', 'rewrite', snapshot(1), '{"text":"It went."}', 'graded', '{"text":"**Close.**","thinking_text":"","thinking_ms":null,"model":"claude-sonnet-5-5","effort":"high","ms":9000}', 'Graded', 'ai', 'claude-sonnet-5-5', 9000, null, 1000, '2026-10-18T16:24:52.000Z');
  attempt.run(2, 2, '2026-10-19T13:42:01.965Z', 'flashcard', snapshot(2), '{"rating":"known"}', 'graded', '{"rating":"known"}', 'Knew it', 'self', null, null, null, 900, '2026-10-19T13:42:01.965Z');
  attempt.run(2, 3, '2026-10-19T13:42:00.000Z', 'rewrite', snapshot(3), '{"text":"He goes."}', 'failed', null, null, 'ai', null, 5, 'The server stopped while grading.', 1, null);
  // A deleted attempt: the counter is ahead of the rows, as in a real file.
  attempt.run(2, 3, '2026-10-19T13:43:00.000Z', 'rewrite', snapshot(3), '{"text":"x"}', 'failed', null, null, 'ai', null, 5, 'x', 1, null);
  database.exec('DELETE FROM attempts WHERE id = 5');
  database.close();
  return { directory, database_path };
}

test('schema 1 is migrated to 2: a backup first, keys from names, versions, attempts still readable, ids and counters kept', () => {
  const { directory, database_path } = schema1File();
  const store = openPracticeStore(database_path);
  const backup = new DatabaseSync(join(directory, 'backups', 'practice-v2-before-schema-2.sqlite'), { readOnly: true });
  assert.equal((backup.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 1);
  assert.equal((backup.prepare('SELECT count(*) AS count FROM attempts').get() as { count: number }).count, 4);
  backup.close();
  const database = new DatabaseSync(database_path, { readOnly: true });
  assert.equal((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 2);
  assert.deepEqual(database.prepare('SELECT id, key, name, description, archived_at, updated_at = created_at AS same FROM projects ORDER BY id').all().map((row) => ({ ...row })), [
    { id: 1, key: 'test', name: 'Test', description: '', archived_at: null, same: 1 },
    { id: 2, key: 'day-1-19-10-2026', name: 'Day 1 - 19/10/2026', description: '', archived_at: null, same: 1 },
    { id: 3, key: 'day-1-19-10-2026-v2', name: 'Day 1 - 19/10/2026 - v2', description: 'Đề số 1', archived_at: null, same: 1 },
    { id: 4, key: 'test-4', name: 'Test', description: '', archived_at: null, same: 1 },
  ]);
  assert.deepEqual(database.prepare('SELECT id, key, version, created_at FROM exercises WHERE project_id = 2 ORDER BY position').all().map((row) => ({ ...row })), [
    { id: 2, key: 'd1-card-1', version: 1, created_at: '2026-10-19T13:39:35.305Z' },
    { id: 3, key: 'd1-fix-1', version: 1, created_at: '2026-10-19T13:39:35.305Z' },
  ]);
  assert.deepEqual(database.prepare('SELECT id, exercise_id, exercise_key, exercise_version, effort FROM attempts ORDER BY id').all().map((row) => ({ ...row })), [
    { id: 1, exercise_id: 1, exercise_key: 'r1', exercise_version: 1, effort: null },
    { id: 2, exercise_id: 1, exercise_key: 'r1', exercise_version: 1, effort: 'high' },
    { id: 3, exercise_id: 2, exercise_key: 'd1-card-1', exercise_version: 1, effort: null },
    { id: 4, exercise_id: 3, exercise_key: 'd1-fix-1', exercise_version: 1, effort: null },
  ]);
  assert.deepEqual(database.prepare('PRAGMA foreign_key_list(attempts)').all().map((row: any) => [row.table, row.on_delete]).sort(), [['exercises', 'SET NULL'], ['projects', 'CASCADE']]);
  assert.deepEqual(database.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%_v1'").all(), []);
  database.close();
  // Every old attempt reads as it did, and the lists still work.
  assert.equal(store.readAttempt(1)!.result!.hasOwnProperty('text'), true);
  assert.deepEqual(store.readAttempt(3)!.answer, { rating: 'known' });
  assert.equal(store.readAttempt(4)!.status, 'failed');
  assert.deepEqual(store.listProjects().map(({ exercise_count, done_count }) => [exercise_count, done_count]), [[1, 1], [2, 1], [1, 0], [0, 0]]);
  // A deleted attempt's id is not given again.
  const exercise = store.readExercise(2)!;
  assert.equal(store.createAttempt({ exercise, answer: { rating: 'almost' }, writing_ms: 1, grader: 'self', outcome: { result: { rating: 'almost' }, summary: 'Almost' } }).id, 6);
  // Opening it again changes nothing and makes no second backup.
  assert.equal(openPracticeStore(database_path).listProjects().length, 4);
});

test('a migration that would lose a row changes nothing', () => {
  const { database_path } = schema1File();
  const database = new DatabaseSync(database_path);
  database.exec('PRAGMA foreign_keys = OFF; DELETE FROM exercises WHERE id = 1');
  database.close();
  assert.throws(() => openPracticeStore(database_path), /would lose rows/);
  const after = new DatabaseSync(database_path, { readOnly: true });
  assert.equal((after.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 1);
  assert.equal((after.prepare('SELECT count(*) AS count FROM attempts').get() as { count: number }).count, 4);
  after.close();
});

test('a key made from a name', () => {
  const free = () => false;
  assert.equal(keyFromName('Day 1 - 19/10/2026', 2, free), 'day-1-19-10-2026');
  assert.equal(keyFromName('Đề số một: Nhiệm vụ 2', 9, free), 'de-so-mot-nhiem-vu-2');
  assert.equal(keyFromName('Test', 4, (key) => key === 'test'), 'test-4');
  assert.equal(keyFromName('!!!', 7, free), 'project-7');
  assert.equal(keyFromName('x'.repeat(70), 12, (key) => key === 'x'.repeat(64)), `${'x'.repeat(61)}-12`);
});
