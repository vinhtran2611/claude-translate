// The practice database (store.ts) on scratch files, and its migrations from schema 1 and 2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ExerciseBody, ExerciseContent, FileExercise, ProjectFile } from '../api-types.ts';
import { openPracticeStore, type AttemptFilter, type GradingOutcome, type PracticeStore } from './store.ts';
import { keyFromName } from './store-schema.ts';

// ---- Helpers ----

function flashcardContent(front: string): ExerciseContent {
  return { type: 'flashcard', front, back: 'b', hint: null, example: null, explanationMarkdown: null };
}

function card(key: string, front: string): FileExercise {
  return { key, topic: null, tags: [], content: flashcardContent(front) };
}

function rewrite(key: string, text: string): FileExercise {
  const content: ExerciseContent = { type: 'rewrite', instruction: 'Fix', sourceText: text, length: 'sentence', constraints: [], modelAnswer: null };
  return { key, topic: 'topic', tags: [], content };
}

// A file for the project "week-1".
function file(...exercises: FileExercise[]): ProjectFile {
  return { key: 'week-1', name: 'Week 1', description: null, exercises };
}

// An exercise without its key, as PUT takes it.
function bodyOf(exercise: FileExercise): ExerciseBody {
  const { key: _key, ...body } = exercise;
  return body;
}

