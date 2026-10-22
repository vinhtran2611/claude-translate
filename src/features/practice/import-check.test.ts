// The import file check (import-check.ts): format 4, format 3 converted to it, and every rule as one clear line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkExerciseInput, checkProjectFile, checkProjectInput, problemLine } from './import-check.ts';

const EXAMPLE = JSON.parse(readFileSync(new URL('./static/example-project.json', import.meta.url), 'utf8'));
const exercise = (key: string, content: object, extra: object = {}) => ({ key, content, ...extra });
const fileWith = (...exercises: object[]) => JSON.stringify({ format: 4, project: { key: 'p', name: 'P' }, exercises });
const format3With = (...exercises: object[]) => JSON.stringify({ format: 3, project: { key: 'p', name: 'P' }, exercises });

// The problems as the page shows them: one line each, or null for a good file.
function problemsOf(text: string): string[] | null {
  const { problems } = checkProjectFile(text);
  if (problems === null) return null;
  let exercises: unknown = null;
  try {
    exercises = JSON.parse(text).exercises;
  } catch {
    // Not JSON: the lines name no exercise.
  }
  return problems.map((problem) => problemLine(problem, exercises));
}

// The checked file of a text that must be valid.
function fileOf(text: string) {
  const { file, problems } = checkProjectFile(text);
  assert.equal(problems, null);
  return file!;
}

const card = (front: string) => ({ type: 'flashcard', front, back: 'b' });

test('the example file is valid and covers all seven types', () => {
  const file = fileOf(JSON.stringify(EXAMPLE));
  assert.equal(file.name, 'IELTS Writing Task 2 – Example');
  const types = [...new Set(file.exercises.map((entry) => entry.content.type))].sort();
  assert.deepEqual(types, ['choice', 'correction', 'essay', 'flashcard', 'gap_fill', 'rewrite', 'translation']);
  assert.equal(file.exercises[0].key, 'ex-01');
  assert.equal(file.exercises[0].topic, 'transport');
  assert.deepEqual(file.exercises[0].tags, []);
});

test('the importer fills every default, so stored content has none', () => {
  const file = fileOf(fileWith(
    exercise('c', card('f')),
    exercise('e', { type: 'essay', instruction: 'Discuss.' }),
    exercise('q', { type: 'choice', question: 'Q', options: [{ text: 'a', isCorrect: true, explanationMarkdown: 'x' }, { text: 'b', explanationMarkdown: 'y' }] }),
  ));
  assert.deepEqual(file.exercises[0], {
    key: 'c', topic: null, tags: [], content: { type: 'flashcard', front: 'f', back: 'b', hint: null, example: null, explanationMarkdown: null },
  });
  assert.deepEqual(file.exercises[1].content, { type: 'essay', instruction: 'Discuss.', minWords: 250, suggestedMinutes: null, constraints: [], modelAnswer: null });
  assert.deepEqual(file.exercises[2].content, {
    type: 'choice', instruction: null, question: 'Q', context: null,
    options: [{ text: 'a', isCorrect: true, explanationMarkdown: 'x' }, { text: 'b', isCorrect: false, explanationMarkdown: 'y' }],
  });
  assert.equal(file.description, null);
});

test('null is the same as left out for an optional field, so an exported file imports again', () => {
  const full = exercise('c', { type: 'flashcard', front: 'f', back: 'b', hint: null, example: null, explanationMarkdown: null }, { topic: null, tags: [] });
  assert.equal(problemsOf(JSON.stringify({ format: 4, project: { key: 'p', name: 'P', description: null }, exercises: [full] })), null);
  assert.deepEqual(problemsOf(fileWith(exercise('c', { type: 'flashcard', front: null, back: 'b' }))), ['Exercise 1 (flashcard, c): content.front must be a non-empty text.']);
});

