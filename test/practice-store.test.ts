// The practice database (features/practice/server/store.ts) on a scratch file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FileExercise, ProjectFile } from '../features/practice/api.ts';
import { keyFromName, openPracticeStore, type PracticeStore } from '../features/practice/server/store.ts';

const card = (key: string, front: string): FileExercise => ({ key, type: 'flashcard', topic: null, tags: [], content: { front, back: 'b' } });
const rewrite = (key: string, text: string): FileExercise => ({ key, type: 'rewrite', topic: 'topic', tags: [], content: { instruction: 'Fix', text, length: 'sentence' } });
const file = (...exercises: FileExercise[]): ProjectFile => ({ key: 'week-1', name: 'Week 1', description: '', exercises });
const body = ({ key: _key, ...exercise }: FileExercise) => exercise;

function scratchStore() {
  const database_path = join(mkdtempSync(join(tmpdir(), 'practice-store-')), 'practice-v2.sqlite');
  return { store: openPracticeStore(database_path), database_path };
}

const idOf = (store: PracticeStore, key: string, project = 'week-1') => store.readExercise(project, key)!.id;

function answer(store: PracticeStore, exercise_id: number, outcome: object | null, grader: 'ai' | 'self' = 'self', type = 'flashcard') {
  const text = type === 'flashcard' ? { rating: 'known' } : { text: 'My answer.' };
  return store.createAttempt({ exercise_id, answer: text as never, writing_ms: 1500, grader, outcome: outcome as never });
}
const knew = { result: { rating: 'known' }, summary: 'Knew it' };

test('an import makes a project with its exercises in file order, counted by type', () => {
  const { store } = scratchStore();
  const result = store.importFile(file(card('c1', 'one'), rewrite('r1', 'Two.'), card('c2', 'three')), false);
  assert.deepEqual([result.dry_run, result.project_change, result.exercises], [false, 'created', { created: ['c1', 'r1', 'c2'], updated: [], unchanged: [] }]);
  const items = store.listExercises('week-1', { type: null, tag: null })!;
  assert.deepEqual(items.map(({ key, preview, kind, version, last_attempt }) => [key, preview, kind, version, last_attempt]), [
    ['c1', 'one', 'Flashcard', 1, null], ['r1', 'Two.', 'Rewrite sentence', 1, null], ['c2', 'three', 'Flashcard', 1, null],
  ]);
  const project = store.readProject('week-1')!;
  assert.deepEqual([project.key, project.name, project.exercise_count, project.done_count, project.last_activity_at, project.archived], ['week-1', 'Week 1', 3, 0, null, false]);
  assert.deepEqual(project.type_counts, { flashcard: 2, rewrite: 1 });
  assert.equal(store.readProject('nope'), null);
  assert.equal(store.listExercises('nope', { type: null, tag: null }), null);
});

test('importing the same file again changes nothing; changed content bumps the version; the file sets the order', () => {
  const { store } = scratchStore();
  store.importFile(file(card('c1', 'one'), card('c2', 'two'), card('c3', 'three')), false);
  const before = store.readExercise('week-1', 'c1')!;
  const again = store.importFile(file(card('c1', 'one'), card('c2', 'two'), card('c3', 'three')), false);
  assert.deepEqual([again.project_change, again.exercises], ['unchanged', { created: [], updated: [], unchanged: ['c1', 'c2', 'c3'] }]);
  assert.deepEqual(store.readExercise('week-1', 'c1'), before);
  // The same content with its keys in another order is the same.
  const reordered: FileExercise = { key: 'c1', type: 'flashcard', topic: null, tags: [], content: { back: 'b', front: 'one' } as never };
  assert.deepEqual(store.importFile({ ...file(reordered), name: 'Week 1 (fixed)' }, false).exercises, { created: [], updated: [], unchanged: ['c1'] });
  // A fixed file: one changed, one new, one left out (kept, after the file's).
  const fixed = store.importFile({ ...file(card('c3', 'three'), card('c1', 'one!'), card('c4', 'four')), name: 'Week 1 (fixed)' }, false);
  assert.deepEqual([fixed.project_change, fixed.exercises], ['unchanged', { created: ['c4'], updated: ['c1'], unchanged: ['c3'] }]);
  assert.deepEqual(store.listExercises('week-1', { type: null, tag: null })!.map(({ key, version }) => [key, version]), [['c3', 1], ['c1', 2], ['c4', 1], ['c2', 1]]);
  const c1 = store.readExercise('week-1', 'c1')!;
  assert.deepEqual([c1.version, c1.created_at, c1.updated_at > before.updated_at || c1.updated_at === before.updated_at], [2, before.created_at, true]);
  assert.equal(store.readProject('week-1')!.name, 'Week 1 (fixed)');
});