function scratchStore() {
  const databasePath = join(mkdtempSync(join(tmpdir(), 'practice-store-')), 'practice.sqlite');
  return { store: openPracticeStore(databasePath), databasePath };
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

// A flashcard rated "knew": no grading, the rating is the result.
function rateCard(store: PracticeStore, key: string) {
  const started = store.createAttempt({ exerciseId: exerciseId(store, key), answer: { type: 'flashcard', rating: 'knew' }, timeSpentMs: 1500, grading: null });
  return started.attempt;
}

const SETTINGS = { modelId: 'claude-sonnet-5-5', effort: 'high' as const };

// A rewrite answer the AI will grade: it starts with a running grading.
function answerRewrite(store: PracticeStore, key: string) {
  return store.createAttempt({ exerciseId: exerciseId(store, key), answer: { type: 'rewrite', text: 'My answer.' }, timeSpentMs: 1500, grading: SETTINGS });
}

const SUCCEEDED: GradingOutcome = {
  status: 'succeeded', servedModelId: 'claude-haiku-5-5', thinkingText: 'Looking.', thinkingMs: 1500, feedbackMarkdown: '**Good.**',
};
const FAILED: GradingOutcome = {
  status: 'failed', servedModelId: null, thinkingText: '', thinkingMs: null, feedbackMarkdown: '', errorCode: 'claude_error', errorMessage: 'boom',
};

function readRows(databasePath: string, sql: string): Record<string, unknown>[] {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const rows = database.prepare(sql).all().map((row) => ({ ...row }));
  database.close();
  return rows;
}

// ---- Import ----

test('an import makes a project with its exercises in file order', () => {
  const { store } = scratchStore();
  const result = store.importFile(file(card('c1', 'one'), rewrite('r1', 'Two.'), card('c2', 'three')), false);
  assert.equal(result.dryRun, false);
  assert.equal(result.projectChange, 'created');
  assert.deepEqual(result.exercises.created, ['c1', 'r1', 'c2']);

  const items = listAll(store);
  assert.deepEqual(keysOf(items), ['c1', 'r1', 'c2']);
  assert.equal(items[1].preview, 'Two.');
  assert.equal(items[1].label, 'Rewrite, sentence');
  assert.equal(items[1].type, 'rewrite');
  assert.equal(items[1].version, 1);
  assert.equal(items[1].lastAttempt, null);
});

test('a project counts its exercises by type; nothing derived is stored', () => {
  const { store, databasePath } = scratchStore();
  store.importFile(file(card('c1', 'one'), rewrite('r1', 'Two.'), card('c2', 'three')), false);
  const project = store.readProject('week-1')!;
  assert.equal(project.key, 'week-1');
  assert.equal(project.description, null);
  assert.equal(project.exerciseCount, 3);
  assert.equal(project.doneCount, 0);
  assert.equal(project.lastActivityAt, null);
  assert.equal(project.archivedAt, null);
  assert.deepEqual(project.typeCounts, { flashcard: 2, rewrite: 1 });
  const columns = readRows(databasePath, 'PRAGMA table_info(projects)').map((column) => column.name);
  assert.deepEqual(columns, ['id', 'key', 'name', 'description', 'archived_at', 'created_at', 'updated_at']);
});

test('an unknown project reads as null', () => {
  const { store } = scratchStore();
  assert.equal(store.readProject('nope'), null);
  assert.equal(store.listExercises('nope', { type: null, tag: null }), null);
  assert.equal(store.exportProject('nope'), null);
});

test('importing the same file again changes nothing, whatever the order of fields', () => {
  const { store } = scratchStore();
  store.importFile(file(card('c1', 'one'), card('c2', 'two')), false);
  const before = store.readExercise('week-1', 'c1');

  const again = store.importFile(file(card('c1', 'one'), card('c2', 'two')), false);
  assert.equal(again.projectChange, 'unchanged');
  assert.deepEqual(again.exercises.unchanged, ['c1', 'c2']);
  assert.deepEqual(store.readExercise('week-1', 'c1'), before);

  const reordered: FileExercise = { key: 'c1', tags: [], topic: null, content: { back: 'b', front: 'one', type: 'flashcard', hint: null, example: null, explanationMarkdown: null } };
  assert.deepEqual(store.importFile(file(reordered), false).exercises.unchanged, ['c1']);
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

test('a dry run says what would happen and writes nothing', () => {
  const { store, databasePath } = scratchStore();
  const dry = store.importFile(file(card('c1', 'one')), true);
  assert.equal(dry.dryRun, true);
  assert.equal(dry.projectChange, 'created');
  assert.equal(dry.project.exerciseCount, 1);
  assert.equal(store.readProject('week-1'), null);

  store.importFile(file(card('c1', 'one')), false);
  const rowsBefore = readRows(databasePath, 'SELECT * FROM exercises');
  assert.equal(store.putExercise('week-1', 'c1', bodyOf(card('c1', 'changed')), true)!.exercise.version, 2);
  assert.equal(store.putExercise('week-1', 'c9', bodyOf(card('c9', 'new')), true)!.change, 'created');
  const archived = store.putProject('week-1', { name: 'Other', description: null, archivedAt: '2026-10-21T08:30:00.000Z' }, true);
  assert.equal(archived.project.archivedAt, '2026-10-21T08:30:00.000Z');
  assert.deepEqual(readRows(databasePath, 'SELECT * FROM exercises'), rowsBefore);
  assert.equal(store.readProject('week-1')!.name, 'Week 1');
});

// ---- Exercises ----

test('PUT an exercise: created at the end, then a new version (its type may change), then unchanged', () => {
  const { store } = scratchStore();
  store.importFile(file(card('c1', 'one')), false);

  const created = store.putExercise('week-1', 'r1', bodyOf(rewrite('r1', 'Text.')), false)!;
  assert.equal(created.change, 'created');
  assert.equal(created.exercise.position, 2);
  assert.equal(created.exercise.version, 1);
  assert.equal(created.exercise.projectKey, 'week-1');

  const updated = store.putExercise('week-1', 'r1', bodyOf(card('r1', 'now a card')), false)!;
  assert.equal(updated.change, 'updated');
  assert.equal(updated.exercise.content.type, 'flashcard');
  assert.equal(updated.exercise.version, 2);

  const same = store.putExercise('week-1', 'r1', bodyOf(card('r1', 'now a card')), false)!;
  assert.equal(same.change, 'unchanged');
  assert.equal(same.exercise.version, 2);
  assert.equal(store.putExercise('nope', 'r1', bodyOf(card('r1', 'x')), false), null);
});

test('an exercise with attempts is deleted only with them (rule 8)', () => {
  const { store } = scratchStore();
  store.importFile(file(card('c1', 'one'), card('c2', 'two')), false);
  const attempt = rateCard(store, 'c1');

  assert.equal(store.deleteExercise('week-1', 'c1', false), 'has_attempts');
  assert.notEqual(store.readAttempt(attempt.id), null);
  assert.equal(store.deleteExercise('week-1', 'c1', true), 'deleted');
  assert.equal(store.readAttempt(attempt.id), null);
  assert.equal(store.deleteExercise('week-1', 'c1', true), 'not_found');
  assert.equal(store.deleteExercise('week-1', 'c2', false), 'deleted');
  assert.equal(store.readProject('week-1')!.doneCount, 0);
});

test('the exercise list filters by type and tag, and a row with broken JSON still lists', () => {
  const { store, databasePath } = scratchStore();
  store.importFile(file(card('c1', 'one'), { ...rewrite('r1', 'T.'), tags: ['passive'] }), false);
  const database = new DatabaseSync(databasePath);
  database.prepare("UPDATE exercises SET content_json = 'null' WHERE key = 'c1'").run();
  database.close();

  const items = listAll(store);
  assert.equal(items[0].label, 'flashcard');
  assert.equal(items[0].preview, '');

  assert.deepEqual(keysOf(store.listExercises('week-1', { type: 'rewrite', tag: null })!), ['r1']);
  assert.deepEqual(keysOf(store.listExercises('week-1', { type: null, tag: 'passive' })!), ['r1']);
  assert.deepEqual(store.listExercises('week-1', { type: null, tag: 'nope' }), []);
});

test('the database refuses content whose type is not the exercise\'s type', () => {
  const { store, databasePath } = scratchStore();
  store.importFile(file(card('c1', 'one')), false);
  const database = new DatabaseSync(databasePath);
  assert.throws(() => database.prepare("UPDATE exercises SET type = 'essay' WHERE key = 'c1'").run(), /CHECK constraint failed/);
  database.close();
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

test('archive hides a project from the default list; an import keeps it archived', () => {
  const { store } = scratchStore();
  store.importFile(file(card('c1', 'one')), false);

  const archived = store.putProject('week-1', { name: 'Week 1', description: null, archivedAt: '2026-10-21T08:30:00.000Z' }, false);
  assert.equal(archived.change, 'updated');
  assert.equal(store.listProjects('false').length, 0);
  assert.deepEqual(keysOf(store.listProjects('true')), ['week-1']);

  const imported = store.importFile(file(card('c1', 'one'), card('c2', 'two')), false);
  assert.equal(imported.project.archivedAt, '2026-10-21T08:30:00.000Z');
});

test('export is a format 4 file with every field written out, and importing it changes nothing', () => {
  const { store } = scratchStore();
  const tagged: FileExercise = { ...rewrite('r1', 'Text.'), tags: ['passive'] };
  store.importFile({ ...file(card('c1', 'one'), tagged), description: 'Mine' }, false);

  const exported = store.exportProject('week-1')!;
  assert.equal(exported.format, 4);
  assert.deepEqual(exported.project, { key: 'week-1', name: 'Week 1', description: 'Mine' });
  assert.deepEqual(exported.exercises[0], card('c1', 'one'));
  assert.deepEqual(exported.exercises[1].tags, ['passive']);

  const again = store.importFile({ key: 'week-1', name: 'Week 1', description: 'Mine', exercises: exported.exercises }, false);
  assert.equal(again.projectChange, 'unchanged');
  assert.deepEqual(again.exercises.unchanged, ['c1', 'r1']);
});

// ---- Attempts and gradings ----

test('an attempt keeps the version and a snapshot of the exercise as it was', () => {
  const { store } = scratchStore();
  store.importFile(file(card('c1', 'before')), false);
  const first = rateCard(store, 'c1');
  assert.equal(first.exerciseVersion, 1);
  assert.equal(first.projectKey, 'week-1');
  assert.equal(first.exerciseKey, 'c1');
  assert.deepEqual(first.gradings, []);

  store.putExercise('week-1', 'c1', bodyOf(card('c1', 'after')), false);
  assert.equal(rateCard(store, 'c1').exerciseVersion, 2);
  assert.deepEqual(store.readAttempt(first.id)!.exerciseSnapshot, { topic: null, tags: [], content: flashcardContent('before') });
});

test('a flashcard attempt makes the exercise done at once; its project shows the activity', () => {
  const { store } = scratchStore();
  store.importFile(file(card('c1', 'one')), false);
  const attempt = rateCard(store, 'c1');
  const project = store.readProject('week-1')!;
  assert.equal(project.doneCount, 1);
  assert.equal(project.lastActivityAt, attempt.createdAt);
  assert.deepEqual(listAll(store)[0].lastAttempt, { id: attempt.id, createdAt: attempt.createdAt, gradingStatus: null, historyLine: 'Knew it' });
});

test('the attempts list is newest first, filters by the latest grading\'s status, and pages with before', () => {
  const { store } = scratchStore();
  store.importFile(file(card('c1', 'one'), rewrite('r1', 'Text.')), false);
  const first = rateCard(store, 'c1');
  const second = answerRewrite(store, 'r1').attempt;
  const third = rateCard(store, 'c1');

  const idsOf = (filter: Partial<AttemptFilter>) => listAttempts(store, filter).items.map((attempt) => attempt.id);
  assert.deepEqual(idsOf({}), [third.id, second.id, first.id]);
  assert.deepEqual(idsOf({ status: 'running' }), [second.id]);
  assert.deepEqual(idsOf({ status: 'succeeded' }), []);
  assert.deepEqual(idsOf({ project: 'week-1', exercise: 'c1' }), [third.id, first.id]);
  assert.deepEqual(idsOf({ since: '2999-01-01T00:00:00.000Z' }), []);

  const page1 = listAttempts(store, { limit: 2 });
  assert.equal(page1.items.length, 2);
  assert.equal(page1.nextBefore, second.id);
  const page2 = listAttempts(store, { limit: 2, before: page1.nextBefore });
  assert.equal(page2.items.length, 1);
  assert.equal(page2.nextBefore, undefined);
});

test('an AI attempt starts with a running grading, which is finished once', () => {
  const { store } = scratchStore();
  store.importFile(file(rewrite('r1', 'Text.')), false);
  const { attempt, gradingId } = answerRewrite(store, 'r1');
  assert.equal(attempt.gradings.length, 1);
  const running = attempt.gradings[0];
  assert.equal(running.id, gradingId);
  assert.equal(running.run.status, 'running');
  assert.equal(running.run.requestedModelId, 'claude-sonnet-5-5');
  assert.equal(running.run.servedModelId, null);
  assert.equal(running.run.effort, 'high');
  assert.equal(running.run.finishedAt, null);
  assert.equal(listAll(store)[0].lastAttempt!.historyLine, 'Grading…');
  assert.equal(store.readProject('week-1')!.doneCount, 0);

  store.finishGrading(gradingId!, SUCCEEDED);
  // A late failure does not overwrite the finished grading.
  store.finishGrading(gradingId!, FAILED);

  const graded = store.readAttempt(attempt.id)!.gradings[0];
  assert.equal(graded.run.status, 'succeeded');
  assert.equal(graded.run.servedModelId, 'claude-haiku-5-5');
  assert.equal(graded.run.thinkingText, 'Looking.');
  assert.equal(graded.run.thinkingMs, 1500);
  assert.equal(graded.run.errorCode, null);
  assert.notEqual(graded.run.finishedAt, null);
  assert.equal(graded.feedbackMarkdown, '**Good.**');
  assert.equal(graded.updatedAt, graded.run.finishedAt);
  assert.equal(listAll(store)[0].lastAttempt!.historyLine, 'Graded');
  assert.equal(store.readProject('week-1')!.doneCount, 1);
  assert.equal(store.readAttempt(999), null);
});

test('a regrade adds a new grading at any time, one at a time; every grading is kept (rule 7)', () => {
  const { store } = scratchStore();
  store.importFile(file(rewrite('r1', 'Text.'), card('c1', 'one')), false);
  const { attempt, gradingId } = answerRewrite(store, 'r1');

  assert.equal(store.regrade(attempt.id, SETTINGS), 'grading');
  store.finishGrading(gradingId!, FAILED);
  const failed = store.readAttempt(attempt.id)!.gradings[0];
  assert.equal(failed.run.status, 'failed');
  assert.equal(failed.run.errorCode, 'claude_error');
  assert.equal(failed.run.errorMessage, 'boom');
  assert.equal(failed.feedbackMarkdown, null);

  const second = store.regrade(attempt.id, { modelId: 'claude-opus-5-5', effort: 'low' });
  assert.ok(typeof second === 'object');
  store.finishGrading(second.gradingId!, SUCCEEDED);
  const third = store.regrade(attempt.id, SETTINGS);
  assert.ok(typeof third === 'object');
  assert.deepEqual(store.readAttempt(attempt.id)!.gradings.map((grading) => grading.run.status), ['failed', 'succeeded', 'running']);

  assert.equal(store.regrade(rateCard(store, 'c1').id, SETTINGS), 'not_graded_by_ai');
  assert.equal(store.regrade(999, SETTINGS), 'not_found');
});

test('an attempt being graded cannot be deleted; a finished one can, with its gradings', () => {
  const { store, databasePath } = scratchStore();
  store.importFile(file(card('c1', 'one'), rewrite('r1', 'Text.')), false);
  const { attempt, gradingId } = answerRewrite(store, 'r1');

  assert.equal(store.deleteAttempt(attempt.id), 'grading');
  store.finishGrading(gradingId!, SUCCEEDED);
  assert.equal(store.deleteAttempt(attempt.id), 'deleted');
  assert.equal(store.deleteAttempt(attempt.id), 'not_found');
  assert.deepEqual(readRows(databasePath, 'SELECT count(*) AS count FROM gradings'), [{ count: 0 }]);
});

test('a server restart fails the gradings it interrupted', () => {
  const { store, databasePath } = scratchStore();
  store.importFile(file(rewrite('r1', 'T.')), false);
  const { attempt } = answerRewrite(store, 'r1');
  assert.equal(openPracticeStore(databasePath).failInterruptedGradings(), 1);
  const run = store.readAttempt(attempt.id)!.gradings[0].run;
  assert.equal(run.status, 'failed');
  assert.equal(run.errorCode, 'interrupted');
  assert.equal(run.errorMessage, 'The server stopped while grading.');
  assert.notEqual(run.finishedAt, null);
});

test('the database keeps at most one running grading per attempt', () => {
  const { store, databasePath } = scratchStore();
  store.importFile(file(rewrite('r1', 'T.')), false);
  const { attempt } = answerRewrite(store, 'r1');
  const database = new DatabaseSync(databasePath);
  const copy = `INSERT INTO gradings (attempt_id, run_status, run_requested_model_id, run_effort, run_started_at, created_at, updated_at)
    SELECT attempt_id, run_status, run_requested_model_id, run_effort, run_started_at, created_at, updated_at FROM gradings WHERE attempt_id = ?`;
  assert.throws(() => database.prepare(copy).run(attempt.id), /UNIQUE constraint failed/);
  database.close();
});

// ---- Migration from schema 2 (the spec's §5) ----

// Schema 2 as it shipped, to test the migration on a file that looks like the real one.
const SCHEMA_2 = `
  CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_activity_at TEXT) STRICT;
  CREATE TABLE exercises (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    key TEXT NOT NULL, position INTEGER NOT NULL, type TEXT NOT NULL, topic TEXT, tags_json TEXT NOT NULL, content_json TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (project_id, key)) STRICT;
  CREATE INDEX exercises_by_position ON exercises (project_id, position);
  CREATE TABLE attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    exercise_id INTEGER REFERENCES exercises (id) ON DELETE SET NULL, exercise_key TEXT NOT NULL, exercise_version INTEGER NOT NULL,
    submitted_at TEXT NOT NULL, type TEXT NOT NULL, exercise_snapshot_json TEXT NOT NULL, answer_json TEXT NOT NULL, status TEXT NOT NULL,
    result_json TEXT, summary TEXT, grader TEXT NOT NULL, model TEXT, effort TEXT, grading_ms INTEGER, error TEXT, writing_ms INTEGER, graded_at TEXT) STRICT;
  CREATE INDEX attempts_by_exercise ON attempts (exercise_id, id);
  CREATE INDEX attempts_by_project ON attempts (project_id, id);
  PRAGMA user_version = 2;`;

const OLD_CONTENTS: Record<string, [string, object]> = {
  r1: ['rewrite', { instruction: 'Fix', text: 'It go.', length: 'essay', reference: 'It goes.' }],
  t1: ['rewrite', { instruction: 'Translate', text: 'Xin chào.', length: 'sentence', source_lang: 'vi' }],
  c1: ['rewrite', { instruction: 'Fix', text: 'He go.', length: 'sentence', prefill: true, mistakes: [{ wrong: 'go', right: 'goes' }] }],
  w1: ['write', { prompt: 'Discuss.', minutes: 40 }],
  q1: ['choice', { question: 'Q', options: [{ text: 'a', why: 'x', correct: true }, { text: 'b', why: 'y' }] }],
  f1: ['fill', { text: 'A {{1}}.', gaps: [{ answer: 'x', hint: 'h' }] }],
  k1: ['flashcard', { front: 'cheap', back: 'rẻ' }],
};

function schema2File() {
  const directory = mkdtempSync(join(tmpdir(), 'practice-migrate-'));
  const databasePath = join(directory, 'practice.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec(SCHEMA_2);
  const project = database.prepare('INSERT INTO projects (key, name, description, archived_at, created_at, updated_at, last_activity_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  project.run('day-1', 'Day 1', '', null, '2026-10-18T15:38:46.581Z', '2026-10-18T15:38:46.581Z', '2026-10-19T13:42:01.965Z');
  project.run('day-2', 'Day 2', 'Đề số 1', '2026-10-20T00:00:00.000Z', '2026-10-19T13:48:07.177Z', '2026-10-20T00:00:00.000Z', null);
  const exercise = database.prepare(`
    INSERT INTO exercises (project_id, key, position, type, topic, tags_json, content_json, version, created_at, updated_at)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, '2026-10-18T15:38:46.581Z', '2026-10-18T15:40:00.000Z')`);
  Object.entries(OLD_CONTENTS).forEach(([key, [type, content]], index) => {
    exercise.run(key, index + 1, type, key === 'r1' ? 'transport' : null, key === 'r1' ? '["passive"]' : '[]', JSON.stringify(content), key === 'r1' ? 2 : 1);
  });

  const exerciseIdOf = (key: string) => (database.prepare('SELECT id FROM exercises WHERE key = ?').get(key) as { id: number }).id;
  // The exercise as schema 2 kept it in an attempt.
  const snapshotOf = (key: string): string => {
    const [type, content] = OLD_CONTENTS[key];
    return JSON.stringify({ type, topic: key === 'r1' ? 'transport' : null, tags: key === 'r1' ? ['passive'] : [], content });
  };
  const attempt = database.prepare(`
    INSERT INTO attempts (project_id, exercise_id, exercise_key, exercise_version, submitted_at, type, exercise_snapshot_json, answer_json, status,
                          result_json, summary, grader, model, effort, grading_ms, error, writing_ms, graded_at)
    VALUES (1, $exercise_id, $key, 1, $submitted_at, $type, $snapshot, $answer, $status, $result, $summary, $grader, $model, $effort,
            $grading_ms, $error, $writing_ms, $graded_at)`);
  const insertAttempt = (key: string, row: Record<string, string | number | null>): void => {
    const empty = { result: null, summary: null, model: null, effort: null, grading_ms: null, error: null, graded_at: null, writing_ms: null };
    attempt.run({ ...empty, ...row, exercise_id: exerciseIdOf(key), key, type: OLD_CONTENTS[key][0], snapshot: snapshotOf(key) });
  };
  // 1: an AI grade from before the effort and thinking summary were kept.
  insertAttempt('r1', {
    submitted_at: '2026-10-18T16:00:00.000Z', answer: '{"text":"It goes."}', status: 'graded',
    result: '{"text":"Old feedback.","model":"claude-sonnet-5-5","ms":8105}', summary: 'Graded', grader: 'ai', model: 'claude-sonnet-5-5',
    grading_ms: 8105, writing_ms: 30000, graded_at: '2026-10-18T16:00:09.000Z',
  });
  // 2: an AI grade with thinking and effort.
  insertAttempt('q1', {
    submitted_at: '2026-10-18T16:24:42.538Z', answer: '{"chosen":[0]}', status: 'graded',
    result: '{"text":"**Correct.**","thinking_text":"Hmm.","thinking_ms":1200,"model":"claude-haiku-5-5","effort":"high","ms":9000}',
    summary: 'Graded', grader: 'ai', model: 'claude-haiku-5-5', effort: 'high', grading_ms: 9000, writing_ms: 1000, graded_at: '2026-10-18T16:24:52.000Z',
  });
  // 3: a flashcard rated by hand.
  insertAttempt('k1', {
    submitted_at: '2026-10-19T13:42:01.965Z', answer: '{"rating":"unknown"}', status: 'graded', result: '{"rating":"unknown"}', summary: 'Didn’t know',
    grader: 'self', writing_ms: 900, graded_at: '2026-10-19T13:42:01.965Z',
  });
  // 4: a grading the server stopped.
  insertAttempt('c1', {
    submitted_at: '2026-10-19T13:42:00.000Z', answer: '{"text":"He goes."}', status: 'failed', grader: 'ai', model: 'claude-sonnet-5-5',
    grading_ms: 5, error: 'The server stopped while grading.', writing_ms: 1,
  });
  // 5: another failure.
  insertAttempt('f1', {
    submitted_at: '2026-10-19T13:43:00.000Z', answer: '{"gaps":["x"]}', status: 'failed', grader: 'ai', model: 'claude-sonnet-5-5',
    grading_ms: 2000, error: 'Fake API error', writing_ms: 1,
  });
  // 6: a grading still running when the server stopped.
  insertAttempt('w1', { submitted_at: '2026-10-19T13:44:00.000Z', answer: '{"text":"An essay."}', status: 'grading', grader: 'ai', writing_ms: 1 });
  // 7: a translation answer; 8: deleted, so the counter is ahead of the rows, as in a real file.
  insertAttempt('t1', { submitted_at: '2026-10-19T13:45:00.000Z', answer: '{"text":"Hello."}', status: 'failed', grader: 'ai', grading_ms: 1, error: 'x' });
  insertAttempt('t1', { submitted_at: '2026-10-19T13:46:00.000Z', answer: '{"text":"Hi."}', status: 'failed', grader: 'ai', grading_ms: 1, error: 'x' });
  database.exec('DELETE FROM attempts WHERE id = 8');
  database.close();
  return { directory, databasePath };
}

function gradingRows(databasePath: string): Record<string, unknown>[] {
  return readRows(databasePath, `
    SELECT attempt_id, run_status, run_requested_model_id, run_served_model_id, run_effort, run_thinking_text, run_thinking_ms,
           run_error_code, run_error_message, run_started_at, run_finished_at, feedback_markdown, created_at, updated_at
    FROM gradings ORDER BY attempt_id`);
}

test('the schema 2 migration copies the file to backups/ first, and sets the schema version', () => {
  const { directory, databasePath } = schema2File();
  openPracticeStore(databasePath);
  const backupPath = join(directory, 'backups', 'practice-before-schema-3.sqlite');
  assert.deepEqual(readRows(backupPath, 'PRAGMA user_version'), [{ user_version: 2 }]);
  assert.deepEqual(readRows(backupPath, 'SELECT count(*) AS count FROM attempts'), [{ count: 7 }]);
  assert.deepEqual(readRows(databasePath, 'PRAGMA user_version'), [{ user_version: 3 }]);
});

test('the schema 2 migration: projects lose last_activity_at, and an empty description becomes null', () => {
  const { databasePath } = schema2File();
  openPracticeStore(databasePath);
  assert.deepEqual(readRows(databasePath, 'SELECT * FROM projects ORDER BY id'), [
    { id: 1, key: 'day-1', name: 'Day 1', description: null, archived_at: null, created_at: '2026-10-18T15:38:46.581Z', updated_at: '2026-10-18T15:38:46.581Z' },
    {
      id: 2, key: 'day-2', name: 'Day 2', description: 'Đề số 1', archived_at: '2026-10-20T00:00:00.000Z', created_at: '2026-10-19T13:48:07.177Z',
      updated_at: '2026-10-20T00:00:00.000Z',
    },
  ]);
});

test('the schema 2 migration maps every exercise type, keeping ids, versions and times', () => {
  const { databasePath } = schema2File();
  const store = openPracticeStore(databasePath);
  const rows = readRows(databasePath, 'SELECT id, key, type, version, created_at, updated_at FROM exercises ORDER BY position');
  assert.deepEqual(rows.map((row) => `${row.key} ${row.type} v${row.version}`), [
    'r1 rewrite v2', 't1 translation v1', 'c1 correction v1', 'w1 essay v1', 'q1 choice v1', 'f1 gap_fill v1', 'k1 flashcard v1',
  ]);
  assert.equal(rows[0].updated_at, '2026-10-18T15:40:00.000Z');
  const r1 = store.readExercise('day-1', 'r1')!;
  assert.deepEqual(r1.content, { type: 'rewrite', instruction: 'Fix', sourceText: 'It go.', length: 'multi_paragraph', constraints: [], modelAnswer: 'It goes.' });
  assert.equal(r1.topic, 'transport');
  assert.deepEqual(r1.tags, ['passive']);
  assert.deepEqual(store.readExercise('day-1', 'c1')!.content, {
    type: 'correction', instruction: 'Fix', sourceText: 'He go.', length: 'sentence',
    plantedMistakes: [{ wrongText: 'go', correctText: 'goes', explanationMarkdown: null }], constraints: [], modelAnswer: null,
  });
  assert.deepEqual(store.readExercise('day-1', 'w1')!.content, { type: 'essay', instruction: 'Discuss.', minWords: 250, suggestedMinutes: 40, constraints: [], modelAnswer: null });
  assert.deepEqual(store.readExercise('day-1', 'f1')!.content, {
    type: 'gap_fill', instruction: null, textWithGaps: 'A {{1}}.', gaps: [{ acceptedAnswers: ['x'], hint: 'h', explanationMarkdown: null }],
  });
});

test('the schema 2 migration: attempts keep their snapshot and answer in the new shapes, and only the columns of the spec', () => {
  const { databasePath } = schema2File();
  const store = openPracticeStore(databasePath);
  const columns = readRows(databasePath, 'PRAGMA table_info(attempts)').map((column) => column.name);
  assert.deepEqual(columns, ['id', 'exercise_id', 'exercise_version', 'exercise_snapshot_json', 'answer_json', 'time_spent_ms', 'created_at', 'updated_at']);

  const first = store.readAttempt(1)!;
  assert.deepEqual(first.answer, { type: 'rewrite', text: 'It goes.' });
  assert.equal(first.exerciseSnapshot.content.type, 'rewrite');
  assert.deepEqual(first.exerciseSnapshot.tags, ['passive']);
  assert.equal(first.timeSpentMs, 30000);
  assert.equal(first.createdAt, '2026-10-18T16:00:00.000Z');
  assert.equal(first.updatedAt, first.createdAt);
  assert.deepEqual(store.readAttempt(2)!.answer, { type: 'choice', chosenOptionIndexes: [0] });
  assert.deepEqual(store.readAttempt(3)!.answer, { type: 'flashcard', rating: 'didnt_know' });
  assert.deepEqual(store.readAttempt(5)!.answer, { type: 'gap_fill', gapAnswers: ['x'] });
  assert.deepEqual(store.readAttempt(7)!.answer, { type: 'translation', text: 'Hello.' });
  assert.equal(store.readAttempt(7)!.exerciseSnapshot.content.type, 'translation');
});

test('the schema 2 migration gives each AI-graded attempt one grading, and a flashcard none', () => {
  const { databasePath } = schema2File();
  openPracticeStore(databasePath);
  assert.deepEqual(gradingRows(databasePath), [
    {
      attempt_id: 1, run_status: 'succeeded', run_requested_model_id: 'claude-sonnet-5-5', run_served_model_id: 'claude-sonnet-5-5',
      run_effort: null, run_thinking_text: null, run_thinking_ms: null, run_error_code: null, run_error_message: null,
      run_started_at: '2026-10-18T16:00:00.895Z', run_finished_at: '2026-10-18T16:00:09.000Z', feedback_markdown: 'Old feedback.',
      created_at: '2026-10-18T16:00:00.895Z', updated_at: '2026-10-18T16:00:00.895Z',
    },
    {
      attempt_id: 2, run_status: 'succeeded', run_requested_model_id: 'claude-haiku-5-5', run_served_model_id: 'claude-haiku-5-5',
      run_effort: 'high', run_thinking_text: 'Hmm.', run_thinking_ms: 1200, run_error_code: null, run_error_message: null,
      run_started_at: '2026-10-18T16:24:43.000Z', run_finished_at: '2026-10-18T16:24:52.000Z', feedback_markdown: '**Correct.**',
      created_at: '2026-10-18T16:24:43.000Z', updated_at: '2026-10-18T16:24:43.000Z',
    },
    {
      attempt_id: 4, run_status: 'failed', run_requested_model_id: 'claude-sonnet-5-5', run_served_model_id: 'claude-sonnet-5-5',
      run_effort: null, run_thinking_text: null, run_thinking_ms: null, run_error_code: 'interrupted',
      run_error_message: 'The server stopped while grading.', run_started_at: '2026-10-19T13:42:00.000Z', run_finished_at: '2026-10-19T13:42:00.005Z',
      feedback_markdown: null, created_at: '2026-10-19T13:42:00.000Z', updated_at: '2026-10-19T13:42:00.000Z',
    },
    {
      attempt_id: 5, run_status: 'failed', run_requested_model_id: 'claude-sonnet-5-5', run_served_model_id: 'claude-sonnet-5-5',
      run_effort: null, run_thinking_text: null, run_thinking_ms: null, run_error_code: 'claude_error', run_error_message: 'Fake API error',
      run_started_at: '2026-10-19T13:43:00.000Z', run_finished_at: '2026-10-19T13:43:02.000Z', feedback_markdown: null,
      created_at: '2026-10-19T13:43:00.000Z', updated_at: '2026-10-19T13:43:00.000Z',
    },
    {
      attempt_id: 6, run_status: 'running', run_requested_model_id: null, run_served_model_id: null, run_effort: null, run_thinking_text: null,
      run_thinking_ms: null, run_error_code: null, run_error_message: null, run_started_at: '2026-10-19T13:44:00.000Z', run_finished_at: null,
      feedback_markdown: null, created_at: '2026-10-19T13:44:00.000Z', updated_at: '2026-10-19T13:44:00.000Z',
    },
    {
      attempt_id: 7, run_status: 'failed', run_requested_model_id: null, run_served_model_id: null, run_effort: null, run_thinking_text: null,
      run_thinking_ms: null, run_error_code: 'claude_error', run_error_message: 'x', run_started_at: '2026-10-19T13:45:00.000Z',
      run_finished_at: '2026-10-19T13:45:00.001Z', feedback_markdown: null, created_at: '2026-10-19T13:45:00.000Z', updated_at: '2026-10-19T13:45:00.000Z',
    },
  ]);
});

test('after the schema 2 migration the derived facts read as before, and a grading left running fails at startup', () => {
  const { databasePath } = schema2File();
  const store = openPracticeStore(databasePath);
  const day1 = store.readProject('day-1')!;
  assert.equal(day1.exerciseCount, 7);
  // r1 and q1 have a succeeded grading, k1 a flashcard attempt.
  assert.equal(day1.doneCount, 3);
  assert.equal(day1.lastActivityAt, '2026-10-19T13:45:00.000Z');
  const items = store.listExercises('day-1', { type: null, tag: null })!;
  assert.equal(items.find((item) => item.key === 'k1')!.lastAttempt!.historyLine, 'Didn’t know');
  assert.equal(items.find((item) => item.key === 'r1')!.lastAttempt!.historyLine, 'Graded');

  assert.equal(store.failInterruptedGradings(), 1);
  assert.equal(store.readAttempt(6)!.gradings[0].run.errorCode, 'interrupted');
});

test('after the schema 2 migration an id is never given twice, the delete rules are there, and opening again changes nothing', () => {
  const { directory, databasePath } = schema2File();
  const store = openPracticeStore(databasePath);
  const next = store.createAttempt({ exerciseId: 7, answer: { type: 'flashcard', rating: 'almost' }, timeSpentMs: 1, grading: null });
  // Attempt 8 was deleted before the migration: the next one is 9.
  assert.equal(next.attempt.id, 9);
  const rules = readRows(databasePath, 'PRAGMA foreign_key_list(attempts)').map((row) => `${row.table} ${row.on_delete}`);
  assert.deepEqual(rules, ['exercises CASCADE']);
  assert.equal(openPracticeStore(databasePath).listProjects('all').length, 2);
  assert.deepEqual(readRows(join(directory, 'backups', 'practice-before-schema-3.sqlite'), 'SELECT count(*) AS count FROM attempts'), [{ count: 7 }]);
});

test('the schema 2 migration stops, and changes nothing, when an attempt has no exercise', () => {
  const { databasePath } = schema2File();
  const database = new DatabaseSync(databasePath);
  database.exec('UPDATE attempts SET exercise_id = NULL WHERE id = 3');
  database.close();
  assert.throws(() => openPracticeStore(databasePath), /attempt\(s\) 3 have no exercise/);
  assert.deepEqual(readRows(databasePath, 'PRAGMA user_version'), [{ user_version: 2 }]);
  assert.deepEqual(readRows(databasePath, 'SELECT count(*) AS count FROM attempts'), [{ count: 7 }]);
});

test('the schema 2 migration stops, naming the row, when stored content cannot be read', () => {
  const { databasePath } = schema2File();
  const database = new DatabaseSync(databasePath);
  database.exec("UPDATE exercises SET content_json = 'null' WHERE key = 'q1'");
  database.close();
  assert.throws(() => openPracticeStore(databasePath), /migrating exercise 5 to schema 3/);
  assert.deepEqual(readRows(databasePath, 'PRAGMA user_version'), [{ user_version: 2 }]);
});

// ---- Migration from schema 1 (to 2, then to 3) ----

// Schema 1 as it shipped.
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
  const databasePath = join(directory, 'practice.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec(SCHEMA_1);
  const project = database.prepare('INSERT INTO projects (name, description, created_at, last_activity_at) VALUES (?, ?, ?, ?)');
  project.run('Test', '', '2026-10-18T15:38:46.581Z', '2026-10-18T16:24:42.538Z');
  project.run('Day 1 - 19/10/2026', '', '2026-10-19T13:39:35.305Z', '2026-10-19T13:42:01.965Z');
  project.run('Test', '', '2026-10-19T14:00:00.000Z', null);
  const exercise = database.prepare(`
    INSERT INTO exercises (project_id, key, position, type, topic, tags_json, content_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  exercise.run(1, 'r1', 1, 'rewrite', 'transport', '["passive"]', '{"instruction":"Fix","text":"It go.","length":"sentence"}');
  exercise.run(2, 'd1-card-1', 1, 'flashcard', null, '[]', '{"front":"cheap","back":"rẻ"}');
  const snapshotOf = (id: number): string => {
    const row = database.prepare('SELECT type, content_json FROM exercises WHERE id = ?').get(id) as { type: string; content_json: string };
    return JSON.stringify({ type: row.type, topic: null, tags: [], content: JSON.parse(row.content_json) });
  };
  const attempt = database.prepare(`
    INSERT INTO attempts (project_id, exercise_id, submitted_at, type, exercise_snapshot_json, answer_json, status, result_json, summary, grader,
                          model, grading_ms, error, writing_ms, graded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  attempt.run(1, 1, '2026-10-18T16:24:42.538Z', 'rewrite', snapshotOf(1), '{"text":"It went."}', 'graded',
    '{"text":"**Close.**","thinking_text":"","thinking_ms":null,"model":"claude-sonnet-5-5","effort":"high","ms":9000}', 'Graded', 'ai',
    'claude-sonnet-5-5', 9000, null, 1000, '2026-10-18T16:24:52.000Z');
  attempt.run(2, 2, '2026-10-19T13:42:01.965Z', 'flashcard', snapshotOf(2), '{"rating":"known"}', 'graded', '{"rating":"known"}', 'Knew it', 'self',
    null, null, null, 900, '2026-10-19T13:42:01.965Z');
  database.close();
  return { directory, databasePath };
}

test('a schema 1 file goes through schema 2 to schema 3: keys from names, then the new model', () => {
  const { directory, databasePath } = schema1File();
  const store = openPracticeStore(databasePath);
  assert.deepEqual(readRows(databasePath, 'PRAGMA user_version'), [{ user_version: 3 }]);
  assert.deepEqual(readRows(join(directory, 'backups', 'practice-before-schema-3.sqlite'), 'PRAGMA user_version'), [{ user_version: 1 }]);
  assert.deepEqual(readRows(databasePath, 'SELECT id, key FROM projects ORDER BY id'), [
    { id: 1, key: 'test' },
    { id: 2, key: 'day-1-19-10-2026' },
    { id: 3, key: 'test-3' },
  ]);
  const graded = store.readAttempt(1)!;
  assert.equal(graded.exerciseKey, 'r1');
  assert.equal(graded.gradings[0].run.effort, 'high');
  assert.equal(graded.gradings[0].feedbackMarkdown, '**Close.**');
  assert.deepEqual(store.readAttempt(2)!.answer, { type: 'flashcard', rating: 'knew' });
  assert.equal(store.readProject('day-1-19-10-2026')!.doneCount, 1);
  assert.deepEqual(readRows(databasePath, "SELECT name FROM sqlite_master WHERE name LIKE '%_v1'"), []);
});

test('a schema 1 migration that would lose a row changes nothing', () => {
  const { databasePath } = schema1File();
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA foreign_keys = OFF; DELETE FROM exercises WHERE id = 1');
  database.close();
  assert.throws(() => openPracticeStore(databasePath), /would lose rows/);
  assert.deepEqual(readRows(databasePath, 'PRAGMA user_version'), [{ user_version: 1 }]);
  assert.deepEqual(readRows(databasePath, 'SELECT count(*) AS count FROM attempts'), [{ count: 2 }]);
});

test('a key made from a name', () => {
  const free = () => false;
  assert.equal(keyFromName('Day 1 - 19/10/2026', 2, free), 'day-1-19-10-2026');
  assert.equal(keyFromName('Đề số một: Nhiệm vụ 2', 9, free), 'de-so-mot-nhiem-vu-2');
  assert.equal(keyFromName('Test', 4, (key) => key === 'test'), 'test-4');
  assert.equal(keyFromName('!!!', 7, free), 'project-7');
  assert.equal(keyFromName('x'.repeat(70), 12, (key) => key === 'x'.repeat(64)), `${'x'.repeat(61)}-12`);
});
