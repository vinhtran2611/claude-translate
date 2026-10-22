// The answer drafts kept in localStorage (drafts.ts): the spec's Draft, drafts saved before it, and what is dropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listDrafts, readDraft, writeDraft } from './drafts.ts';

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