test('a dry run says what would happen and writes nothing', () => {
  const { store, database_path } = scratchStore();
  const result = store.importFile(file(card('c1', 'one')), true);
  assert.deepEqual([result.dry_run, result.project_change, result.project.exercise_count, result.exercises.created], [true, 'created', 1, ['c1']]);
  assert.equal(store.readProject('week-1'), null);
  store.importFile(file(card('c1', 'one')), false);
  const dump = () => new DatabaseSync(database_path, { readOnly: true }).prepare('SELECT * FROM exercises').all();
  const rows = dump();
  assert.equal(store.putExercise('week-1', 'c1', body(card('c1', 'changed')), true)!.exercise.version, 2);
  assert.equal(store.putExercise('week-1', 'c9', body(card('c9', 'new')), true)!.change, 'created');
  assert.equal(store.putProject('week-1', { name: 'Other', description: '', archived: true }, true).project.archived, true);
  assert.deepEqual(dump(), rows);
  assert.equal(store.readProject('week-1')!.name, 'Week 1');
});

test('PUT an exercise: created at the end, then updated with a new version, then unchanged; the project must exist', () => {
  const { store } = scratchStore();
  store.importFile(file(card('c1', 'one')), false);
  const created = store.putExercise('week-1', 'r1', body(rewrite('r1', 'Text.')), false)!;
  assert.deepEqual([created.change, created.exercise.position, created.exercise.version, created.exercise.project], ['created', 2, 1, 'week-1']);
  const as_card = store.putExercise('week-1', 'r1', body(card('r1', 'now a card')), false)!;
  assert.deepEqual([as_card.change, as_card.exercise.type, as_card.exercise.version], ['updated', 'flashcard', 2]);
  assert.equal(store.putExercise('week-1', 'r1', body(card('r1', 'now a card')), false)!.change, 'unchanged');
  assert.equal(store.putExercise('nope', 'r1', body(card('r1', 'x')), false), null);
});

test('deleting an exercise keeps its attempts readable, with its key; done stops counting it', () => {
  const { store } = scratchStore();
  store.importFile(file(card('c1', 'one'), card('c2', 'two')), false);
  const attempt = answer(store, idOf(store, 'c1'), knew);
  assert.deepEqual([attempt.project, attempt.exercise, attempt.exercise_version, attempt.exercise_deleted], ['week-1', 'c1', 1, false]);
  assert.equal(store.readProject('week-1')!.done_count, 1);
  assert.equal(store.deleteExercise('week-1', 'c1'), true);
  assert.equal(store.deleteExercise('week-1', 'c1'), false);
  const kept = store.readAttempt(attempt.id)!;
  assert.deepEqual([kept.exercise, kept.exercise_deleted, (kept.snapshot.content as { front: string }).front, kept.answer], ['c1', true, 'one', { rating: 'known' }]);
  assert.deepEqual(store.listAttempts({ project: 'week-1', exercise: 'c1', status: null, since: null, before: null, limit: 50 }).items.map(({ id }) => id), [attempt.id]);
  assert.deepEqual([store.readProject('week-1')!.done_count, store.readProject('week-1')!.exercise_count], [0, 1]);
  // The same key made again is a new exercise, version 1; the old attempt stays with the old one.
  store.putExercise('week-1', 'c1', body(card('c1', 'again')), false);
  assert.deepEqual([store.readExercise('week-1', 'c1')!.version, store.readExercise('week-1', 'c1')!.attempt_count], [1, 0]);
});

test('a project with attempts is deleted only when asked to delete them too; archive hides it', () => {
  const { store } = scratchStore();
  store.importFile(file(card('c1', 'one')), false);
  store.importFile({ ...file(card('c1', 'one')), key: 'empty' }, false);
  answer(store, idOf(store, 'c1'), knew);
  assert.equal(store.deleteProject('week-1', false), 'has_attempts');
  assert.equal(store.deleteProject('empty', false), 'deleted');
  assert.equal(store.deleteProject('empty', false), 'not_found');
  const archived = store.putProject('week-1', { name: 'Week 1', description: '', archived: true }, false);
  assert.deepEqual([archived.change, archived.project.archived], ['updated', true]);
  assert.deepEqual([store.listProjects('false'), store.listProjects('true').map(({ key }) => key)], [[], ['week-1']]);
  // Importing into an archived project works and keeps it archived.
  assert.equal(store.importFile(file(card('c1', 'one'), card('c2', 'two')), false).project.archived, true);
  assert.equal(store.deleteProject('week-1', true), 'deleted');
  assert.deepEqual([store.listProjects('all'), store.listAttempts({ project: null, exercise: null, status: null, since: null, before: null, limit: 50 }).items], [[], []]);
});

