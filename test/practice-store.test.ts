// The practice database (features/practice/server/store.ts) on a scratch file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ExerciseBody, FileExercise, ProjectFile } from '../features/practice/api.ts';
import { openPracticeStore, type AttemptFilter, type PracticeStore } from '../features/practice/server/store.ts';
import { keyFromName } from '../features/practice/server/store-schema.ts';

// ---- Helpers ----

function card(key: string, front: string): FileExercise {
  return { key, type: 'flashcard', topic: null, tags: [], content: { front, back: 'b' } };
}

function rewrite(key: string, text: string): FileExercise {
  return { key, type: 'rewrite', topic: 'topic', tags: [], content: { instruction: 'Fix', text, length: 'sentence' } };
}

// A file for the project "week-1".
function file(...exercises: FileExercise[]): ProjectFile {
  return { key: 'week-1', name: 'Week 1', description: '', exercises };
}

// An exercise without its key, as PUT takes it.
function bodyOf(exercise: FileExercise): ExerciseBody {
  const { key: _key, ...body } = exercise;
  return body;
}

function scratchStore() {
  const database_path = join(mkdtempSync(join(tmpdir(), 'practice-store-')), 'practice-v2.sqlite');
  return { store: openPracticeStore(database_path), database_path };
}

function exerciseId(store: PracticeStore, key: string): number {
  return store.readExercise('week-1', key)!.id;
}

function keysOf(items: { key: string }[]): string[] {
  return items.map((item) => item.key);
}

function listAll(store: PracticeStore) {
  return store.listExercises('week-1', { type: null, tag: null })!;
}

// Every attempt, newest first, with some filters set.
function listAttempts(store: PracticeStore, filter: Partial<AttemptFilter> = {}) {
  return store.listAttempts({ project: null, exercise: null, status: null, since: null, before: null, limit: 50, ...filter });
}

// A flashcard rated "known": graded at once.
function rateCard(store: PracticeStore, key: string) {
  return store.createAttempt({
    exercise_id: exerciseId(store, key), answer: { rating: 'known' }, writing_ms: 1500, grader: 'self',
    outcome: { result: { rating: 'known' }, summary: 'Knew it' },
  });
}

// A rewrite answer the AI will grade: it starts in status 'grading'.
function answerRewrite(store: PracticeStore, key: string) {
  return store.createAttempt({ exercise_id: exerciseId(store, key), answer: { text: 'My answer.' }, writing_ms: 1500, grader: 'ai', outcome: null });
}

// ---- Import ----

test('an import makes a project with its exercises in file order', () => {
  const { store } = scratchStore();
  const result = store.importFile(file(card('c1', 'one'), rewrite('r1', 'Two.'), card('c2', 'three')), false);
  assert.equal(result.dry_run, false);
  assert.equal(result.project_change, 'created');
  assert.deepEqual(result.exercises.created, ['c1', 'r1', 'c2']);

  const items = listAll(store);
  assert.deepEqual(keysOf(items), ['c1', 'r1', 'c2']);
  assert.equal(items[1].preview, 'Two.');
  assert.equal(items[1].kind, 'Rewrite sentence');
  assert.equal(items[1].version, 1);
  assert.equal(items[1].last_attempt, null);
});

test('a project counts its exercises by type', () => {
  const { store } = scratchStore();
  store.importFile(file(card('c1', 'one'), rewrite('r1', 'Two.'), card('c2', 'three')), false);
  const project = store.readProject('week-1')!;
  assert.equal(project.key, 'week-1');
  assert.equal(project.name, 'Week 1');
  assert.equal(project.exercise_count, 3);
  assert.equal(project.done_count, 0);
  assert.equal(project.last_activity_at, null);
  assert.equal(project.archived, false);
  assert.deepEqual(project.type_counts, { flashcard: 2, rewrite: 1 });
});

test('an unknown project reads as null', () => {
  const { store } = scratchStore();
  assert.equal(store.readProject('nope'), null);
  assert.equal(store.listExercises('nope', { type: null, tag: null }), null);
  assert.equal(store.exportProject('nope'), null);
});

