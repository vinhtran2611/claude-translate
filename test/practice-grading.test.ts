// The pure parts of grading: the answer check, the list texts, and what is sent to the AI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Answer, ExerciseContent, ExerciseSnapshot } from '../features/practice/api.ts';
import { systemPrompt, userMessageOf } from '../features/practice/server/ai-grading.ts';
import { checkAnswer, isGradedByAi } from '../features/practice/server/answers.ts';
import { historyLineOf, labelOf, previewOf } from '../features/practice/text.ts';

const snapshotOf = (content: ExerciseContent, topic: string | null = null, tags: string[] = []): ExerciseSnapshot => ({ topic, tags, content });

const SINGLE: ExerciseContent = {
  type: 'choice', instruction: null, question: 'Q', context: null,
  options: [
    { text: 'a', isCorrect: false, explanationMarkdown: 'x' },
    { text: 'b', isCorrect: true, explanationMarkdown: 'y' },
    { text: 'c', isCorrect: false, explanationMarkdown: 'z' },
  ],
};
const MULTI: ExerciseContent = {
  type: 'choice', instruction: null, question: 'Q', context: null,
  options: [
    { text: 'a', isCorrect: true, explanationMarkdown: 'x' },
    { text: 'b', isCorrect: false, explanationMarkdown: 'y' },
    { text: 'c', isCorrect: true, explanationMarkdown: 'z' },
  ],
};
const GAP_FILL: ExerciseContent = {
  type: 'gap_fill', instruction: null, textWithGaps: 'She {{1}} here since {{2}}.',
  gaps: [
    { acceptedAnswers: ['has lived', 'has been living'], hint: null, explanationMarkdown: null },
    { acceptedAnswers: ['2020'], hint: null, explanationMarkdown: null },
  ],
};
const REWRITE: ExerciseContent = { type: 'rewrite', instruction: 'I', sourceText: 'T', length: 'sentence', constraints: [], modelAnswer: 'Ref.' };
const TRANSLATION: ExerciseContent = {
  type: 'translation', instruction: 'I', sourceText: 'Xin chào', sourceLanguage: 'vi', targetLanguage: 'en', length: 'multi_paragraph',
  constraints: [], modelAnswer: null,
};
const CORRECTION: ExerciseContent = {
  type: 'correction', instruction: 'Fix.', sourceText: 'He go.', length: 'paragraph',
  plantedMistakes: [{ wrongText: 'go', correctText: 'goes', explanationMarkdown: null }], constraints: ['Keep it short'], modelAnswer: 'He goes.',
};
const ESSAY: ExerciseContent = { type: 'essay', instruction: 'Discuss.', minWords: 250, suggestedMinutes: null, constraints: [], modelAnswer: 'A model answer.' };
const FLASHCARD: ExerciseContent = { type: 'flashcard', front: 'mitigate', back: 'b', hint: null, example: null, explanationMarkdown: null };

test('only a flashcard is not graded by the AI', () => {
  const types = ['rewrite', 'translation', 'correction', 'essay', 'choice', 'gap_fill', 'flashcard'] as const;
  const graded_by_ai = types.map((type) => isGradedByAi(type));
  assert.deepEqual(graded_by_ai, [true, true, true, true, true, true, false]);
});

test('a text answer is checked against its exercise, and must name its type', () => {
  assert.deepEqual(checkAnswer(REWRITE, { type: 'rewrite', text: '  Hello  ' }).answer, { type: 'rewrite', text: 'Hello' });
  assert.notEqual(checkAnswer(REWRITE, { type: 'rewrite', text: '   ' }).problem, null);
  assert.notEqual(checkAnswer(REWRITE, { type: 'rewrite', text: 'x'.repeat(1_001) }).problem, null);
  assert.equal(checkAnswer(TRANSLATION, { type: 'translation', text: 'x'.repeat(1_001) }).problem, null);
  assert.notEqual(checkAnswer(REWRITE, { text: 'Hello' }).problem, null);
  assert.notEqual(checkAnswer(REWRITE, { type: 'essay', text: 'Hello' }).problem, null);
  assert.notEqual(checkAnswer(REWRITE, 'text').problem, null);
});

test('a choice answer: sorted indexes; exactly one when one option is correct (rule 4)', () => {
  const sorted = checkAnswer(MULTI, { type: 'choice', chosenOptionIndexes: [2, 0] }).answer;
  assert.deepEqual(sorted, { type: 'choice', chosenOptionIndexes: [0, 2] });
  for (const chosen of [[], [3], [0, 0], [-1], ['0'], 'a']) {
    assert.notEqual(checkAnswer(MULTI, { type: 'choice', chosenOptionIndexes: chosen }).problem, null, JSON.stringify(chosen));
  }
  assert.notEqual(checkAnswer(SINGLE, { type: 'choice', chosenOptionIndexes: [0, 1] }).problem, null);
  assert.equal(checkAnswer(SINGLE, { type: 'choice', chosenOptionIndexes: [0] }).problem, null);
});