test('export is the file again: importing it changes nothing', () => {
  const { store } = scratchStore();
  const tagged: FileExercise = { ...rewrite('r1', 'Text.'), tags: ['passive'] };
  store.importFile({ ...file(card('c1', 'one'), tagged), description: 'Mine' }, false);
  const exported = store.exportProject('week-1')!;
  assert.deepEqual(exported, {
    format: 3, project: { key: 'week-1', name: 'Week 1', description: 'Mine' },
    exercises: [{ key: 'c1', type: 'flashcard', content: { front: 'one', back: 'b' } }, { key: 'r1', type: 'rewrite', topic: 'topic', tags: ['passive'], content: { instruction: 'Fix', text: 'Text.', length: 'sentence' } }],
  });
  const again = store.importFile({ key: 'week-1', name: 'Week 1', description: 'Mine', exercises: [{ ...card('c1', 'one') }, tagged] }, false);
  assert.deepEqual([again.project_change, again.exercises.unchanged], ['unchanged', ['c1', 'r1']]);
  assert.equal(store.exportProject('nope'), null);
});

test('attempts list newest first with filters and pages; an attempt records the version it answered', () => {
  const { store } = scratchStore();
  store.importFile(file(card('c1', 'one'), rewrite('r1', 'Text.')), false);
  const ids = [answer(store, idOf(store, 'c1'), knew).id, answer(store, idOf(store, 'r1'), null, 'ai', 'rewrite').id, answer(store, idOf(store, 'c1'), knew).id];
  store.putExercise('week-1', 'c1', body(card('c1', 'one, fixed')), false);
  const fourth = answer(store, idOf(store, 'c1'), knew);
  assert.equal(fourth.exercise_version, 2);
  const list = (filter: object) => store.listAttempts({ project: null, exercise: null, status: null, since: null, before: null, limit: 50, ...filter });
  assert.deepEqual(list({}).items.map(({ id }) => id), [fourth.id, ...ids.reverse()]);
  assert.deepEqual(list({ status: 'grading' }).items.map(({ exercise }) => exercise), ['r1']);
  assert.deepEqual(list({ project: 'week-1', exercise: 'c1' }).items.map(({ exercise_version }) => exercise_version), [2, 1, 1]);
  const first_page = list({ limit: 2 });
  assert.deepEqual([first_page.items.length, first_page.next_before], [2, first_page.items[1].id]);
  const second_page = list({ limit: 2, before: first_page.next_before });
  assert.deepEqual([second_page.items.length, second_page.next_before], [2, undefined]);
  assert.deepEqual(list({ since: '2999-01-01T00:00:00.000Z' }).items, []);
  assert.equal(store.deleteAttempt(ids[1]), 'grading');
  assert.equal(store.deleteAttempt(fourth.id), 'deleted');
  assert.equal(store.deleteAttempt(fourth.id), 'not_found');
});

test('an AI attempt starts grading, is finished once, and a failed one can be restarted; the effort is kept', () => {
  const { store, database_path } = scratchStore();
  store.importFile(file(rewrite('r1', 'Text.')), false);
  const attempt = answer(store, idOf(store, 'r1'), null, 'ai', 'rewrite');
  assert.equal(attempt.status, 'grading');
  assert.equal(store.listExercises('week-1', { type: null, tag: null })![0].last_attempt!.status, 'grading');
  assert.equal(store.readProject('week-1')!.done_count, 0);
  store.finishGrading(attempt.id, { status: 'failed', error: 'boom', model: null, grading_ms: 10 });
  assert.equal(store.readAttempt(attempt.id)!.error, 'boom');
  assert.equal(store.restartGrading(attempt.id), true);
  assert.equal(store.restartGrading(attempt.id), false);
  store.finishGrading(attempt.id, { status: 'graded', text: '**Good.** One verb to fix.', thinking_text: 'Looking.', thinking_ms: 1500, model: 'claude-sonnet-5-5', effort: 'high', grading_ms: 20 });
  store.finishGrading(attempt.id, { status: 'failed', error: 'late', model: null, grading_ms: 30 });
  const graded = store.readAttempt(attempt.id)!;
  assert.deepEqual([graded.status, graded.summary, graded.error], ['graded', 'Graded', null]);
  assert.deepEqual(graded.result, { text: '**Good.** One verb to fix.', thinking_text: 'Looking.', thinking_ms: 1500, model: 'claude-sonnet-5-5', effort: 'high', ms: 20 });
  assert.equal(store.readProject('week-1')!.done_count, 1);
  assert.equal(store.readAttempt(999), null);
  const database = new DatabaseSync(database_path, { readOnly: true });
  assert.deepEqual({ ...database.prepare('SELECT effort, model FROM attempts WHERE id = ?').get(attempt.id) }, { effort: 'high', model: 'claude-sonnet-5-5' });
  database.close();
});