test('importing the same file again changes nothing', () => {
  const { store } = scratchStore();
  store.importFile(file(card('c1', 'one'), card('c2', 'two')), false);
  const before = store.readExercise('week-1', 'c1');

  const again = store.importFile(file(card('c1', 'one'), card('c2', 'two')), false);
  assert.equal(again.project_change, 'unchanged');
  assert.deepEqual(again.exercises.unchanged, ['c1', 'c2']);
  assert.deepEqual(store.readExercise('week-1', 'c1'), before);
});

test('the same content with its fields in another order is not a change', () => {
  const { store } = scratchStore();
  store.importFile(file(card('c1', 'one')), false);
  const reordered: FileExercise = { key: 'c1', type: 'flashcard', topic: null, tags: [], content: { back: 'b', front: 'one' } };
  const again = store.importFile(file(reordered), false);
  assert.deepEqual(again.exercises.unchanged, ['c1']);
});

test('a fixed file: a changed exercise gets version 2, a new one is added, and one left out is kept', () => {
  const { store } = scratchStore();
  store.importFile(file(card('c1', 'one'), card('c2', 'two'), card('c3', 'three')), false);

  const fixed = store.importFile(file(card('c3', 'three'), card('c1', 'one!'), card('c4', 'four')), false);
  assert.deepEqual(fixed.exercises, { created: ['c4'], updated: ['c1'], unchanged: ['c3'] });
  assert.equal(store.readExercise('week-1', 'c1')!.version, 2);
  assert.equal(store.readExercise('week-1', 'c3')!.version, 1);
  // The file's order first; c2, not in the file, after them.
  assert.deepEqual(keysOf(listAll(store)), ['c3', 'c1', 'c4', 'c2']);
});

test('a new project name in the file updates the project', () => {
  const { store } = scratchStore();
  store.importFile(file(card('c1', 'one')), false);
  const renamed = store.importFile({ ...file(card('c1', 'one')), name: 'Week 1 (fixed)' }, false);
  assert.equal(renamed.project_change, 'updated');
  assert.equal(store.readProject('week-1')!.name, 'Week 1 (fixed)');
});

test('a dry run says what would happen and writes nothing', () => {
  const { store, database_path } = scratchStore();
  const dry = store.importFile(file(card('c1', 'one')), true);
  assert.equal(dry.dry_run, true);
  assert.equal(dry.project_change, 'created');
  assert.equal(dry.project.exercise_count, 1);
  assert.equal(store.readProject('week-1'), null);

  store.importFile(file(card('c1', 'one')), false);
  const readRows = () => new DatabaseSync(database_path, { readOnly: true }).prepare('SELECT * FROM exercises').all();
  const rows_before = readRows();
  assert.equal(store.putExercise('week-1', 'c1', bodyOf(card('c1', 'changed')), true)!.exercise.version, 2);
  assert.equal(store.putExercise('week-1', 'c9', bodyOf(card('c9', 'new')), true)!.change, 'created');
  assert.equal(store.putProject('week-1', { name: 'Other', description: '', archived: true }, true).project.archived, true);
  assert.deepEqual(readRows(), rows_before);
  assert.equal(store.readProject('week-1')!.name, 'Week 1');
});

// ---- Exercises ----

test('PUT an exercise: created at the end, then updated with a new version, then unchanged', () => {
  const { store } = scratchStore();
  store.importFile(file(card('c1', 'one')), false);

  const created = store.putExercise('week-1', 'r1', bodyOf(rewrite('r1', 'Text.')), false)!;
  assert.equal(created.change, 'created');
  assert.equal(created.exercise.position, 2);
  assert.equal(created.exercise.version, 1);

  // The type may change too.
  const updated = store.putExercise('week-1', 'r1', bodyOf(card('r1', 'now a card')), false)!;
  assert.equal(updated.change, 'updated');
  assert.equal(updated.exercise.type, 'flashcard');
  assert.equal(updated.exercise.version, 2);

  const same = store.putExercise('week-1', 'r1', bodyOf(card('r1', 'now a card')), false)!;
  assert.equal(same.change, 'unchanged');
  assert.equal(same.exercise.version, 2);
});

