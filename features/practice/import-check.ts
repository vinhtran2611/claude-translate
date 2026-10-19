// Checks an import file (docs/practice-import-format.md) and returns every problem, one line each. Strict: an unknown
// field is a problem, and any problem means nothing is imported. Pure, so the page runs it for its live preview and the
// server runs it again before it stores anything.
import type { ContentByType, ExerciseType, FileExercise, ProjectFile } from './api.ts';

export const MAX_FILE_CHARS = 2_000_000;
const MAX_EXERCISES = 500;
const EXERCISE_TYPES: ExerciseType[] = ['rewrite', 'write', 'choice', 'fill', 'flashcard'];
const KEY_PATTERN = /^[a-z0-9-]{1,64}$/;

// What a field may hold. `required` fields must be present; every other field may be left out.
type Spec =
  | { kind: 'text'; max: number; required?: true }
  | { kind: 'oneOf'; values: string[]; required?: true }
  | { kind: 'flag' }
  | { kind: 'whole'; min: number; max: number }
  // A text, or a list of texts.
  | { kind: 'texts'; max: number; required?: true }
  | { kind: 'list'; of: Spec; min: number; max: number; required?: true }
  | { kind: 'object'; fields: Fields; required?: true };
type Fields = Record<string, Spec>;

const text = (max: number, required?: true): Spec => ({ kind: 'text', max, required });
const list = (of: Spec, min: number, max: number, required?: true): Spec => ({ kind: 'list', of, min, max, required });

const CONTENT_FIELDS: { [Type in ExerciseType]: Fields } = {
  rewrite: {
    instruction: text(1_000, true),
    text: text(20_000, true),
    length: { kind: 'oneOf', values: ['sentence', 'paragraph', 'essay'], required: true },
    source_lang: { kind: 'oneOf', values: ['en', 'vi'] },
    prefill: { kind: 'flag' },
    constraints: list(text(100), 1, 3),
    mistakes: list({ kind: 'object', fields: { wrong: text(200, true), right: text(200, true), note: text(500) } }, 1, 30),
    reference: text(20_000),
  },
  write: { prompt: text(2_000, true), min_words: { kind: 'whole', min: 1, max: 2_000 }, minutes: { kind: 'whole', min: 1, max: 180 }, sample: text(20_000) },
  choice: {
    question: text(2_000, true),
    context: text(5_000),
    options: list({ kind: 'object', fields: { text: text(500, true), why: text(1_000, true), correct: { kind: 'flag' } } }, 2, 6, true),
  },
  fill: {
    text: text(5_000, true),
    gaps: list({ kind: 'object', fields: { answer: { kind: 'texts', max: 200, required: true }, hint: text(100), why: text(1_000) } }, 1, 30, true),
    instruction: text(1_000),
  },
  flashcard: { front: text(300, true), back: text(2_000, true), hint: text(300), example: text(1_000), explanation: text(5_000) },
};

const EXERCISE_FIELDS: Fields = {
  id: text(64, true),
  type: { kind: 'oneOf', values: EXERCISE_TYPES, required: true },
  topic: text(100),
  tags: list(text(40), 0, 10),
};

const PROJECT_FIELDS: Fields = { name: text(80, true), description: text(500) };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pathOf(parent: string, key: string): string {
  return parent === '' ? key : `${parent}.${key}`;
}

function checkValue(value: unknown, spec: Spec, path: string, problems: string[]): void {
  switch (spec.kind) {
    case 'text':
      if (typeof value !== 'string' || value.trim() === '') problems.push(`${path} must be a non-empty text.`);
      else if (value.length > spec.max) problems.push(`${path} is longer than ${spec.max} characters.`);
      break;
    case 'oneOf':
      if (!spec.values.includes(value as string)) problems.push(`${path} must be one of: ${spec.values.join(', ')}.`);
      break;
    case 'flag':
      if (typeof value !== 'boolean') problems.push(`${path} must be true or false.`);
      break;
    case 'whole':
      if (!Number.isInteger(value) || (value as number) < spec.min || (value as number) > spec.max) problems.push(`${path} must be a whole number from ${spec.min} to ${spec.max}.`);
      break;
    case 'texts':
      if (Array.isArray(value) && value.length >= 1 && value.length <= 10) value.forEach((item, index) => checkValue(item, { kind: 'text', max: spec.max }, `${path}[${index}]`, problems));
      else checkValue(value, { kind: 'text', max: spec.max }, path, problems);
      break;
    case 'list':
      if (!Array.isArray(value) || value.length < spec.min || value.length > spec.max) problems.push(`${path} must be a list of ${spec.min} to ${spec.max} items.`);
      else value.forEach((item, index) => checkValue(item, spec.of, `${path}[${index}]`, problems));
      break;
    case 'object':
      if (isObject(value)) checkFields(value, spec.fields, path, problems);
      else problems.push(`${path} must be an object.`);
  }
}

function checkFields(object: Record<string, unknown>, fields: Fields, path: string, problems: string[]): void {
  for (const key of Object.keys(object)) {
    if (!Object.hasOwn(fields, key)) problems.push(`${pathOf(path, key)} is not a known field.`);
  }
  for (const [key, spec] of Object.entries(fields)) {
    if (object[key] === undefined) {
      if ('required' in spec && spec.required) problems.push(`${pathOf(path, key)} is missing.`);
    } else {
      checkValue(object[key], spec, pathOf(path, key), problems);
    }
  }
}

