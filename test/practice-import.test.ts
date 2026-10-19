// The import file check (features/practice/import-check.ts): the example is valid, and every rule gives one clear line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkProjectFile, problemLine } from '../features/practice/import-check.ts';

const EXAMPLE = JSON.parse(readFileSync(new URL('../features/practice/examples/example-project.json', import.meta.url), 'utf8'));
const exercise = (id: string, type: string, content: object, extra: object = {}) => ({ id, type, content, ...extra });
const fileWith = (...exercises: object[]) => JSON.stringify({ format: 2, project: { name: 'P' }, exercises });
// The problems as the page shows them: one line each, or null for a good file.
const problemsOf = (text: string) => checkProjectFile(text).problems?.map((problem) => problemLine(problem, (() => { try { return JSON.parse(text).exercises; } catch { return null; } })())) ?? null;

test('the example file is valid and covers all five types', () => {
  const { file, problems } = checkProjectFile(JSON.stringify(EXAMPLE));
  assert.equal(problems, null);
  assert.equal(file?.name, 'IELTS Writing Task 2 – Example');
  assert.deepEqual([...new Set(file?.exercises.map((entry) => entry.type))].sort(), ['choice', 'fill', 'flashcard', 'rewrite', 'write']);
  assert.equal(file?.exercises[0].key, 'ex-01');
  assert.equal(file?.exercises[0].topic, 'transport');
  assert.deepEqual(file?.exercises[0].tags, []);
});

test('each problem has a JSON Pointer path and a stable code', () => {
  const text = fileWith(
    exercise('a', 'choice', { question: 'Q', options: [{ text: 'x', why: 'y' }, { text: 'z', why: 'w' }] }),
    exercise('a', 'flashcard', { front: ' ', colour: 'red' }),
  );
  assert.deepEqual(checkProjectFile(text).problems?.map(({ path, code }) => [path, code]), [
    ['/exercises/0/content/options', 'no_correct_option'],
    ['/exercises/1/content/colour', 'unknown_field'],
    ['/exercises/1/content/front', 'empty'],
    ['/exercises/1/content/back', 'required'],
    ['/exercises/1/id', 'duplicate_key'],
  ]);
  assert.deepEqual(checkProjectFile('{"format": 1, "project": {"name": "P", "x/y": 1}, "exercises": []}').problems?.map(({ path, code }) => [path, code]), [
    ['/format', 'unsupported_format'], ['/project/x~1y', 'unknown_field'], ['/exercises', 'too_few'],
  ]);
});

test('text that is not JSON says where', () => {
  assert.deepEqual(problemsOf('{\n  "format": 2,\n  oops\n}'), ['Not valid JSON (line 3).']);
  assert.deepEqual(problemsOf('[]'), ['The file must be one JSON object.']);
});

test('the file level: format, project, exercises and unknown fields', () => {
  assert.deepEqual(problemsOf('{"format": 1, "exercises": [], "extra": 1}'), [
    'extra is not a known field.', 'format must be 2.', 'project is missing.', 'exercises must be a list of 1 to 500 items.',
  ]);
  assert.deepEqual(problemsOf('{"format": 2, "project": {"name": " "}, "exercises": []}'), [
    'project.name must be a non-empty text.', 'exercises must be a list of 1 to 500 items.',
  ]);
});

test('each problem is one line with the exercise number and type', () => {
  const text = fileWith(
    exercise('a', 'choice', { question: 'Q', options: [{ text: 'x', why: 'y' }, { text: 'z', why: 'w' }] }),
    exercise('b', 'flashcard', { front: 'f' }),
    exercise('a', 'flashcard', { front: 'f', back: 'b', colour: 'red' }),
    exercise('Bad Id', 'nope', {}),
    { type: 'write' },
  );
  assert.deepEqual(problemsOf(text), [
    'Exercise 1 (choice, a): content.options: no option is marked correct.',
    'Exercise 2 (flashcard, b): content.back is missing.',
    'Exercise 3 (flashcard, a): content.colour is not a known field.',
    'Exercise 3 (flashcard, a): id "a" is already used by exercise 1.',
    'Exercise 4: type must be one of: rewrite, write, choice, fill, flashcard.',
    'Exercise 4: id may use only a-z, 0-9 and -.',
    'Exercise 5 (write): id is missing.',
    'Exercise 5 (write): content is missing.',
  ]);
});