test('PUT an exercise into an unknown project does nothing', () => {
  const { store } = scratchStore();
  assert.equal(store.putExercise('nope', 'r1', bodyOf(card('r1', 'x')), false), null);
});

test('deleting an exercise keeps its attempts readable, with its key', () => {
  const { store } = scratchStore();
  store.importFile(file(card('c1', 'one'), card('c2', 'two')), false);
  const attempt = rateCard(store, 'c1');
  assert.equal(attempt.exercise_deleted, false);

  assert.equal(store.deleteExercise('week-1', 'c1'), true);
  assert.equal(store.deleteExercise('week-1', 'c1'), false);

  const kept = store.readAttempt(attempt.id)!;
  assert.equal(kept.exercise, 'c1');
  assert.equal(kept.exercise_deleted, true);
  assert.deepEqual(kept.snapshot.content, { front: 'one', back: 'b' });
  assert.deepEqual(kept.answer, { rating: 'known' });

  const listed = listAttempts(store, { project: 'week-1', exercise: 'c1' });
  assert.equal(listed.items.length, 1);
});

test('a deleted exercise no longer counts as done, and its key can be used again', () => {
  const { store } = scratchStore();
  store.importFile(file(card('c1', 'one')), false);
  rateCard(store, 'c1');
  assert.equal(store.readProject('week-1')!.done_count, 1);

  store.deleteExercise('week-1', 'c1');
  assert.equal(store.readProject('week-1')!.done_count, 0);

  store.putExercise('week-1', 'c1', bodyOf(card('c1', 'again')), false);
  const remade = store.readExercise('week-1', 'c1')!;
  assert.equal(remade.version, 1);
  assert.equal(remade.attempt_count, 0);
});

test('the exercise list filters by type and tag, and a row with broken JSON still lists', () => {
  const { store, database_path } = scratchStore();
  store.importFile(file(card('c1', 'one'), { ...rewrite('r1', 'T.'), tags: ['passive'] }), false);
  new DatabaseSync(database_path).prepare("UPDATE exercises SET content_json = 'null' WHERE key = 'c1'").run();

  const items = listAll(store);
  assert.equal(items[0].kind, 'flashcard');
  assert.equal(items[0].preview, '');

  assert.deepEqual(keysOf(store.listExercises('week-1', { type: 'rewrite', tag: null })!), ['r1']);
  assert.deepEqual(keysOf(store.listExercises('week-1', { type: null, tag: 'passive' })!), ['r1']);
  assert.deepEqual(store.listExercises('week-1', { type: null, tag: 'nope' }), []);
});

// ---- Projects ----

test('a project with attempts is deleted only when its attempts are deleted too', () => {
  const { store } = scratchStore();
  store.importFile(file(card('c1', 'one')), false);
  rateCard(store, 'c1');

  assert.equal(store.deleteProject('week-1', false), 'has_attempts');
  assert.notEqual(store.readProject('week-1'), null);

  assert.equal(store.deleteProject('week-1', true), 'deleted');
  assert.equal(store.readProject('week-1'), null);
  assert.equal(listAttempts(store).items.length, 0);
  assert.equal(store.deleteProject('week-1', true), 'not_found');
});

test('a project without attempts is deleted at once', () => {
  const { store } = scratchStore();
  store.importFile(file(card('c1', 'one')), false);
  assert.equal(store.deleteProject('week-1', false), 'deleted');
});

test('archive hides a project from the default list; an import keeps it archived', () => {
  const { store } = scratchStore();
  store.importFile(file(card('c1', 'one')), false);

  const archived = store.putProject('week-1', { name: 'Week 1', description: '', archived: true }, false);
  assert.equal(archived.change, 'updated');
  assert.equal(archived.project.archived, true);
  assert.equal(store.listProjects('false').length, 0);
  assert.deepEqual(keysOf(store.listProjects('true')), ['week-1']);

  const imported = store.importFile(file(card('c1', 'one'), card('c2', 'two')), false);
  assert.equal(imported.project.archived, true);
});