test('each problem has a JSON Pointer path and a stable code', () => {
  const text = fileWith(
    exercise('a', { type: 'choice', question: 'Q', options: [{ text: 'x', explanationMarkdown: 'y' }, { text: 'z', explanationMarkdown: 'w' }] }),
    exercise('a', { type: 'flashcard', front: ' ', colour: 'red' }),
  );
  assert.deepEqual(checkProjectFile(text).problems?.map(({ path, code }) => [path, code]), [
    ['/exercises/0/content/options', 'no_correct_option'],
    ['/exercises/1/content/colour', 'unknown_field'],
    ['/exercises/1/content/front', 'empty'],
    ['/exercises/1/content/back', 'required'],
    ['/exercises/1/key', 'duplicate_key'],
  ]);
  const top = checkProjectFile('{"format": 1, "project": {"key": "-p", "name": "P", "x/y": 1}, "exercises": []}').problems;
  assert.deepEqual(top?.map(({ path, code }) => [path, code]), [
    ['/format', 'unsupported_format'], ['/project/x~1y', 'unknown_field'], ['/project/key', 'bad_key'], ['/exercises', 'too_few'],
  ]);
});

test('text that is not JSON says where', () => {
  assert.deepEqual(problemsOf('{\n  "format": 4,\n  oops\n}'), ['Not valid JSON (line 3).']);
  assert.deepEqual(problemsOf('[]'), ['The file must be one JSON object.']);
});

test('the file level: format, project, exercises and unknown fields', () => {
  assert.deepEqual(problemsOf('{"format": 1, "exercises": [], "extra": 1}'), [
    'extra is not a known field.', 'format must be 4 (format 3 is still read).', 'project is missing.', 'exercises must be a list of 1 to 500 items.',
  ]);
  assert.deepEqual(problemsOf('{"format": 4, "project": {"name": " "}, "exercises": []}'), [
    'project.key is missing.', 'project.name must be a non-empty text.', 'exercises must be a list of 1 to 500 items.',
  ]);
});

