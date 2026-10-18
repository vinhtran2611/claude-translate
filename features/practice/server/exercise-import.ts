// Checks an exercise file (docs/practice-proposal.md §4.2) and returns its exercises normalized: every string trimmed
// and in Unicode NFC. Plain TypeScript, no schema library. Strict on purpose: an unknown field is an error, so a typo
// in an optional field is never dropped silently.
import type { Exercise, ExerciseType, ImportProblem } from '../api.ts';
import { ERROR_CATEGORIES } from '../categories.ts';

export const MAX_IMPORT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_EXERCISES_PER_FILE = 500;
const MAX_MISTAKES = 40;
const MAX_FOCUS_ITEMS = 10;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
// Arbitrary: room for a long text of each size, small enough to catch a field pasted into the wrong place.
const SENTENCE_MAX_CHARS = 500;
const PARAGRAPH_MAX_CHARS = 3_000;
const ESSAY_MAX_CHARS = 15_000;
const LENGTH_MAX_CHARS = { sentence: SENTENCE_MAX_CHARS, paragraph: PARAGRAPH_MAX_CHARS, essay: ESSAY_MAX_CHARS };

type FieldSpec =
  | { kind: 'text'; is_required: boolean; max_chars: number }
  | { kind: 'text_list'; is_required: boolean; max_chars: number; max_items: number }
  | { kind: 'choice'; is_required: boolean; values: readonly string[] }
  | { kind: 'integer'; is_required: boolean; min: number; max: number }
  | { kind: 'mistakes'; is_required: boolean };

const text = (max_chars: number, is_required = true): FieldSpec => ({ kind: 'text', is_required, max_chars });

const COMMON_FIELDS: Record<string, FieldSpec> = {
  title: text(200, false),
  topic: text(100, false),
  focus: { kind: 'text_list', is_required: false, max_chars: 100, max_items: MAX_FOCUS_ITEMS },
};

// error_correction's text limits depend on its length, so they are checked after the fields.
const TYPE_FIELDS: Record<ExerciseType, Record<string, FieldSpec>> = {
  sentence_translation: { text_vi: text(SENTENCE_MAX_CHARS), reference_en: text(SENTENCE_MAX_CHARS, false) },
  paragraph_translation: { text_vi: text(PARAGRAPH_MAX_CHARS), reference_en: text(PARAGRAPH_MAX_CHARS, false) },
  essay_translation: {
    prompt_vi: text(PARAGRAPH_MAX_CHARS), essay_vi: text(ESSAY_MAX_CHARS),
    reference_prompt_en: text(PARAGRAPH_MAX_CHARS, false), reference_essay_en: text(ESSAY_MAX_CHARS, false),
  },
  free_writing: {
    prompt_en: text(PARAGRAPH_MAX_CHARS),
    essay_type: { kind: 'choice', is_required: true, values: ['opinion', 'discussion', 'advantages_disadvantages', 'problem_solution', 'two_part'] },
    min_words: { kind: 'integer', is_required: false, min: 50, max: 400 },
    time_limit_minutes: { kind: 'integer', is_required: false, min: 5, max: 90 },
    sample_essay_en: text(ESSAY_MAX_CHARS, false),
  },
  error_correction: {
    length: { kind: 'choice', is_required: true, values: ['sentence', 'paragraph', 'essay'] },
    text_en: text(ESSAY_MAX_CHARS), mistakes: { kind: 'mistakes', is_required: true }, corrected_en: text(ESSAY_MAX_CHARS),
  },
};
const EXERCISE_TYPES = Object.keys(TYPE_FIELDS);
const MISTAKE_FIELDS: Record<string, FieldSpec> = {
  wrong: text(200),
  // May be empty: the fix can be a deletion.
  correct: text(200, false),
  category: { kind: 'choice', is_required: true, values: Object.keys(ERROR_CATEGORIES) },
  note: text(300, false),
};

export interface CheckedFile {
  // Normalized; empty when errors is not.
  exercises: Exercise[];
  errors: ImportProblem[];
  warnings: ImportProblem[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Trims and NFC-normalizes every string. Vietnamese pasted from some tools is NFD (decomposed diacritics); without
// this the same letters could be stored two ways.
function normalize(value: unknown): unknown {
  if (typeof value === 'string') return value.trim().normalize('NFC');
  if (Array.isArray(value)) return value.map(normalize);
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, normalize(field)]));
  return value;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let index = haystack.indexOf(needle); index !== -1; index = haystack.indexOf(needle, index + needle.length)) count += 1;
  return count;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