test('export is the file again, and importing it changes nothing', () => {
  const { store } = scratchStore();
  const tagged: FileExercise = { ...rewrite('r1', 'Text.'), tags: ['passive'] };
  store.importFile({ ...file(card('c1', 'one'), tagged), description: 'Mine' }, false);

  const exported = store.exportProject('week-1')!;
  assert.deepEqual(exported.project, { key: 'week-1', name: 'Week 1', description: 'Mine' });
  // No topic and no tags: left out, as a person would write it.
  assert.deepEqual(exported.exercises[0], { key: 'c1', type: 'flashcard', content: { front: 'one', back: 'b' } });
  assert.deepEqual(exported.exercises[1].tags, ['passive']);

  const again = store.importFile({ key: 'week-1', name: 'Week 1', description: 'Mine', exercises: [card('c1', 'one'), tagged] }, false);
  assert.equal(again.project_change, 'unchanged');
  assert.deepEqual(again.exercises.unchanged, ['c1', 'r1']);
});

// ---- Attempts ----

test('an attempt records the version of the exercise it answered', () => {
  const { store } = scratchStore();
  store.importFile(file(card('c1', 'one')), false);
  assert.equal(rateCard(store, 'c1').exercise_version, 1);

  store.putExercise('week-1', 'c1', bodyOf(card('c1', 'one, fixed')), false);
  assert.equal(rateCard(store, 'c1').exercise_version, 2);
});

test('an attempt keeps the exercise as it was, whatever happens to the exercise later', () => {
  const { store } = scratchStore();
  store.importFile(file(card('c1', 'before')), false);
  const attempt = rateCard(store, 'c1');
  store.putExercise('week-1', 'c1', bodyOf(card('c1', 'after')), false);
  assert.deepEqual(store.readAttempt(attempt.id)!.snapshot.content, { front: 'before', back: 'b' });
});

test('the attempts list is newest first, filters, and pages with before', () => {
  const { store } = scratchStore();
  store.importFile(file(card('c1', 'one'), rewrite('r1', 'Text.')), false);
  const first = rateCard(store, 'c1');
  const second = answerRewrite(store, 'r1');
  const third = rateCard(store, 'c1');

  assert.deepEqual(listAttempts(store).items.map((attempt) => attempt.id), [third.id, second.id, first.id]);
  assert.deepEqual(listAttempts(store, { status: 'grading' }).items.map((attempt) => attempt.id), [second.id]);
  assert.deepEqual(listAttempts(store, { project: 'week-1', exercise: 'c1' }).items.map((attempt) => attempt.id), [third.id, first.id]);
  assert.equal(listAttempts(store, { since: '2999-01-01T00:00:00.000Z' }).items.length, 0);

  const page_1 = listAttempts(store, { limit: 2 });
  assert.equal(page_1.items.length, 2);
  assert.equal(page_1.next_before, second.id);
  const page_2 = listAttempts(store, { limit: 2, before: page_1.next_before });
  assert.equal(page_2.items.length, 1);
  assert.equal(page_2.next_before, undefined);
});

test('an attempt being graded cannot be deleted; a graded one can, once', () => {
  const { store } = scratchStore();
  store.importFile(file(card('c1', 'one'), rewrite('r1', 'Text.')), false);
  const grading = answerRewrite(store, 'r1');
  const graded = rateCard(store, 'c1');

  assert.equal(store.deleteAttempt(grading.id), 'grading');
  assert.equal(store.deleteAttempt(graded.id), 'deleted');
  assert.equal(store.deleteAttempt(graded.id), 'not_found');
});

