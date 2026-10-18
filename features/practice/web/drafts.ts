// Unsent answers, kept in the browser so a closed tab never loses what you wrote: one entry per exercise, removed once the
// server has the answer. Another tab may change them at any time, so every read checks what it gets.
import { readStored, removeStored, writeStored } from '../../../shared/web/ui.ts';
import type { AnswerByType, ExerciseType } from '../api.ts';

const PREFIX = 'practice.draft.';
const KEY_PATTERN = /^practice\.draft\.(\d+)$/;

export interface Draft {
  exercise_id: number;
  saved_at: number;
}

const keyOf = (exercise_id: number): string => `${PREFIX}${exercise_id}`;

// Whether `value` has the shape of `model`: an object with the same keys, each holding the same kind of value.
function sameShape(value: unknown, model: object): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const entries = Object.entries(model);
  return Object.keys(value).length === entries.length
    && entries.every(([key, expected]) => Object.hasOwn(value, key) && typeof (value as Record<string, unknown>)[key] === typeof expected
      && Array.isArray((value as Record<string, unknown>)[key]) === Array.isArray(expected));
}

function parse(text: string | null): { type?: unknown; answer?: unknown; saved_at?: unknown } | null {
  try {
    const parsed = JSON.parse(text ?? 'null');
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

// The draft over `empty` (an empty answer of that type), or null when there is none or it does not fit.
export function readDraft<Type extends ExerciseType>(exercise_id: number, type: Type, empty: AnswerByType[Type]): AnswerByType[Type] | null {
  const stored = parse(readStored(keyOf(exercise_id)));
  return stored?.type === type && sameShape(stored.answer, empty) ? stored.answer as AnswerByType[Type] : null;
}

export function writeDraft(exercise_id: number, type: ExerciseType, answer: AnswerByType[ExerciseType]): void {
  writeStored(keyOf(exercise_id), JSON.stringify({ type, answer, saved_at: Date.now() }));
}

export function clearDraft(exercise_id: number): void {
  removeStored(keyOf(exercise_id));
}

// The drafts of these exercises, newest first.
export function listDrafts(exercise_ids: Set<number>): Draft[] {
  const drafts: Draft[] = [];
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const match = KEY_PATTERN.exec(localStorage.key(index) ?? '');
      const exercise_id = Number(match?.[1]);
      const stored = match === null ? null : parse(readStored(match[0]));
      if (exercise_ids.has(exercise_id) && typeof stored?.saved_at === 'number') drafts.push({ exercise_id, saved_at: stored.saved_at });
    }
  } catch {
    // Storage is blocked: there are no drafts to list.
  }
  return drafts.sort((a, b) => b.saved_at - a.saved_at);
}
