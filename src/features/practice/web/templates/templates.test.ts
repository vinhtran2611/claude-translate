// The exercise templates' pure parts: nothing here touches the DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { choice } from './choice.ts';
import { fill } from './fill.ts';
import { rewrite } from './rewrite.ts';

test('templates know an empty answer from one worth keeping, and when Submit is allowed', () => {
  const edit = { type: 'rewrite' as const, topic: null, tags: [], content: { instruction: 'Fix.', length: 'sentence' as const, prefill: true, text: 'Many student like it.' } };
  assert.deepEqual(rewrite.empty(edit), { text: 'Many student like it.' });
  assert.equal(rewrite.isBlank(edit, { text: 'Many student like it.' }), true);
  assert.equal(rewrite.isBlank(edit, { text: 'Many students like it.' }), false);
  const fresh = { ...edit, content: { ...edit.content, prefill: false } };
  assert.deepEqual([rewrite.empty(fresh), rewrite.isReady(fresh, { text: ' ' }), rewrite.isReady(fresh, { text: 'x' })], [{ text: '' }, false, true]);
  assert.deepEqual([choice.isReady({} as never, { chosen: [] }), choice.isReady({} as never, { chosen: [1] })], [false, true]);
  const gaps = { type: 'fill' as const, topic: null, tags: [], content: { text: '{{1}} {{2}}', gaps: [{ answer: 'a' }, { answer: 'b' }] } };
  assert.deepEqual(fill.empty(gaps), { gaps: ['', ''] });
  assert.deepEqual([fill.isReady(gaps, { gaps: ['', ' '] }), fill.isReady(gaps, { gaps: ['', 'x'] })], [false, true]);
});
