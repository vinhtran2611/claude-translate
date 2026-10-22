// The pure parts of grading: the answer check, the flashcard rating, and what is sent to the AI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AnswerByType, ExerciseBody } from '../api-types.ts';
import { kindOf, previewOf } from '../text.ts';
import { systemPrompt, userMessageOf } from './ai-grading.ts';
import { checkAnswer, graderOf, rateFlashcard } from './answers.ts';

const body = (type: string, content: object, extra: object = {}) => ({ type, topic: null, tags: [], content, ...extra }) as ExerciseBody;
const single = body('choice', { question: 'Q', options: [{ text: 'a', why: 'x' }, { text: 'b', why: 'y', correct: true }, { text: 'c', why: 'z' }] });
const multi = body('choice', { question: 'Q', options: [{ text: 'a', why: 'x', correct: true }, { text: 'b', why: 'y' }, { text: 'c', why: 'z', correct: true }] });
const fill = body('fill', { text: 'She {{1}} here since {{2}}.', gaps: [{ answer: ['has lived', 'has been living'] }, { answer: '2020' }] });
const rewrite = (extra: object = {}) => body('rewrite', { instruction: 'I', text: 'T', length: 'sentence', ...extra });

test('only a flashcard is not graded by the AI; its result is your rating, said in words', () => {
  assert.deepEqual(['rewrite', 'write', 'choice', 'fill', 'flashcard'].map((type) => graderOf(type as never)), ['ai', 'ai', 'ai', 'ai', 'self']);
  assert.deepEqual(rateFlashcard({ rating: 'almost' }), { result: { rating: 'almost' }, summary: 'Almost' });
  assert.equal(rateFlashcard({ rating: 'unknown' }).summary, 'Didn’t know');
});

test('an answer is checked against its exercise', () => {
  assert.deepEqual(checkAnswer(rewrite(), { text: '  Hello  ' }).answer, { text: 'Hello' });
  assert.notEqual(checkAnswer(rewrite(), { text: '   ' }).problem, null);
  assert.notEqual(checkAnswer(rewrite(), { text: 'x'.repeat(1_001) }).problem, null);
  assert.equal(checkAnswer(rewrite({ length: 'essay' }), { text: 'x'.repeat(1_001) }).problem, null);
  assert.notEqual(checkAnswer(rewrite(), 'text').problem, null);
  assert.deepEqual(checkAnswer(multi, { chosen: [2, 0] }).answer, { chosen: [0, 2] });
  for (const chosen of [[], [3], [0, 0], [-1], ['0'], 'a']) assert.notEqual(checkAnswer(multi, { chosen }).problem, null, JSON.stringify(chosen));
  assert.notEqual(checkAnswer(single, { chosen: [0, 1] }).problem, null);
  assert.deepEqual(checkAnswer(fill, { gaps: [' a ', 'b'] }).answer, { gaps: ['a', 'b'] });
  assert.notEqual(checkAnswer(fill, { gaps: ['a'] }).problem, null);
  assert.notEqual(checkAnswer(body('flashcard', {}), { rating: 'great' }).problem, null);
  assert.notEqual(checkAnswer(body('flashcard', {}), { rating: 'constructor' }).problem, null);
});

test('lists name an exercise by its kind and the words that identify it', () => {
  assert.deepEqual([rewrite(), rewrite({ length: 'essay', source_lang: 'vi' }), rewrite({ prefill: true, length: 'paragraph' }), single, fill].map(kindOf),
    ['Rewrite sentence', 'Translate essay', 'Correct paragraph', 'Multiple choice', 'Fill in the blanks']);
  assert.equal(previewOf(fill), 'She ____ here since ____.');
  assert.equal(previewOf(body('flashcard', { front: 'mitigate', back: 'b' })), 'mitigate');
});

test('the request has the whole exercise, with its right answers, and the answer as a person reads it', () => {
  const message = userMessageOf({ ...single, topic: 'grammar', tags: ['conditionals'] }, { chosen: [0] });
  assert.match(message, /"type": "choice"/);
  assert.match(message, /"topic": "grammar"/);
  assert.match(message, /"correct": true/);
  assert.match(message, /"why": "y"/);
  assert.match(message, /<answer>\nA\. a\n<\/answer>/);
  assert.match(userMessageOf(fill, { gaps: ['has lived', ''] }), /<answer>\nGap 1: has lived\nGap 2: \(blank\)\n<\/answer>/);
  const essay = userMessageOf(body('write', { prompt: 'P', min_words: 250, sample: 'A model answer.' }), { text: 'My essay is short.' });
  assert.match(essay, /"sample": "A model answer\."/);
  assert.match(essay, /<answer word_count="4">\nMy essay is short\.\n<\/answer>/);
  const correction = userMessageOf(rewrite({ prefill: true, mistakes: [{ wrong: 'a', right: 'b' }], reference: 'Ref.', constraints: ['Keep it short'] }), { text: 'Fixed.' });
  assert.match(correction, /"mistakes"/);
  assert.match(correction, /"reference": "Ref\."/);
  assert.match(correction, /"constraints"/);
});

test('one common prompt serves every type, and the request holds each AI-graded type\'s exercise and answer', () => {
  const prompt = systemPrompt();
  assert.equal(prompt, `${readFileSync(new URL('../prompts/grade.md', import.meta.url), 'utf8').trim()}\n`);
  for (const section of ['<role>', '<context>', '<input_handling>', '<how_to_evaluate>', '<output_structure>']) assert.ok(prompt.includes(section), section);
  const cases: [ExerciseBody, AnswerByType[keyof AnswerByType], RegExp[]][] = [
    [rewrite({ reference: 'Ref.' }), { text: 'My rewrite.' }, [/"type": "rewrite"/, /"reference": "Ref\."/, /<answer word_count="2">\nMy rewrite\.\n<\/answer>/]],
    [body('write', { prompt: 'Discuss.', min_words: 250 }), { text: 'An essay.' }, [/"type": "write"/, /"prompt": "Discuss\."/, /<answer word_count="2">\nAn essay\.\n<\/answer>/]],
    [single, { chosen: [0] }, [/"type": "choice"/, /"correct": true/, /<answer>\nA\. a\n<\/answer>/]],
    [fill, { gaps: ['has lived', '2019'] }, [/"type": "fill"/, /"has been living"/, /<answer>\nGap 1: has lived\nGap 2: 2019\n<\/answer>/]],
  ];
  for (const [exercise, answer, patterns] of cases) {
    const message = userMessageOf(exercise, answer);
    assert.ok(message.startsWith('Evaluate this answer.\n\n<exercise>\n'));
    for (const pattern of patterns) assert.match(message, pattern);
  }
});