test('a result written before the thinking summary and the effort were kept reads with empty ones', () => {
  const { store, database_path } = scratchStore();
  store.importFile(file(rewrite('r1', 'Text.')), false);
  const attempt = answer(store, idOf(store, 'r1'), null, 'ai', 'rewrite');
  store.finishGrading(attempt.id, { status: 'graded', text: 'x', thinking_text: '', thinking_ms: null, model: 'm', effort: 'low', grading_ms: 1 });
  const database = new DatabaseSync(database_path);
  database.prepare('UPDATE attempts SET result_json = ? WHERE id = ?').run('{"text":"Old feedback.","model":"claude-sonnet-5-5","ms":8105}', attempt.id);
  database.close();
  assert.deepEqual(store.readAttempt(attempt.id)!.result, { text: 'Old feedback.', thinking_text: '', thinking_ms: null, effort: null, model: 'claude-sonnet-5-5', ms: 8105 });
});

test('an attempt keeps the exercise as it was, whatever happens to the exercise later', () => {
  const { store } = scratchStore();
  store.importFile(file(card('c1', 'before')), false);
  const attempt = answer(store, idOf(store, 'c1'), knew);
  store.putExercise('week-1', 'c1', body(card('c1', 'after')), false);
  assert.equal((store.readAttempt(attempt.id)!.snapshot.content as { front: string }).front, 'before');
  assert.deepEqual(store.readAttempt(attempt.id)!.answer, { rating: 'known' });
});

test('a row whose JSON has the wrong shape still lists, filters work, and a server restart fails interrupted gradings', () => {
  const { store, database_path } = scratchStore();
  store.importFile(file(card('c1', 'one'), { ...rewrite('r1', 'T.'), tags: ['passive'] }), false);
  new DatabaseSync(database_path).prepare("UPDATE exercises SET content_json = 'null' WHERE key = 'c1'").run();
  assert.deepEqual(store.listExercises('week-1', { type: null, tag: null })!.map(({ kind, preview }) => [kind, preview]), [['flashcard', ''], ['Rewrite sentence', 'T.']]);
  assert.deepEqual(store.listExercises('week-1', { type: 'rewrite', tag: null })!.map(({ key }) => key), ['r1']);
  assert.deepEqual(store.listExercises('week-1', { type: null, tag: 'passive' })!.map(({ key }) => key), ['r1']);
  assert.deepEqual(store.listExercises('week-1', { type: null, tag: 'nope' }), []);
  const attempt = answer(store, idOf(store, 'r1'), null, 'ai', 'rewrite');
  assert.equal(openPracticeStore(database_path).failInterruptedGradings(), 1);
  assert.equal(store.readAttempt(attempt.id)!.status, 'failed');
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
  assert.deepEqual([store.readAttempt(3)!.project, store.readAttempt(3)!.exercise, store.readAttempt(3)!.answer], ['day-1-19-10-2026', 'd1-card-1', { rating: 'known' }]);
  assert.equal(store.readAttempt(4)!.status, 'failed');
  assert.deepEqual(store.listProjects('all').map(({ key, exercise_count, done_count }) => [key, exercise_count, done_count]), [
    ['test-4', 0, 0], ['day-1-19-10-2026-v2', 1, 0], ['day-1-19-10-2026', 2, 1], ['test', 1, 1],
  ]);
  assert.deepEqual(store.listExercises('day-1-19-10-2026', { type: null, tag: null })!.map(({ key, last_attempt }) => [key, last_attempt?.id ?? null]), [['d1-card-1', 3], ['d1-fix-1', 4]]);
  // A deleted attempt's id is not given again.
  assert.equal(store.createAttempt({ exercise_id: 2, answer: { rating: 'almost' }, writing_ms: 1, grader: 'self', outcome: { result: { rating: 'almost' }, summary: 'Almost' } }).id, 6);
  // Opening it again changes nothing and makes no second backup.
  assert.equal(openPracticeStore(database_path).listProjects('all').length, 4);
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
