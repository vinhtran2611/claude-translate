// The page's pure helpers (features/practice/web/): nothing here touches the DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { listDrafts, readDraft, writeDraft } from '../features/practice/web/drafts.ts';
import { formatClock, pluralize, relativeDay, typeMix } from '../features/practice/web/format.ts';
import { choice } from '../features/practice/web/templates/choice.ts';
import { fill } from '../features/practice/web/templates/fill.ts';
import { rewrite } from '../features/practice/web/templates/rewrite.ts';

// localStorage for the drafts, which read it as a global.
const storage = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    get length() { return storage.size; },
    key: (index: number) => [...storage.keys()][index] ?? null,
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  },
});

test('small formats: counts, the type mix, the clock, the day', () => {
  assert.equal(pluralize(1, 'exercise'), '1 exercise');
  assert.equal(pluralize(0, 'exercise'), '0 exercises');
  assert.equal(typeMix({ flashcard: 3, rewrite: 5, choice: 4 }), 'Rewrite 5 · Choice 4 · Flashcard 3');
  assert.equal(typeMix({ choice: 2, rewrite: 2 }), 'Rewrite 2 · Choice 2');
  assert.equal(formatClock(75_000), '1:15');
  const now = new Date(2026, 9, 18, 9, 0);
  assert.equal(relativeDay(new Date(2026, 9, 18, 0, 5).toISOString(), now), 'today');
  assert.equal(relativeDay(new Date(2026, 9, 17, 23, 59).toISOString(), now), 'yesterday');
  assert.equal(relativeDay(new Date(2026, 9, 15, 12, 0).toISOString(), now), '3 days ago');
  assert.match(relativeDay(new Date(2026, 8, 4, 12, 0).toISOString(), now), /^on 4 Sep/);
});

test('a draft comes back only for the same type and shape, and is listed newest first', () => {
  const empty = { text: '' };
  writeDraft(1, 'rewrite', { text: 'one' });
  writeDraft(2, 'rewrite', { text: 'two' });
  assert.deepEqual(readDraft(1, 'rewrite', empty), { text: 'one' });
  assert.equal(readDraft(1, 'write', empty), null);
  assert.equal(readDraft(3, 'rewrite', empty), null);
  storage.set('practice.draft.4', '{"type":"rewrite","answer":{"text":5},"saved_at":1}');
  storage.set('practice.draft.5', 'not json');
  assert.equal(readDraft(4, 'rewrite', empty), null);
  assert.equal(readDraft(5, 'rewrite', empty), null);
  storage.set('other.key', 'x');
  assert.deepEqual(listDrafts(new Set([1, 2, 4, 5, 9])).map((draft) => draft.exercise_id).sort(), [1, 2, 4]);
  storage.clear();
});

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

test('the two dark colour blocks of base.css say the same', () => {
  const css = readFileSync(new URL('../shared/web/base.css', import.meta.url), 'utf8');
  const blockOf = (opening: string) => {
    const start = css.indexOf(opening) + opening.length;
    return css.slice(start, css.indexOf('}', start)).trim().replace(/\s+/g, ' ');
  };
  const by_system = blockOf(':root:not([data-theme="light"]) {');
  assert.ok(by_system.length > 200);
  assert.equal(blockOf(':root[data-theme="dark"] {'), by_system);
});
