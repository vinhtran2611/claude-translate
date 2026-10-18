// The practice database (features/practice/server/store.ts) on a scratch file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FileExercise, ProjectFile } from '../features/practice/api.ts';
import { openPracticeStore } from '../features/practice/server/store.ts';

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