test('a format 2 file is refused with the edits that make it format 3', () => {
  const old = JSON.stringify({ format: 2, project: { name: 'P' }, exercises: [{ id: 'a', type: 'flashcard', content: { front: 'f', back: 'b' } }] });
  const [format] = checkProjectFile(old).problems!;
  assert.equal(format.code, 'unsupported_format');
  assert.match(format.message, /add a "key" to "project".*rename each exercise's "id" to "key"/);
});

test('each problem is one line with the exercise number and type', () => {
  const text = fileWith(
    exercise('a', { type: 'choice', question: 'Q', options: [{ text: 'x', explanationMarkdown: 'y' }, { text: 'z', explanationMarkdown: 'w' }] }),
    exercise('b', { type: 'flashcard', front: 'f' }),
    exercise('a', { ...card('f'), colour: 'red' }),
    exercise('Bad Id', { type: 'nope' }),
    { type: 'essay' },
  );
  assert.deepEqual(problemsOf(text), [
    'Exercise 1 (choice, a): content.options: no option is marked correct.',
    'Exercise 2 (flashcard, b): content.back is missing.',
    'Exercise 3 (flashcard, a): content.colour is not a known field.',
    'Exercise 3 (flashcard, a): key "a" is already used by exercise 1.',
    'Exercise 4: key must be 1 to 64 of a-z, 0-9 and -, not starting with -.',
    'Exercise 4: content.type must be one of: rewrite, translation, correction, essay, choice, gap_fill, flashcard.',
    'Exercise 5 (essay): type is not a known field.',
    'Exercise 5 (essay): key is missing.',
    'Exercise 5 (essay): content is missing.',
  ]);
});

test('the rules a field list cannot say (spec 3.9): languages differ, mistakes appear once, markers match the gaps', () => {
  const translation = { type: 'translation', instruction: 'T', sourceText: 'Xin chào', sourceLanguage: 'vi', targetLanguage: 'vi', length: 'sentence' };
  assert.deepEqual(problemsOf(fileWith(exercise('t', translation))), ['Exercise 1 (translation, t): content.targetLanguage must not be the same as sourceLanguage.']);

  const correction = {
    type: 'correction', instruction: 'Fix.', length: 'sentence', sourceText: 'Many student like it and student agree.',
    plantedMistakes: [{ wrongText: 'student', correctText: 'students' }, { wrongText: 'nowhere', correctText: 'x' }],
  };
  assert.deepEqual(problemsOf(fileWith(exercise('r', correction))), [
    'Exercise 1 (correction, r): content.plantedMistakes[0].wrongText "student" must appear exactly once in sourceText (found 2).',
    'Exercise 1 (correction, r): content.plantedMistakes[1].wrongText "nowhere" must appear exactly once in sourceText (found 0).',
  ]);

  const gaps = [{ acceptedAnswers: ['a'] }, { acceptedAnswers: ['b', 'c'] }];
  const gapFill = (textWithGaps: string, gap_list: object[] = gaps) => fileWith(exercise('f', { type: 'gap_fill', textWithGaps, gaps: gap_list }));
  assert.equal(problemsOf(gapFill('A {{1}} B {{2}}.')), null);
  assert.deepEqual(problemsOf(gapFill('A {{1}} B {{3}}.')),
    ['Exercise 1 (gap_fill, f): content.textWithGaps: the markers must be {{1}} to {{2}} in order, one per gap (found {{1}} {{3}}).']);
  assert.deepEqual(problemsOf(gapFill('A {{1}}.', [{ acceptedAnswers: [] }])),
    ['Exercise 1 (gap_fill, f): content.gaps[0].acceptedAnswers must be a list of 1 to 10 items.']);
});

test('field kinds, limits and the number of exercises', () => {
  const essay = (content: object) => problemsOf(fileWith(exercise('w', { type: 'essay', ...content })));
  assert.deepEqual(essay({ instruction: 'P', minWords: 0, suggestedMinutes: 'x' }), [
    'Exercise 1 (essay, w): content.minWords must be a whole number from 1 to 2000.',
    'Exercise 1 (essay, w): content.suggestedMinutes must be a whole number from 1 to 180.',
  ]);
  const rewrite = { type: 'rewrite', instruction: 'I', sourceText: 'T', length: 'essay', constraints: ['a', 'b', 'c', 'd'] };
  assert.deepEqual(problemsOf(fileWith(exercise('r', rewrite))), [
    'Exercise 1 (rewrite, r): content.length must be one of: sentence, paragraph, multi_paragraph.',
    'Exercise 1 (rewrite, r): content.constraints must be a list of 0 to 3 items.',
  ]);
  assert.deepEqual(problemsOf(fileWith(exercise('t', card('f'), { tags: Array(11).fill('x') }))), ['Exercise 1 (flashcard, t): tags must be a list of 0 to 10 items.']);
  const many = Array.from({ length: 501 }, (_, index) => exercise(`k${index}`, card('f')));
  assert.deepEqual(problemsOf(fileWith(...many)), ['exercises must be a list of 1 to 500 items.']);
  assert.deepEqual(problemsOf(' '.repeat(2_000_001)), ['The file is larger than 2 MB.']);
});

test('a format 3 file is still read, and converted the way the spec maps it (section 5)', () => {
  const file = fileOf(format3With(
    { key: 'r', type: 'rewrite', content: { instruction: 'I', text: 'T', length: 'essay', reference: 'R' } },
    { key: 't', type: 'rewrite', content: { instruction: 'I', text: 'Xin chào', length: 'sentence', source_lang: 'vi' } },
    { key: 'c', type: 'rewrite', content: { instruction: 'Fix.', text: 'He go.', length: 'sentence', prefill: true, mistakes: [{ wrong: 'go', right: 'goes', note: 'Agreement.' }] } },
    { key: 'w', type: 'write', topic: 'transport', content: { prompt: 'Discuss.', minutes: 40, sample: 'S' } },
    { key: 'q', type: 'choice', content: { question: 'Q', options: [{ text: 'a', why: 'x', correct: true }, { text: 'b', why: 'y' }] } },
    { key: 'f', type: 'fill', content: { text: 'A {{1}} {{2}}', gaps: [{ answer: 'x' }, { answer: ['y', 'z'], why: 'w' }] } },
    { key: 'k', type: 'flashcard', content: { front: 'f', back: 'b', explanation: 'E' } },
  ));
  const contents = file.exercises.map((entry) => entry.content);
  assert.deepEqual(contents[0], { type: 'rewrite', instruction: 'I', sourceText: 'T', length: 'multi_paragraph', constraints: [], modelAnswer: 'R' });
  assert.deepEqual(contents[1], {
    type: 'translation', instruction: 'I', sourceText: 'Xin chào', sourceLanguage: 'vi', targetLanguage: 'en', length: 'sentence', constraints: [], modelAnswer: null,
  });
  assert.deepEqual(contents[2], {
    type: 'correction', instruction: 'Fix.', sourceText: 'He go.', length: 'sentence',
    plantedMistakes: [{ wrongText: 'go', correctText: 'goes', explanationMarkdown: 'Agreement.' }], constraints: [], modelAnswer: null,
  });
  assert.deepEqual(contents[3], { type: 'essay', instruction: 'Discuss.', minWords: 250, suggestedMinutes: 40, constraints: [], modelAnswer: 'S' });
  assert.equal(file.exercises[3].topic, 'transport');
  assert.deepEqual(contents[4], {
    type: 'choice', instruction: null, question: 'Q', context: null,
    options: [{ text: 'a', isCorrect: true, explanationMarkdown: 'x' }, { text: 'b', isCorrect: false, explanationMarkdown: 'y' }],
  });
  assert.deepEqual(contents[5], {
    type: 'gap_fill', instruction: null, textWithGaps: 'A {{1}} {{2}}',
    gaps: [{ acceptedAnswers: ['x'], hint: null, explanationMarkdown: null }, { acceptedAnswers: ['y', 'z'], hint: null, explanationMarkdown: 'w' }],
  });
  assert.deepEqual(contents[6], { type: 'flashcard', front: 'f', back: 'b', hint: null, example: null, explanationMarkdown: 'E' });
});

test('a format 3 file is checked by the format 3 rules', () => {
  const choice = { key: 'a', type: 'choice', content: { question: 'Q', options: [{ text: 'x', why: 'y' }, { text: 'z', why: 'w' }] } };
  assert.deepEqual(problemsOf(format3With(choice)), ['Exercise 1 (choice, a): content.options: no option is marked correct.']);
  const fill = { key: 'f', type: 'fill', content: { text: 'No markers.', gaps: [{ answer: 'a' }] } };
  assert.deepEqual(problemsOf(format3With(fill)), ['Exercise 1 (fill, f): content.text: the markers must be {{1}} to {{1}} in order, one per gap (found none).']);
});

test('a PUT body is one format 4 exercise; a project body takes archivedAt as a time or null', () => {
  const { exercise: body } = checkExerciseInput({ content: card('f') }, 'c1');
  assert.equal(body?.content.type, 'flashcard');
  assert.deepEqual(checkExerciseInput({ key: 'c2', content: card('f') }, 'c1').problems?.map((problem) => problem.code), ['key_mismatch']);

  assert.deepEqual(checkProjectInput({ name: ' Week ' }).project, { name: 'Week', description: null, archivedAt: null });
  const archived = checkProjectInput({ name: 'W', description: 'D', archivedAt: '2026-10-21T08:30:00.000Z' }).project;
  assert.deepEqual(archived, { name: 'W', description: 'D', archivedAt: '2026-10-21T08:30:00.000Z' });
  assert.deepEqual(checkProjectInput({ name: 'W', archivedAt: true }).problems?.map((problem) => problem.path), ['/archivedAt']);
});