test('a gap-fill answer has one text per gap (rule 5); a rating is one of three', () => {
  const answer = checkAnswer(GAP_FILL, { type: 'gap_fill', gapAnswers: [' a ', 'b'] }).answer;
  assert.deepEqual(answer, { type: 'gap_fill', gapAnswers: ['a', 'b'] });
  assert.notEqual(checkAnswer(GAP_FILL, { type: 'gap_fill', gapAnswers: ['a'] }).problem, null);
  assert.equal(checkAnswer(FLASHCARD, { type: 'flashcard', rating: 'didnt_know' }).problem, null);
  assert.notEqual(checkAnswer(FLASHCARD, { type: 'flashcard', rating: 'great' }).problem, null);
  assert.notEqual(checkAnswer(FLASHCARD, { type: 'flashcard', rating: 'constructor' }).problem, null);
});

test('lists name an exercise by its label and the words that identify it', () => {
  const labels = [REWRITE, TRANSLATION, CORRECTION, ESSAY, SINGLE, GAP_FILL, FLASHCARD].map(labelOf);
  assert.deepEqual(labels, [
    'Rewrite, sentence', 'Translation, multi-paragraph', 'Correction, paragraph', 'Essay', 'Multiple choice', 'Gap fill', 'Flashcard',
  ]);
  assert.equal(previewOf(GAP_FILL), 'She ____ here since ____.');
  assert.equal(previewOf(FLASHCARD), 'mitigate');
  assert.equal(previewOf(ESSAY), 'Discuss.');
});

test('the history line: a rating in words, or how the latest grading went', () => {
  const card: Answer = { type: 'flashcard', rating: 'didnt_know' };
  const text: Answer = { type: 'rewrite', text: 'x' };
  assert.equal(historyLineOf(card, null), 'Didn’t know');
  assert.equal(historyLineOf(text, 'running'), 'Grading…');
  assert.equal(historyLineOf(text, 'succeeded'), 'Graded');
  assert.equal(historyLineOf(text, 'failed'), 'Not graded');
  assert.equal(historyLineOf(text, 'cancelled'), 'Not graded');
});

test('the request has the whole exercise, with its right answers, and the answer as a person reads it', () => {
  const message = userMessageOf(snapshotOf(SINGLE, 'grammar', ['conditionals']), { type: 'choice', chosenOptionIndexes: [0] });
  assert.match(message, /"type": "choice"/);
  assert.match(message, /"topic": "grammar"/);
  assert.match(message, /"isCorrect": true/);
  assert.match(message, /"explanationMarkdown": "y"/);
  assert.match(message, /<answer>\nA\. a\n<\/answer>/);
  const gaps = userMessageOf(snapshotOf(GAP_FILL), { type: 'gap_fill', gapAnswers: ['has lived', ''] });
  assert.match(gaps, /<answer>\nGap 1: has lived\nGap 2: \(blank\)\n<\/answer>/);
  const essay = userMessageOf(snapshotOf(ESSAY), { type: 'essay', text: 'My essay is short.' });
  assert.match(essay, /"modelAnswer": "A model answer\."/);
  assert.match(essay, /<answer word_count="4">\nMy essay is short\.\n<\/answer>/);
  const correction = userMessageOf(snapshotOf(CORRECTION), { type: 'correction', text: 'He goes.' });
  assert.match(correction, /"plantedMistakes"/);
  assert.match(correction, /"wrongText": "go"/);
  assert.match(correction, /"constraints"/);
});

test('one common prompt serves every type, and names the fields the exercise JSON has', () => {
  const prompt = systemPrompt();
  assert.equal(prompt, `${readFileSync(new URL('../features/practice/prompts/grade.md', import.meta.url), 'utf8').trim()}\n`);
  for (const section of ['<role>', '<context>', '<input_handling>', '<how_to_evaluate>', '<output_structure>']) assert.ok(prompt.includes(section), section);
  for (const field of ['sourceText', 'plantedMistakes', 'modelAnswer', 'isCorrect', 'acceptedAnswers', 'minWords']) assert.ok(prompt.includes(field), field);
  for (const old_name of ['source_lang', 'min_words', 'correct: true', 'content.reference']) assert.ok(!prompt.includes(old_name), old_name);
});
