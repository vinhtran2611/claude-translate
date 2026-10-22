// The exercise templates' pure parts: nothing here touches the DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { choice } from './choice.ts';
import { fill } from './fill.ts';
import { rewrite } from './rewrite.ts';

test('templates know an empty answer from one worth keeping, and when Submit is allowed', () => {
  const content = { type: 'correction' as const, instruction: 'Fix.', sourceText: 'Many student like it.', length: 'sentence' as const, plantedMistakes: [], constraints: [], modelAnswer: null };
  const correction = { topic: null, tags: [], content };
  assert.deepEqual(rewrite.empty(correction), { type: 'correction', text: 'Many student like it.' });
  assert.equal(rewrite.isBlank(correction, { type: 'correction', text: 'Many student like it.' }), true);
  assert.equal(rewrite.isBlank(correction, { type: 'correction', text: 'Many students like it.' }), false);
  const fresh = { topic: null, tags: [], content: { ...content, type: 'rewrite' as const } };
  assert.deepEqual(rewrite.empty(fresh), { type: 'rewrite', text: '' });
  assert.deepEqual([rewrite.isReady(fresh, { type: 'rewrite', text: ' ' }), rewrite.isReady(fresh, { type: 'rewrite', text: 'x' })], [false, true]);
  const none = { type: 'choice' as const, chosenOptionIndexes: [] };
  const one = { type: 'choice' as const, chosenOptionIndexes: [1] };
  assert.deepEqual([choice.isReady({} as never, none), choice.isReady({} as never, one)], [false, true]);
  const gap_content = { type: 'gap_fill' as const, instruction: null, textWithGaps: '{{1}} {{2}}', gaps: [{ acceptedAnswers: ['a'], hint: null, explanationMarkdown: null }, { acceptedAnswers: ['b'], hint: null, explanationMarkdown: null }] };
  const gaps = { topic: null, tags: [], content: gap_content };
  assert.deepEqual(fill.empty(gaps), { type: 'gap_fill', gapAnswers: ['', ''] });
  const blank = { type: 'gap_fill' as const, gapAnswers: ['', ' '] };
  const typed = { type: 'gap_fill' as const, gapAnswers: ['', 'x'] };
  assert.deepEqual([fill.isReady(gaps, blank), fill.isReady(gaps, typed)], [false, true]);
});