test('an AI attempt starts grading, is finished once, and a failed one can be restarted', () => {
  const { store } = scratchStore();
  store.importFile(file(rewrite('r1', 'Text.')), false);
  const attempt = answerRewrite(store, 'r1');
  assert.equal(attempt.status, 'grading');
  assert.equal(listAll(store)[0].last_attempt!.status, 'grading');
  assert.equal(store.readProject('week-1')!.done_count, 0);

  store.finishGrading(attempt.id, { status: 'failed', error: 'boom', model: null, grading_ms: 10 });
  assert.equal(store.readAttempt(attempt.id)!.error, 'boom');
  assert.equal(store.restartGrading(attempt.id), true);
  assert.equal(store.restartGrading(attempt.id), false);

  store.finishGrading(attempt.id, { status: 'graded', text: '**Good.**', thinking_text: 'Looking.', thinking_ms: 1500, model: 'claude-sonnet-5-5', effort: 'high', grading_ms: 20 });
  // A late failure does not overwrite the grade.
  store.finishGrading(attempt.id, { status: 'failed', error: 'late', model: null, grading_ms: 30 });

  const graded = store.readAttempt(attempt.id)!;
  assert.equal(graded.status, 'graded');
  assert.equal(graded.summary, 'Graded');
  assert.equal(graded.error, null);
  assert.deepEqual(graded.result, { text: '**Good.**', thinking_text: 'Looking.', thinking_ms: 1500, model: 'claude-sonnet-5-5', effort: 'high', ms: 20 });
  assert.equal(store.readProject('week-1')!.done_count, 1);
  assert.equal(store.readAttempt(999), null);
});

test('the effort of a grading is kept in its own column', () => {
  const { store, database_path } = scratchStore();
  store.importFile(file(rewrite('r1', 'Text.')), false);
  const attempt = answerRewrite(store, 'r1');
  store.finishGrading(attempt.id, { status: 'graded', text: 'x', thinking_text: '', thinking_ms: null, model: 'claude-sonnet-5-5', effort: 'high', grading_ms: 20 });

  const database = new DatabaseSync(database_path, { readOnly: true });
  const row = database.prepare('SELECT effort FROM attempts WHERE id = ?').get(attempt.id) as { effort: string };
  database.close();
  assert.equal(row.effort, 'high');
});

test('a result written before the thinking summary and the effort were kept reads with empty ones', () => {
  const { store, database_path } = scratchStore();
  store.importFile(file(rewrite('r1', 'Text.')), false);
  const attempt = answerRewrite(store, 'r1');
  store.finishGrading(attempt.id, { status: 'graded', text: 'x', thinking_text: '', thinking_ms: null, model: 'm', effort: 'low', grading_ms: 1 });
  const database = new DatabaseSync(database_path);
  database.prepare('UPDATE attempts SET result_json = ? WHERE id = ?').run('{"text":"Old feedback.","model":"claude-sonnet-5-5","ms":8105}', attempt.id);
  database.close();
  assert.deepEqual(store.readAttempt(attempt.id)!.result, { text: 'Old feedback.', thinking_text: '', thinking_ms: null, effort: null, model: 'claude-sonnet-5-5', ms: 8105 });
});

test('a server restart fails the gradings it interrupted', () => {
  const { store, database_path } = scratchStore();
  store.importFile(file(rewrite('r1', 'T.')), false);
  const attempt = answerRewrite(store, 'r1');
  assert.equal(openPracticeStore(database_path).failInterruptedGradings(), 1);
  assert.equal(store.readAttempt(attempt.id)!.status, 'failed');
});