test('a flashcard explanation is Markdown up to 5,000 characters', () => {
  const card = (explanation: string) => fileWith(exercise('c', 'flashcard', { front: 'f', back: 'b', explanation }));
  assert.equal(problemsOf(card('### Concept\n\n- **be** joins a subject to an adjective')), null);
  assert.deepEqual(problemsOf(card('x'.repeat(5_001))), ['Exercise 1 (flashcard, c): content.explanation is longer than 5000 characters.']);
});

test('a choice needs 2 to 6 options, each with a reason', () => {
  const one = exercise('c', 'choice', { question: 'Q', options: [{ text: 'x', why: 'y', correct: true }] });
  assert.deepEqual(problemsOf(fileWith(one)), ['Exercise 1 (choice, c): content.options must be a list of 2 to 6 items.']);
  const no_reason = exercise('c', 'choice', { question: 'Q', options: [{ text: 'x', correct: true }, { text: 'y' }] });
  assert.deepEqual(problemsOf(fileWith(no_reason)), ['Exercise 1 (choice, c): content.options[0].why is missing.', 'Exercise 1 (choice, c): content.options[1].why is missing.']);
});

test('fill markers match the gaps one to one, in order', () => {
  const gaps = [{ answer: 'a' }, { answer: ['b', 'c'] }];
  assert.equal(problemsOf(fileWith(exercise('f', 'fill', { text: 'A {{1}} B {{2}}.', gaps }))), null);
  assert.deepEqual(problemsOf(fileWith(exercise('f', 'fill', { text: 'A {{1}} B {{3}}.', gaps }))),
    ['Exercise 1 (fill, f): content.text: the markers must be {{1}} to {{2}} in order, one per gap (found {{1}} {{3}}).']);
  assert.deepEqual(problemsOf(fileWith(exercise('f', 'fill', { text: 'No markers.', gaps }))),
    ['Exercise 1 (fill, f): content.text: the markers must be {{1}} to {{2}} in order, one per gap (found none).']);
  assert.deepEqual(problemsOf(fileWith(exercise('f', 'fill', { text: 'A {{1}}.', gaps: [{ answer: [] }] }))), ['Exercise 1 (fill, f): content.gaps[0].answer must be a non-empty text.']);
});

test('each planted mistake appears once in the text', () => {
  const content = { instruction: 'Fix.', length: 'sentence', prefill: true, text: 'Many student like it and student agree.' };
  assert.deepEqual(problemsOf(fileWith(exercise('r', 'rewrite', { ...content, mistakes: [{ wrong: 'student', right: 'students' }, { wrong: 'nowhere', right: 'x' }] }))), [
    'Exercise 1 (rewrite, r): content.mistakes[0].wrong "student" must appear exactly once in text (found 2).',
    'Exercise 1 (rewrite, r): content.mistakes[1].wrong "nowhere" must appear exactly once in text (found 0).',
  ]);
});

test('field kinds, limits and the number of exercises', () => {
  const write = (content: object) => problemsOf(fileWith(exercise('w', 'write', content)));
  assert.deepEqual(write({ prompt: 'P', min_words: 0, minutes: 'x' }), [
    'Exercise 1 (write, w): content.min_words must be a whole number from 1 to 2000.', 'Exercise 1 (write, w): content.minutes must be a whole number from 1 to 180.',
  ]);
  assert.deepEqual(write({ prompt: 'P'.repeat(2_001) }), ['Exercise 1 (write, w): content.prompt is longer than 2000 characters.']);
  assert.deepEqual(problemsOf(fileWith(exercise('r', 'rewrite', { instruction: 'I', text: 'T', length: 'page', constraints: ['a', 'b', 'c', 'd'] }))), [
    'Exercise 1 (rewrite, r): content.length must be one of: sentence, paragraph, essay.', 'Exercise 1 (rewrite, r): content.constraints must be a list of 1 to 3 items.',
  ]);
  assert.deepEqual(problemsOf(fileWith(exercise('t', 'flashcard', { front: 'f', back: 'b' }, { tags: Array(11).fill('x') }))), ['Exercise 1 (flashcard, t): tags must be a list of 0 to 10 items.']);
  const many = Array.from({ length: 501 }, (_, index) => exercise(`k${index}`, 'flashcard', { front: 'f', back: 'b' }));
  assert.deepEqual(problemsOf(fileWith(...many)), ['exercises must be a list of 1 to 500 items.']);
  assert.deepEqual(problemsOf(' '.repeat(2_000_001)), ['The file is larger than 2 MB.']);
});