// Adds a problem for each field of object that breaks its spec, or that specs does not name.
function checkFields(object: Record<string, unknown>, specs: Record<string, FieldSpec>, path: string, errors: ImportProblem[]): void {
  for (const key of Object.keys(object)) {
    if (!Object.hasOwn(specs, key)) errors.push({ path: `${path}.${key}`, message: 'unknown field' });
  }
  for (const [key, spec] of Object.entries(specs)) {
    const field_path = `${path}.${key}`;
    const value = object[key];
    if (value === undefined) {
      if (spec.is_required) errors.push({ path: field_path, message: 'required' });
      continue;
    }
    if (spec.kind === 'text') {
      if (typeof value !== 'string') errors.push({ path: field_path, message: 'must be a string' });
      else if (value === '' && (spec.is_required || key !== 'correct')) errors.push({ path: field_path, message: 'must not be empty' });
      else if (value.length > spec.max_chars) errors.push({ path: field_path, message: `at most ${spec.max_chars} characters (has ${value.length})` });
    } else if (spec.kind === 'text_list') {
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item === '')) {
        errors.push({ path: field_path, message: 'must be a list of non-empty strings' });
      } else if (value.length > spec.max_items) {
        errors.push({ path: field_path, message: `at most ${spec.max_items} items` });
      } else if (value.some((item: string) => item.length > spec.max_chars)) {
        errors.push({ path: field_path, message: `each item at most ${spec.max_chars} characters` });
      }
    } else if (spec.kind === 'choice') {
      if (typeof value !== 'string' || !spec.values.includes(value)) errors.push({ path: field_path, message: `must be one of: ${spec.values.join(', ')}` });
    } else if (spec.kind === 'integer') {
      if (!Number.isInteger(value) || (value as number) < spec.min || (value as number) > spec.max) {
        errors.push({ path: field_path, message: `must be a whole number from ${spec.min} to ${spec.max}` });
      }
    } else if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MISTAKES) {
      errors.push({ path: field_path, message: `must be a list of 1 to ${MAX_MISTAKES} mistakes` });
    } else {
      value.forEach((mistake, index) => {
        if (isPlainObject(mistake)) checkFields(mistake, MISTAKE_FIELDS, `${field_path}[${index}]`, errors);
        else errors.push({ path: `${field_path}[${index}]`, message: 'must be an object' });
      });
    }
  }
}

// The checks that need several fields of an error_correction that passed checkFields.
function checkErrorCorrection(exercise: Record<string, any>, path: string, errors: ImportProblem[], warnings: ImportProblem[]): void {
  const max_chars = LENGTH_MAX_CHARS[exercise.length as keyof typeof LENGTH_MAX_CHARS];
  for (const key of ['text_en', 'corrected_en']) {
    if (exercise[key].length > max_chars) errors.push({ path: `${path}.${key}`, message: `at most ${max_chars} characters for length "${exercise.length}"` });
  }
  let corrected_text: string = exercise.text_en;
  exercise.mistakes.forEach((mistake: { wrong: string; correct?: string }, index: number) => {
    const occurrence_count = countOccurrences(exercise.text_en, mistake.wrong);
    if (occurrence_count !== 1) {
      errors.push({
        path: `${path}.mistakes[${index}].wrong`,
        message: occurrence_count === 0 ? `"${mistake.wrong}" is not in text_en` : `"${mistake.wrong}" appears ${occurrence_count} times in text_en; it must appear once`,
      });
    }
    corrected_text = corrected_text.replace(mistake.wrong, () => mistake.correct ?? '');
  });
  if (collapseWhitespace(corrected_text) !== collapseWhitespace(exercise.corrected_en)) {
    warnings.push({ path: `${path}.corrected_en`, message: 'does not match text_en with the listed fixes applied' });
  }
}

export function checkExerciseFile(raw_file: unknown): CheckedFile {
  const errors: ImportProblem[] = [];
  const warnings: ImportProblem[] = [];
  const file = normalize(raw_file);
  if (!isPlainObject(file)) return { exercises: [], errors: [{ path: '', message: 'the file must be one JSON object' }], warnings };
  for (const key of Object.keys(file)) {
    if (key !== 'schema_version' && key !== 'exercises') errors.push({ path: key, message: 'unknown field' });
  }
  if (file.schema_version !== 1) errors.push({ path: 'schema_version', message: 'must be 1 (this app reads version 1)' });
  if (!Array.isArray(file.exercises) || file.exercises.length === 0 || file.exercises.length > MAX_EXERCISES_PER_FILE) {
    errors.push({ path: 'exercises', message: `must be a list of 1 to ${MAX_EXERCISES_PER_FILE} exercises` });
    return { exercises: [], errors, warnings };
  }
  const first_index_by_id = new Map<string, number>();
  file.exercises.forEach((exercise: unknown, index: number) => {
    const path = `exercises[${index}]`;
    if (!isPlainObject(exercise)) {
      errors.push({ path, message: 'must be an object' });
      return;
    }
    const error_count_before = errors.length;
    if (typeof exercise.id !== 'string' || !ID_PATTERN.test(exercise.id)) {
      errors.push({ path: `${path}.id`, message: 'required: lowercase letters, digits and "-", starting with a letter or digit, at most 64 characters' });
    } else if (first_index_by_id.has(exercise.id)) {
      errors.push({ path: `${path}.id`, message: `"${exercise.id}" is also used by exercises[${first_index_by_id.get(exercise.id)}]` });
    } else {
      first_index_by_id.set(exercise.id, index);
    }
    if (typeof exercise.type !== 'string' || !EXERCISE_TYPES.includes(exercise.type)) {
      errors.push({ path: `${path}.type`, message: `must be one of: ${EXERCISE_TYPES.join(', ')}` });
      return;
    }
    const { id: _id, type: _type, ...fields } = exercise;
    checkFields(fields, { ...COMMON_FIELDS, ...TYPE_FIELDS[exercise.type as ExerciseType] }, path, errors);
    if (exercise.type === 'error_correction' && errors.length === error_count_before) checkErrorCorrection(exercise, path, errors, warnings);
  });
  return { exercises: errors.length === 0 ? file.exercises as Exercise[] : [], errors, warnings };
}

// For lists: the exercise's title, else the start of its main text.
export function exerciseTitleOf(exercise: Exercise): string {
  if (exercise.title !== undefined) return exercise.title;
  const main_text = 'text_vi' in exercise ? exercise.text_vi : 'prompt_vi' in exercise ? exercise.prompt_vi
    : 'prompt_en' in exercise ? exercise.prompt_en : exercise.text_en;
  return main_text.length > 80 ? `${main_text.slice(0, 79)}…` : main_text;
}
