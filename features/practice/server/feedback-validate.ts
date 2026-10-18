// Turns the grader's reply into checked Feedback (docs/practice-proposal.md §5.4, §5.5), and computes the fields the
// server derives from it. Derived fields are computed in code, never taken from the model.
import type { ExerciseType, Feedback, FeedbackError } from '../api.ts';
import { isErrorCategory } from '../categories.ts';

const MAX_ERRORS = 40;
const MEANINGS = ['complete', 'minor_loss', 'major_loss'];
const SEVERITIES = ['major', 'minor'];
// The types whose feedback must say how much meaning the translation kept, and give a natural version.
const TRANSLATION_TYPES = new Set<ExerciseType>(['sentence_translation', 'paragraph_translation']);

export type CheckedFeedback = { feedback: Feedback; problems: [] } | { feedback: null; problems: string[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// The JSON object in a reply: the whole reply, or what is inside a code fence, or from the first { to the last }.
// null when none of those parse.
export function extractJson(reply_text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(reply_text);
  const first_brace = reply_text.indexOf('{');
  const last_brace = reply_text.lastIndexOf('}');
  const candidates = [reply_text.trim(), fenced?.[1].trim(), first_brace !== -1 && last_brace > first_brace ? reply_text.slice(first_brace, last_brace + 1) : undefined];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === '') continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isTextList(value: unknown, min_items: number, max_items: number): value is string[] {
  return Array.isArray(value) && value.length >= min_items && value.length <= max_items && value.every(isText);
}

function checkError(error: unknown, index: number, problems: string[]): void {
  const path = `errors[${index}]`;
  if (!isPlainObject(error)) {
    problems.push(`${path} must be an object`);
    return;
  }
  for (const key of ['original', 'explanation', 'rule']) {
    if (!isText(error[key])) problems.push(`${path}.${key} must be a non-empty string`);
  }
  // May be empty: the fix can be a deletion.
  if (typeof error.correction !== 'string') problems.push(`${path}.correction must be a string`);
  if (!isErrorCategory(error.category)) problems.push(`${path}.category is not a known category`);
  if (!SEVERITIES.includes(error.severity as string)) problems.push(`${path}.severity must be major or minor`);
}

// Checks the parsed reply for this exercise type. Unknown extra fields are dropped, not errors: they do no harm.
export function checkFeedback(value: unknown, exercise_type: ExerciseType): CheckedFeedback {
  const problems: string[] = [];
  if (!isPlainObject(value)) return { feedback: null, problems: ['the reply is not a JSON object'] };
  if (value.feedback_version !== 1) problems.push('feedback_version must be 1');
  if (value.categories_version !== 1) problems.push('categories_version must be 1');
  if (!isText(value.summary)) problems.push('summary must be a non-empty string');
  if (!isTextList(value.strengths, 0, 2)) problems.push('strengths must be a list of 0 to 2 strings');
  if (!Array.isArray(value.errors) || value.errors.length > MAX_ERRORS) problems.push(`errors must be a list of at most ${MAX_ERRORS}`);
  else value.errors.forEach((error, index) => checkError(error, index, problems));
  if (!isText(value.corrected_text)) problems.push('corrected_text must be a non-empty string');
  if (!isTextList(value.remember, 1, 3)) problems.push('remember must be a list of 1 to 3 strings');
  if (TRANSLATION_TYPES.has(exercise_type)) {
    if (!MEANINGS.includes(value.meaning as string)) problems.push(`meaning must be one of ${MEANINGS.join(', ')}`);
    if (!isText(value.natural_version)) problems.push('natural_version must be a non-empty string');
  }
  if (problems.length > 0) return { feedback: null, problems };
  const feedback: Feedback = {
    feedback_version: 1,
    categories_version: 1,
    summary: value.summary as string,
    strengths: value.strengths as string[],
    errors: (value.errors as FeedbackError[]).map(({ original, correction, category, severity, explanation, rule }) =>
      ({ original, correction, category, severity, explanation, rule })),
    corrected_text: value.corrected_text as string,
    remember: value.remember as string[],
  };
  if (TRANSLATION_TYPES.has(exercise_type)) {
    feedback.meaning = value.meaning as Feedback['meaning'];
    feedback.natural_version = value.natural_version as string;
  }
  return { feedback, problems: [] };
}

export interface DerivedFields {
  error_count: number;
  major_error_count: number;
}

export function deriveFields(feedback: Feedback): DerivedFields {
  return {
    error_count: feedback.errors.length,
    major_error_count: feedback.errors.filter((error) => error.severity === 'major').length,
  };
}

// Words as IELTS counts them, roughly: runs of non-space characters.
export function countWords(text: string): number {
  const words = text.trim().split(/\s+/);
  return words[0] === '' ? 0 : words.length;
}
