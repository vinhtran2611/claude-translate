// Unsent answers, kept in the browser so a closed tab never loses what you wrote: one Draft per exercise under the key
// practice.draft.{exerciseId} (docs/data-model-proposal.md §3.7), removed once the server has the answer. Another tab may
// change them at any time, so every read checks what it gets. A draft with an unknown schemaVersion is dropped; a draft
// saved before Drafts had one ({ type, answer, saved_at }) is still read.
import type { Timestamp } from '../../../shared/api-types.ts';
import { readStored, removeStored, writeStored } from '../../../shared/web/ui.ts';
import type { Answer } from '../api-types.ts';
import { answerFromFormat3 } from '../format-3.ts';

const PREFIX = 'practice.draft.';
const KEY_PATTERN = /^practice\.draft\.(\d+)$/;

export interface Draft {
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
  is_old_shape: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

const keyOf = (exercise_id: number): string => `${PREFIX}${exercise_id}`;

// Whether `value` has the shape of `model`: an object with the same keys, each holding the same kind of value.
function sameShape(value: unknown, model: object): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const fields = value as Record<string, unknown>;
  const entries = Object.entries(model);
  if (Object.keys(fields).length !== entries.length) return false;
  return entries.every(([key, expected]) => {
    if (!Object.hasOwn(fields, key)) return false;
    const is_same_kind = typeof fields[key] === typeof expected;
    const is_same_array = Array.isArray(fields[key]) === Array.isArray(expected);
    return is_same_kind && is_same_array;
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
    let exercise_version: number | null = null;
    if (typeof stored.exerciseVersion === 'number') exercise_version = stored.exerciseVersion;
    return { exerciseVersion: exercise_version, answer: stored.answer, is_old_shape: false, createdAt: stored.createdAt, updatedAt: stored.updatedAt };
  }
  const is_old_shape = stored.schemaVersion === undefined && typeof stored.saved_at === 'number';
  if (!is_old_shape) return null;
  const saved_at = new Date(stored.saved_at as number).toISOString();
  return { exerciseVersion: null, answer: stored.answer, is_old_shape: true, createdAt: saved_at, updatedAt: saved_at };
}

// The draft of an exercise, if it fits `empty` (an empty answer of the exercise's type); null when there is none or it
// does not fit. is_outdated: the exercise changed after the draft was written.
export function readDraft(exercise_id: number, exercise_version: number, empty: Answer): { answer: Answer; is_outdated: boolean } | null {
  const key = keyOf(exercise_id);
  const stored = readStoredDraft(key);
  if (stored === null) {
    // Something that is not a draft we can read (an unknown schemaVersion, broken JSON) is dropped.
    if (readStored(key) !== null) removeStored(key);
    return null;
  }
  let answer = stored.answer;
  if (stored.is_old_shape) answer = answerFromFormat3(empty.type, stored.answer);
  if (!sameShape(answer, empty)) return null;
  if ((answer as Answer).type !== empty.type) return null;
  const is_outdated = stored.exerciseVersion !== null && stored.exerciseVersion !== exercise_version;
  return { answer: answer as Answer, is_outdated };
}

// Keeps when the draft was first written.
export function writeDraft(exercise_id: number, exercise_version: number, answer: Answer): void {
  const now = new Date().toISOString();
  const earlier = readStoredDraft(keyOf(exercise_id));
  const draft: Draft = {
    schemaVersion: 1,
    exerciseId: exercise_id,
    exerciseVersion: exercise_version,
    answer,
    createdAt: earlier?.createdAt ?? now,
    updatedAt: now,
  };
  writeStored(keyOf(exercise_id), JSON.stringify(draft));
}

export function clearDraft(exercise_id: number): void {
  removeStored(keyOf(exercise_id));
}

// The drafts of these exercises, newest first.
export function listDrafts(exercise_ids: Set<number>): { exerciseId: number; updatedAt: Timestamp }[] {
  const drafts: { exerciseId: number; updatedAt: Timestamp }[] = [];
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const match = KEY_PATTERN.exec(localStorage.key(index) ?? '');
      if (match === null) continue;
      const exercise_id = Number(match[1]);
      if (!exercise_ids.has(exercise_id)) continue;
      const stored = readStoredDraft(match[0]);
      if (stored !== null) drafts.push({ exerciseId: exercise_id, updatedAt: stored.updatedAt });
    }
  } catch {
    // Storage is blocked: there are no drafts to list.
  }
  return drafts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
