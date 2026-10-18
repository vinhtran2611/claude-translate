// Turns the grader's reply into checked Feedback (docs/practice-proposal.md §5.4, §5.5), and computes the fields the
// server derives from it. Derived fields are computed in code, never taken from the model.
import type { Bands, Criterion, ExerciseType, Feedback, FeedbackError } from '../api.ts';
import { isErrorCategory } from '../categories.ts';

const MAX_ERRORS = 40;
const MEANINGS = ['complete', 'minor_loss', 'major_loss'];
const SEVERITIES = ['major', 'minor'];
const PARTS = ['prompt', 'essay'];
// The types whose feedback must say how much meaning the translation kept.
const TRANSLATION_TYPES = new Set<ExerciseType>(['sentence_translation', 'paragraph_translation', 'essay_translation']);
// The types whose feedback gives a natural version of the whole answer.
const NATURAL_VERSION_TYPES = new Set<ExerciseType>(['sentence_translation', 'paragraph_translation']);
// The band criteria each type is scored on. Essay translation leaves out Task Response and Coherence and Cohesion:
// the ideas and structure come from the Vietnamese sample, not from you.
const BAND_CRITERIA: Partial<Record<ExerciseType, (keyof Bands)[]>> = {
  essay_translation: ['lexical_resource', 'grammatical_range_accuracy'],
  free_writing: ['task_response', 'coherence_cohesion', 'lexical_resource', 'grammatical_range_accuracy'],
};

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

function checkError(error: unknown, index: number, exercise_type: ExerciseType, problems: string[]): void {
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
  if (exercise_type === 'essay_translation' && !PARTS.includes(error.part as string)) problems.push(`${path}.part must be prompt or essay`);
}

function isBand(value: unknown): value is number {
  return typeof value === 'number' && value >= 0 && value <= 9 && Number.isInteger(value * 2);
}

function checkBands(value: unknown, criteria: (keyof Bands)[], problems: string[]): void {
  if (!isPlainObject(value)) {
    problems.push('bands must be an object');
    return;
  }
  for (const criterion of criteria) {
    const entry = value[criterion];
    if (!isPlainObject(entry)) {
      problems.push(`bands.${criterion} is required`);
      continue;
    }
    if (!isBand(entry.band)) problems.push(`bands.${criterion}.band must be 0 to 9 in steps of 0.5`);
    if (!isText(entry.comment)) problems.push(`bands.${criterion}.comment must be a non-empty string`);
    if (!isText(entry.next_step)) problems.push(`bands.${criterion}.next_step must be a non-empty string`);
  }
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
  else value.errors.forEach((error, index) => checkError(error, index, exercise_type, problems));
  if (!isText(value.corrected_text)) problems.push('corrected_text must be a non-empty string');
  if (!isTextList(value.remember, 1, 3)) problems.push('remember must be a list of 1 to 3 strings');
  if (TRANSLATION_TYPES.has(exercise_type) && !MEANINGS.includes(value.meaning as string)) problems.push(`meaning must be one of ${MEANINGS.join(', ')}`);
  if (NATURAL_VERSION_TYPES.has(exercise_type) && !isText(value.natural_version)) problems.push('natural_version must be a non-empty string');
  if (exercise_type === 'essay_translation' && !isText(value.corrected_prompt_text)) problems.push('corrected_prompt_text must be a non-empty string');
  const criteria = BAND_CRITERIA[exercise_type];
  if (criteria !== undefined) checkBands(value.bands, criteria, problems);
  if (problems.length > 0) return { feedback: null, problems };
  const feedback: Feedback = {
    feedback_version: 1,
    categories_version: 1,
    summary: value.summary as string,
    strengths: value.strengths as string[],
    errors: (value.errors as FeedbackError[]).map(({ part, original, correction, category, severity, explanation, rule }) =>
      (exercise_type === 'essay_translation' ? { part, original, correction, category, severity, explanation, rule }
        : { original, correction, category, severity, explanation, rule })),
    corrected_text: value.corrected_text as string,
    remember: value.remember as string[],
  };
  if (TRANSLATION_TYPES.has(exercise_type)) feedback.meaning = value.meaning as Feedback['meaning'];
  if (NATURAL_VERSION_TYPES.has(exercise_type)) feedback.natural_version = value.natural_version as string;
  if (exercise_type === 'essay_translation') feedback.corrected_prompt_text = value.corrected_prompt_text as string;
  if (criteria !== undefined) {
    const raw_bands = value.bands as Record<string, Criterion>;
    feedback.bands = Object.fromEntries(criteria.map((criterion) => {
      const { band, comment, next_step } = raw_bands[criterion];
      return [criterion, { band, comment, next_step }];
    })) as unknown as Bands;
  }
  return { feedback, problems: [] };
}

export interface DerivedFields {
  error_count: number;
  major_error_count: number;
  // Free writing only (all 4 criteria); null otherwise.
  overall_band: number | null;
}

// IELTS publishes no exact rule for one task, so the mean of the 4 criteria is rounded down to 0.5: the safe side
// for a learner.
export function overallBandOf(bands: Bands | undefined): number | null {
  if (bands?.task_response === undefined || bands.coherence_cohesion === undefined) return null;
  const mean = (bands.task_response.band + bands.coherence_cohesion.band + bands.lexical_resource.band + bands.grammatical_range_accuracy.band) / 4;
  return Math.floor(mean * 2) / 2;
}

export function deriveFields(feedback: Feedback): DerivedFields {
  return {
    error_count: feedback.errors.length,
    major_error_count: feedback.errors.filter((error) => error.severity === 'major').length,
    overall_band: overallBandOf(feedback.bands),
  };
}

// Words as IELTS counts them, roughly: runs of non-space characters.
export function countWords(text: string): number {
  const words = text.trim().split(/\s+/);
  return words[0] === '' ? 0 : words.length;
}
