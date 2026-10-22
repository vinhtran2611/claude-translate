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
  assert.equal(typeMix({ gap_fill: 1, essay: 1 }), 'Essay 1 · Gap fill 1');
  assert.equal(formatClock(75_000), '1:15');
  const now = new Date(2026, 9, 18, 9, 0);
  assert.equal(relativeDay(new Date(2026, 9, 18, 0, 5).toISOString(), now), 'today');
  assert.equal(relativeDay(new Date(2026, 9, 17, 23, 59).toISOString(), now), 'yesterday');
  assert.equal(relativeDay(new Date(2026, 9, 15, 12, 0).toISOString(), now), '3 days ago');
  assert.match(relativeDay(new Date(2026, 8, 4, 12, 0).toISOString(), now), /^on 4 Sep/);
});

test('a draft is stored with its schema version, and comes back only for the same type and shape', () => {
  const empty = { type: 'rewrite' as const, text: '' };
  writeDraft(1, 3, { type: 'rewrite', text: 'one' });
  const stored = JSON.parse(storage.get('practice.draft.1')!);
  assert.equal(stored.schemaVersion, 1);
  assert.equal(stored.exerciseId, 1);
  assert.equal(stored.exerciseVersion, 3);
  assert.match(stored.createdAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.deepEqual(readDraft(1, 3, empty), { answer: { type: 'rewrite', text: 'one' }, is_outdated: false });
  assert.equal(readDraft(1, 3, { type: 'essay', text: '' }), null);
  assert.equal(readDraft(3, 1, empty), null);
  storage.clear();
});

test('a draft written for an older version of the exercise says so; writing again keeps its createdAt', () => {
  writeDraft(1, 1, { type: 'essay', text: 'first' });
  const created_at = JSON.parse(storage.get('practice.draft.1')!).createdAt;
  writeDraft(1, 1, { type: 'essay', text: 'second' });
  assert.equal(JSON.parse(storage.get('practice.draft.1')!).createdAt, created_at);
  assert.equal(readDraft(1, 2, { type: 'essay', text: '' })?.is_outdated, true);
  storage.clear();
});

test('a draft saved before drafts had a version is read; an unknown version or broken one is dropped', () => {
  storage.set('practice.draft.4', '{"type":"rewrite","answer":{"chosen":[2]},"saved_at":1760000000000}');
  assert.deepEqual(readDraft(4, 1, { type: 'choice', chosenOptionIndexes: [] }), { answer: { type: 'choice', chosenOptionIndexes: [2] }, is_outdated: false });
  storage.set('practice.draft.5', '{"schemaVersion":2,"answer":{}}');
  storage.set('practice.draft.6', 'not json');
  storage.set('practice.draft.7', '{"type":"rewrite","answer":{"text":5},"saved_at":1}');
  assert.equal(readDraft(5, 1, { type: 'rewrite', text: '' }), null);
  assert.equal(readDraft(6, 1, { type: 'rewrite', text: '' }), null);
  assert.equal(readDraft(7, 1, { type: 'rewrite', text: '' }), null);
  assert.equal(storage.has('practice.draft.5'), false);
  assert.equal(storage.has('practice.draft.6'), false);
  storage.clear();
});

test('drafts are listed newest first, only for the exercises asked about', () => {
  storage.set('practice.draft.1', JSON.stringify({ schemaVersion: 1, exerciseId: 1, exerciseVersion: 1, answer: {}, createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z' }));
  storage.set('practice.draft.2', JSON.stringify({ schemaVersion: 1, exerciseId: 2, exerciseVersion: 1, answer: {}, createdAt: '2026-10-21T00:00:00.000Z', updatedAt: '2026-10-21T00:00:00.000Z' }));
  storage.set('practice.draft.4', '{"type":"rewrite","answer":{"text":"x"},"saved_at":1}');
  storage.set('practice.draft.5', 'not json');
  storage.set('other.key', 'x');
  const listed = listDrafts(new Set([1, 2, 4, 5, 9])).map((draft) => draft.exerciseId);
  assert.deepEqual(listed, [2, 1, 4]);
  storage.clear();
});

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
