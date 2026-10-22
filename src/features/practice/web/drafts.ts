// Unsent answers, kept in the browser so a closed tab never loses what you wrote: one Draft per exercise under the key
// practice.draft.{exerciseId} (docs/data-model-proposal.md §3.7), removed once the server has the answer. Another tab may
// change them at any time, so every read checks what it gets. A draft with an unknown schemaVersion is dropped; a draft
// saved before Drafts had one ({ type, answer, savedAt }) is still read.
import type { Timestamp } from '../../../shared/api-types.ts';
import { readStored, removeStored, writeStored } from '../../../shared/web/ui.ts';
import type { Answer } from '../api-types.ts';
import { answerFromFormat3 } from '../format-3.ts';

const PREFIX = 'practice.draft.';
const KEY_PATTERN = /^practice\.draft\.(\d+)$/;

interface Draft {
  schemaVersion: 1;
  exerciseId: number;
  // The version the answer was written for: the page warns when the exercise changed since.
  exerciseVersion: number;
  answer: Answer;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// What a stored draft holds before its answer is checked against the exercise; null when it is not a draft.
interface StoredDraft {
  // null: saved before drafts had a version, so it is not known.
  exerciseVersion: number | null;
  // As stored: a Draft's answer, or an answer in the shape of format 3 (format-3.ts).
  answer: unknown;
  isOldShape: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

const keyOf = (exerciseId: number): string => `${PREFIX}${exerciseId}`;

// Whether `value` has the shape of `model`: an object with the same keys, each holding the same kind of value.
function sameShape(value: unknown, model: object): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const fields = value as Record<string, unknown>;
  const entries = Object.entries(model);
  if (Object.keys(fields).length !== entries.length) return false;
  return entries.every(([key, expected]) => {
    if (!Object.hasOwn(fields, key)) return false;
    const isSameKind = typeof fields[key] === typeof expected;
    const isSameArray = Array.isArray(fields[key]) === Array.isArray(expected);
    return isSameKind && isSameArray;
  });
}

function parseObject(text: string | null): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text ?? 'null');
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed;
    return null;
  } catch {
    return null;
  }
}

// The draft under a storage key, in either shape; null for anything else (an unknown schemaVersion included).
function readStoredDraft(key: string): StoredDraft | null {
  const stored = parseObject(readStored(key));
  if (stored === null) return null;
  if (stored.schemaVersion === 1) {
    if (typeof stored.updatedAt !== 'string' || typeof stored.createdAt !== 'string') return null;
    let exerciseVersion: number | null = null;
    if (typeof stored.exerciseVersion === 'number') exerciseVersion = stored.exerciseVersion;
    return { exerciseVersion, answer: stored.answer, isOldShape: false, createdAt: stored.createdAt, updatedAt: stored.updatedAt };
  }
  const isOldShape = stored.schemaVersion === undefined && typeof stored.saved_at === 'number';
  if (!isOldShape) return null;
  const savedAt = new Date(stored.saved_at as number).toISOString();
  return { exerciseVersion: null, answer: stored.answer, isOldShape: true, createdAt: savedAt, updatedAt: savedAt };
}

// The draft of an exercise, if it fits `empty` (an empty answer of the exercise's type); null when there is none or it
// does not fit. isOutdated: the exercise changed after the draft was written.
export function readDraft(exerciseId: number, exerciseVersion: number, empty: Answer): { answer: Answer; isOutdated: boolean } | null {
  const key = keyOf(exerciseId);
  const stored = readStoredDraft(key);
  if (stored === null) {
    // Something that is not a draft we can read (an unknown schemaVersion, broken JSON) is dropped.
    if (readStored(key) !== null) removeStored(key);
    return null;
  }
  let answer = stored.answer;
  if (stored.isOldShape) answer = answerFromFormat3(empty.type, stored.answer);
  if (!sameShape(answer, empty)) return null;
  if ((answer as Answer).type !== empty.type) return null;
  const isOutdated = stored.exerciseVersion !== null && stored.exerciseVersion !== exerciseVersion;
  return { answer: answer as Answer, isOutdated };
}

// Keeps when the draft was first written.
export function writeDraft(exerciseId: number, exerciseVersion: number, answer: Answer): void {
  const now = new Date().toISOString();
  const earlier = readStoredDraft(keyOf(exerciseId));
  const draft: Draft = {
    schemaVersion: 1,
    exerciseId,
    exerciseVersion,
    answer,
    createdAt: earlier?.createdAt ?? now,
    updatedAt: now,
  };
  writeStored(keyOf(exerciseId), JSON.stringify(draft));
}

export function clearDraft(exerciseId: number): void {
  removeStored(keyOf(exerciseId));
}

// The drafts of these exercises, newest first.
export function listDrafts(exerciseIds: Set<number>): { exerciseId: number; updatedAt: Timestamp }[] {
  const drafts: { exerciseId: number; updatedAt: Timestamp }[] = [];
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const match = KEY_PATTERN.exec(localStorage.key(index) ?? '');
      if (match === null) continue;
      const exerciseId = Number(match[1]);
      if (!exerciseIds.has(exerciseId)) continue;
      const stored = readStoredDraft(match[0]);
      if (stored !== null) drafts.push({ exerciseId, updatedAt: stored.updatedAt });
    }
  } catch {
    // Storage is blocked: there are no drafts to list.
  }
  return drafts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