// ---- Migration from schema 1 ----

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
  const exercise = database.prepare(`
    INSERT INTO exercises (project_id, key, position, type, topic, tags_json, content_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  exercise.run(1, 'r1', 1, 'rewrite', 'transport', '["passive"]', '{"instruction":"Fix","text":"It go.","length":"sentence"}');
  exercise.run(2, 'd1-card-1', 1, 'flashcard', null, '[]', '{"front":"cheap","back":"rẻ"}');
  exercise.run(2, 'd1-fix-1', 2, 'rewrite', null, '[]', '{"instruction":"Fix","text":"He go.","length":"sentence","prefill":true}');
  exercise.run(3, 'd1-card-1', 1, 'flashcard', null, '[]', '{"front":"cheap","back":"rẻ"}');

  // The exercise as schema 1 kept it in an attempt.
  const snapshotOf = (exercise_id: number): string => {
    const row = database.prepare('SELECT type, content_json FROM exercises WHERE id = ?').get(exercise_id) as { type: string; content_json: string };
    return JSON.stringify({ type: row.type, topic: null, tags: [], content: JSON.parse(row.content_json) });
  };
  const attempt = database.prepare(`
    INSERT INTO attempts (project_id, exercise_id, submitted_at, type, exercise_snapshot_json, answer_json, status, result_json,
                          summary, grader, model, grading_ms, error, writing_ms, graded_at)
    VALUES ($project_id, $exercise_id, $submitted_at, $type, $snapshot, $answer, $status, $result,
            $summary, $grader, $model, $grading_ms, $error, $writing_ms, $graded_at)`);
  const insertAttempt = (row: Record<string, string | number | null> & { exercise_id: number }): void => {
    const empty = { result: null, summary: null, model: null, grading_ms: null, error: null, graded_at: null };
    attempt.run({ ...empty, ...row, snapshot: snapshotOf(row.exercise_id) });
  };
  // An AI grade from before the effort and thinking summary were kept.
  insertAttempt({
    project_id: 1, exercise_id: 1, submitted_at: '2026-10-18T16:00:00.000Z', type: 'rewrite', answer: '{"text":"It goes."}',
    status: 'graded', result: '{"text":"Old feedback.","model":"claude-sonnet-5-5","ms":8105}', summary: 'Graded',
    grader: 'ai', model: 'claude-sonnet-5-5', grading_ms: 8105, writing_ms: 30000, graded_at: '2026-10-18T16:00:09.000Z',
  });
  // An AI grade with its effort inside the result.
  insertAttempt({
    project_id: 1, exercise_id: 1, submitted_at: '2026-10-18T16:24:42.538Z', type: 'rewrite', answer: '{"text":"It went."}',
    status: 'graded',
    result: '{"text":"**Close.**","thinking_text":"","thinking_ms":null,"model":"claude-sonnet-5-5","effort":"high","ms":9000}',
    summary: 'Graded', grader: 'ai', model: 'claude-sonnet-5-5', grading_ms: 9000, writing_ms: 1000, graded_at: '2026-10-18T16:24:52.000Z',
  });
  // A flashcard rated by hand.
  insertAttempt({
    project_id: 2, exercise_id: 2, submitted_at: '2026-10-19T13:42:01.965Z', type: 'flashcard', answer: '{"rating":"known"}',
    status: 'graded', result: '{"rating":"known"}', summary: 'Knew it', grader: 'self', writing_ms: 900,
    graded_at: '2026-10-19T13:42:01.965Z',
  });
  // A failed AI grade.
  insertAttempt({
    project_id: 2, exercise_id: 3, submitted_at: '2026-10-19T13:42:00.000Z', type: 'rewrite', answer: '{"text":"He goes."}',
    status: 'failed', grader: 'ai', grading_ms: 5, error: 'The server stopped while grading.', writing_ms: 1,
  });
  // A deleted attempt: the counter is ahead of the rows, as in a real file.
  insertAttempt({
    project_id: 2, exercise_id: 3, submitted_at: '2026-10-19T13:43:00.000Z', type: 'rewrite', answer: '{"text":"x"}',
    status: 'failed', grader: 'ai', grading_ms: 5, error: 'x', writing_ms: 1,
  });
  database.exec('DELETE FROM attempts WHERE id = 5');
  database.close();
  return { directory, database_path };
}


function readRows(database_path: string, sql: string): Record<string, unknown>[] {
  const database = new DatabaseSync(database_path, { readOnly: true });
  const rows = database.prepare(sql).all().map((row) => ({ ...row }));
  database.close();
  return rows;
}

test('the migration copies the file to backups/ before it changes anything', () => {
  const { directory, database_path } = schema1File();
  openPracticeStore(database_path);
  const backup_path = join(directory, 'backups', 'practice-v2-before-schema-2.sqlite');
  assert.deepEqual(readRows(backup_path, 'PRAGMA user_version'), [{ user_version: 1 }]);
  assert.deepEqual(readRows(backup_path, 'SELECT count(*) AS count FROM attempts'), [{ count: 4 }]);
  assert.deepEqual(readRows(database_path, 'PRAGMA user_version'), [{ user_version: 2 }]);
});

test('the migration makes project keys from the names, with -{id} on a clash', () => {
  const { database_path } = schema1File();
  openPracticeStore(database_path);
  assert.deepEqual(readRows(database_path, 'SELECT id, key FROM projects ORDER BY id'), [
    { id: 1, key: 'test' },
    { id: 2, key: 'day-1-19-10-2026' },
    { id: 3, key: 'day-1-19-10-2026-v2' },
    { id: 4, key: 'test-4' },
  ]);
});

test('the migration gives exercises version 1 and their project\'s creation time', () => {
  const { database_path } = schema1File();
  openPracticeStore(database_path);
  assert.deepEqual(readRows(database_path, 'SELECT id, key, version, created_at, updated_at FROM exercises WHERE project_id = 2 ORDER BY position'), [
    { id: 2, key: 'd1-card-1', version: 1, created_at: '2026-10-19T13:39:35.305Z', updated_at: '2026-10-19T13:39:35.305Z' },
    { id: 3, key: 'd1-fix-1', version: 1, created_at: '2026-10-19T13:39:35.305Z', updated_at: '2026-10-19T13:39:35.305Z' },
  ]);
});

test('the migration gives attempts their exercise key and version, and the effort from the result', () => {
  const { database_path } = schema1File();
  openPracticeStore(database_path);
  assert.deepEqual(readRows(database_path, 'SELECT id, exercise_key, exercise_version, effort FROM attempts ORDER BY id'), [
    { id: 1, exercise_key: 'r1', exercise_version: 1, effort: null },
    { id: 2, exercise_key: 'r1', exercise_version: 1, effort: 'high' },
    { id: 3, exercise_key: 'd1-card-1', exercise_version: 1, effort: null },
    { id: 4, exercise_key: 'd1-fix-1', exercise_version: 1, effort: null },
  ]);
});

test('after the migration the delete rules are there and the old tables are gone', () => {
  const { database_path } = schema1File();
  openPracticeStore(database_path);
  const rules = readRows(database_path, 'PRAGMA foreign_key_list(attempts)').map((row) => `${row.table} ${row.on_delete}`);
  assert.deepEqual(rules.sort(), ['exercises SET NULL', 'projects CASCADE']);
  assert.deepEqual(readRows(database_path, "SELECT name FROM sqlite_master WHERE name LIKE '%_v1'"), []);
});

test('after the migration every old attempt reads as before, and the lists work', () => {
  const { database_path } = schema1File();
  const store = openPracticeStore(database_path);

  const flashcard = store.readAttempt(3)!;
  assert.equal(flashcard.project, 'day-1-19-10-2026');
  assert.equal(flashcard.exercise, 'd1-card-1');
  assert.deepEqual(flashcard.answer, { rating: 'known' });
  assert.equal(Object.hasOwn(store.readAttempt(1)!.result!, 'text'), true);
  assert.equal(store.readAttempt(4)!.status, 'failed');

  const day_1 = store.readProject('day-1-19-10-2026')!;
  assert.equal(day_1.exercise_count, 2);
  assert.equal(day_1.done_count, 1);
  const items = store.listExercises('day-1-19-10-2026', { type: null, tag: null })!;
  assert.equal(items[0].last_attempt!.id, 3);
});

test('after the migration an id is never given twice, and opening the file again changes nothing', () => {
  const { directory, database_path } = schema1File();
  const store = openPracticeStore(database_path);
  // Attempt 5 was deleted before the migration: the next one is 6.
  const next = store.createAttempt({ exercise_id: 2, answer: { rating: 'almost' }, writing_ms: 1, grader: 'self', outcome: { result: { rating: 'almost' }, summary: 'Almost' } });
  assert.equal(next.id, 6);

  assert.equal(openPracticeStore(database_path).listProjects('all').length, 4);
  assert.deepEqual(readRows(join(directory, 'backups', 'practice-v2-before-schema-2.sqlite'), 'SELECT count(*) AS count FROM attempts'), [{ count: 4 }]);
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
