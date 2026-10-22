// The answer drafts kept in localStorage (drafts.ts).
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