// The rules a field list cannot say. They run on what looks right so far, so one slip is not reported twice.
function checkRelations(type: ExerciseType, content: Record<string, unknown>, problems: string[]): void {
  if (type === 'choice' && Array.isArray(content.options)) {
    if (!content.options.some((option) => isObject(option) && option.correct === true)) problems.push('content.options: no option is marked correct.');
  } else if (type === 'fill' && typeof content.text === 'string' && Array.isArray(content.gaps)) {
    const markers = [...content.text.matchAll(/\{\{(\d+)\}\}/g)].map((match) => Number(match[1]));
    if (markers.length !== content.gaps.length || markers.some((marker, index) => marker !== index + 1)) {
      problems.push(`content.text: the markers must be {{1}} to {{${content.gaps.length}}} in order, one per gap (found ${markers.map((marker) => `{{${marker}}}`).join(' ') || 'none'}).`);
    }
  } else if (type === 'rewrite' && typeof content.text === 'string' && Array.isArray(content.mistakes)) {
    const { text } = content;
    content.mistakes.forEach((mistake, index) => {
      if (!isObject(mistake) || typeof mistake.wrong !== 'string' || mistake.wrong === '') return;
      const count = text.split(mistake.wrong).length - 1;
      if (count !== 1) problems.push(`content.mistakes[${index}].wrong "${mistake.wrong}" must appear exactly once in text (found ${count}).`);
    });
  }
}

// One exercise: its problems (without the "Exercise 3 (choice):" prefix) and, when there are none, the exercise.
function checkExercise(value: unknown, problems: string[]): FileExercise | null {
  if (!isObject(value)) {
    problems.push('must be an object.');
    return null;
  }
  const { content, ...outer } = value;
  checkFields(outer, EXERCISE_FIELDS, '', problems);
  if (typeof value.id === 'string' && value.id.length <= 64 && !KEY_PATTERN.test(value.id)) problems.push('id may use only a-z, 0-9 and -.');
  const type = EXERCISE_TYPES.find((known) => known === value.type);
  if (content === undefined) problems.push('content is missing.');
  else if (!isObject(content)) problems.push('content must be an object.');
  else if (type !== undefined) {
    checkFields(content, CONTENT_FIELDS[type], 'content', problems);
    checkRelations(type, content, problems);
  }
  if (problems.length > 0 || type === undefined) return null;
  return {
    key: value.id as string, type, topic: (value.topic as string | undefined) ?? null, tags: (value.tags as string[] | undefined) ?? [],
    content: value.content as ContentByType[ExerciseType],
  } as FileExercise;
}

export type CheckedFile = { file: ProjectFile; errors: null } | { file: null; errors: string[] };

export function checkProjectFile(file_text: string): CheckedFile {
  if (file_text.length > MAX_FILE_CHARS) return { file: null, errors: ['The file is larger than 2 MB.'] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(file_text);
  } catch (error) {
    const position = /position (\d+)/.exec((error as Error).message);
    const line = position === null ? null : file_text.slice(0, Number(position[1])).split('\n').length;
    return { file: null, errors: [`Not valid JSON${line === null ? '' : ` (line ${line})`}.`] };
  }
  if (!isObject(parsed)) return { file: null, errors: ['The file must be one JSON object.'] };
  const errors: string[] = [];
  const unknown = Object.keys(parsed).filter((key) => !['format', 'project', 'exercises'].includes(key));
  errors.push(...unknown.map((key) => `${key} is not a known field.`));
  if (parsed.format !== 2) errors.push('format must be 2.');
  if (isObject(parsed.project)) checkFields(parsed.project, PROJECT_FIELDS, 'project', errors);
  else errors.push('project is missing.');
  const exercises: FileExercise[] = [];
  if (!Array.isArray(parsed.exercises) || parsed.exercises.length < 1 || parsed.exercises.length > MAX_EXERCISES) {
    errors.push(`exercises must be a list of 1 to ${MAX_EXERCISES} items.`);
  } else {
    const first_seen = new Map<string, number>();
    parsed.exercises.forEach((value, index) => {
      const problems: string[] = [];
      const exercise = checkExercise(value, problems);
      const id = isObject(value) && typeof value.id === 'string' ? value.id : null;
      if (id !== null && first_seen.has(id)) problems.push(`id "${id}" is already used by exercise ${first_seen.get(id)}.`);
      else if (id !== null) first_seen.set(id, index + 1);
      const type = isObject(value) && EXERCISE_TYPES.includes(value.type as ExerciseType) ? ` (${value.type})` : '';
      errors.push(...problems.map((problem) => `Exercise ${index + 1}${type}: ${problem}`));
      if (exercise !== null) exercises.push(exercise);
    });
  }
  if (errors.length > 0) return { file: null, errors };
  const project = parsed.project as { name: string; description?: string };
  return { file: { name: project.name.trim(), description: project.description?.trim() ?? '', exercises }, errors: null };
}
