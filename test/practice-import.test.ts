// Tests for the exercise file check (features/practice/server/exercise-import.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkExerciseFile, exerciseTitleOf } from '../features/practice/server/exercise-import.ts';

const EXAMPLE_FILE = JSON.parse(readFileSync(new URL('../features/practice/examples/exercises.example.json', import.meta.url), 'utf8'));

const fileWith = (...exercises: unknown[]) => ({ schema_version: 1, exercises });
const sentence = (fields: Record<string, unknown> = {}) => ({ id: 's1', type: 'sentence_translation', text_vi: 'Xin chào.', ...fields });
const paths = (file: unknown) => checkExerciseFile(file).errors.map((error) => error.path);

test('the shipped example file passes with no errors and no warnings', () => {
  const { exercises, errors, warnings } = checkExerciseFile(EXAMPLE_FILE);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.equal(exercises.length, 5);
});

test('file level: wrong schema_version, no exercises, unknown top-level field', () => {
  assert.deepEqual(paths({ schema_version: 2, exercises: [sentence()] }), ['schema_version']);
  assert.deepEqual(paths({ schema_version: 1, exercises: [] }), ['exercises']);
  assert.deepEqual(paths({ schema_version: 1, exercises: [sentence()], extra: true }), ['extra']);
  assert.deepEqual(paths([sentence()]), ['']);
});

test('a missing required field, an empty string and an unknown field are errors with their path', () => {
  assert.deepEqual(paths(fileWith({ id: 's1', type: 'sentence_translation' })), ['exercises[0].text_vi']);
  assert.deepEqual(paths(fileWith(sentence({ text_vi: '   ' }))), ['exercises[0].text_vi']);
  assert.deepEqual(paths(fileWith(sentence({ refrence_en: 'Hello.' }))), ['exercises[0].refrence_en']);
});

test('bad id, duplicate id and unknown type', () => {
  assert.deepEqual(paths(fileWith(sentence({ id: 'S 1' }))), ['exercises[0].id']);
  assert.deepEqual(paths(fileWith(sentence(), sentence())), ['exercises[1].id']);
  assert.deepEqual(paths(fileWith(sentence({ type: 'listening' }))), ['exercises[0].type']);
});

test('text limits and number ranges', () => {
  assert.deepEqual(paths(fileWith(sentence({ text_vi: 'a'.repeat(501) }))), ['exercises[0].text_vi']);
  const free_writing = { id: 'f1', type: 'free_writing', prompt_en: 'Discuss.', essay_type: 'opinion' };
  assert.deepEqual(paths(fileWith(free_writing)), []);
  assert.deepEqual(paths(fileWith({ ...free_writing, min_words: 10 })), ['exercises[0].min_words']);
  assert.deepEqual(paths(fileWith({ ...free_writing, essay_type: 'story' })), ['exercises[0].essay_type']);
});

test('error correction: each wrong must appear exactly once; a corrected_en mismatch is only a warning', () => {
  const correction = (fields: Record<string, unknown>) => ({
    id: 'c1', type: 'error_correction', length: 'sentence', text_en: 'He go to school and he go home.',
    mistakes: [{ wrong: 'He go to', correct: 'He goes to', category: 'subject_verb_agreement' }],
    corrected_en: 'He goes to school and he go home.', ...fields,
  });
  assert.deepEqual(checkExerciseFile(fileWith(correction({}))).errors, []);
  assert.deepEqual(paths(fileWith(correction({ mistakes: [{ wrong: 'go', correct: 'goes', category: 'subject_verb_agreement' }] }))),
    ['exercises[0].mistakes[0].wrong']);
  assert.deepEqual(paths(fileWith(correction({ mistakes: [{ wrong: 'she go', correct: 'she goes', category: 'subject_verb_agreement' }] }))),
    ['exercises[0].mistakes[0].wrong']);
  assert.deepEqual(paths(fileWith(correction({ mistakes: [{ wrong: 'He go to', correct: 'He goes to', category: 'grammar' }] }))),
    ['exercises[0].mistakes[0].category']);
  const { errors, warnings } = checkExerciseFile(fileWith(correction({ corrected_en: 'Something else.' })));
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings.map((warning) => warning.path), ['exercises[0].corrected_en']);
});

test('strings are trimmed and turned into NFC', () => {
  const decomposed = 'Việt Nam'; // "Việt Nam" with combining marks (NFD)
  const { exercises } = checkExerciseFile(fileWith(sentence({ text_vi: `  ${decomposed}  ` })));
  assert.equal((exercises[0] as { text_vi: string }).text_vi, 'Việt Nam'.normalize('NFC'));
  assert.notEqual(decomposed, 'Việt Nam'.normalize('NFC'));
});

test('a title falls back to the start of the main text', () => {
  assert.equal(exerciseTitleOf(sentence() as never), 'Xin chào.');
  assert.equal(exerciseTitleOf(sentence({ title: 'Greeting' }) as never), 'Greeting');
});
