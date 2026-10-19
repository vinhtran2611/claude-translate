// Checks an import file (docs/practice-import-format.md) and returns every problem: where it is (a JSON Pointer), a stable
// code and a sentence. Strict: an unknown field is a problem, and any problem means nothing is imported. Pure, so the page
// runs it for its live preview and the server runs it again before it stores anything.
import type { ApiProblem } from '../../shared/api.ts';
import type { ContentByType, ExerciseType, FileExercise, ProjectFile } from './api.ts';

export type Problem = ApiProblem;

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

type Segment = string | number;

// ["exercises", 5, "content"] -> "/exercises/5/content" (RFC 6901).
function pointerOf(segments: Segment[]): string {
  return segments.map((segment) => `/${String(segment).replaceAll('~', '~0').replaceAll('/', '~1')}`).join('');
}

// ["content", "options", 0, "why"] -> "content.options[0].why", the name a person reads.
function nameOf(segments: Segment[]): string {
  return segments.map((segment, index) => (typeof segment === 'number' ? `[${segment}]` : index === 0 ? segment : `.${segment}`)).join('');
}

// Collects problems under one place of the body: `base` is where the checked object sits (["exercises", 2] for the third
// exercise), and every message names the field from there, as a person reads it ("content.back is missing.").
class Problems {
  list: Problem[] = [];
  base: Segment[];

  constructor(base: Segment[] = [], list: Problem[] = []) {
    this.base = base;
    this.list = list;
  }

  // text follows the field's name: "is missing.", "must be an object.".
  add(at: Segment[], code: string, text: string): void {
    const name = nameOf(at);
    this.list.push({ path: pointerOf([...this.base, ...at]), code, message: name === '' ? text : `${name} ${text}` });
  }

  // A rule about a field as a whole: "content.options: no option is marked correct."
  addRule(at: Segment[], code: string, text: string): void {
    this.list.push({ path: pointerOf([...this.base, ...at]), code, message: `${nameOf(at)}: ${text}` });
  }
}

function checkText(value: unknown, max: number, at: Segment[], problems: Problems): void {
  if (typeof value !== 'string') problems.add(at, 'wrong_type', 'must be a non-empty text.');
  else if (value.trim() === '') problems.add(at, 'empty', 'must be a non-empty text.');
  else if (value.length > max) problems.add(at, 'too_long', `is longer than ${max} characters.`);
}

function checkValue(value: unknown, spec: Spec, at: Segment[], problems: Problems): void {
  switch (spec.kind) {
    case 'text':
      checkText(value, spec.max, at, problems);
      break;
    case 'oneOf':
      if (!spec.values.includes(value as string)) problems.add(at, 'not_allowed', `must be one of: ${spec.values.join(', ')}.`);
      break;
    case 'flag':
      if (typeof value !== 'boolean') problems.add(at, 'wrong_type', 'must be true or false.');
      break;
    case 'whole':
      if (!Number.isInteger(value) || (value as number) < spec.min || (value as number) > spec.max) {
        problems.add(at, Number.isInteger(value) ? 'out_of_range' : 'wrong_type', `must be a whole number from ${spec.min} to ${spec.max}.`);
      }
      break;
    case 'texts':
      if (Array.isArray(value) && value.length >= 1 && value.length <= 10) value.forEach((item, index) => checkText(item, spec.max, [...at, index], problems));
      else checkText(value, spec.max, at, problems);
      break;
    case 'list':
      if (!Array.isArray(value) || value.length < spec.min || value.length > spec.max) {
        const code = !Array.isArray(value) ? 'wrong_type' : value.length < spec.min ? 'too_few' : 'too_many';
        problems.add(at, code, `must be a list of ${spec.min} to ${spec.max} items.`);
      } else {
        value.forEach((item, index) => checkValue(item, spec.of, [...at, index], problems));
      }
      break;
    case 'object':
      if (isObject(value)) checkFields(value, spec.fields, at, problems);
      else problems.add(at, 'wrong_type', 'must be an object.');
  }
}

function checkFields(object: Record<string, unknown>, fields: Fields, at: Segment[], problems: Problems): void {
  for (const key of Object.keys(object)) {
    if (!Object.hasOwn(fields, key)) problems.add([...at, key], 'unknown_field', 'is not a known field.');
  }
  for (const [key, spec] of Object.entries(fields)) {
    if (object[key] === undefined) {
      if ('required' in spec && spec.required) problems.add([...at, key], 'required', 'is missing.');
    } else {
      checkValue(object[key], spec, [...at, key], problems);
    }
  }
}

// The rules a field list cannot say. They run on what looks right so far, so one slip is not reported twice.
function checkRelations(type: ExerciseType, content: Record<string, unknown>, problems: Problems): void {
  if (type === 'choice' && Array.isArray(content.options)) {
    if (!content.options.some((option) => isObject(option) && option.correct === true)) problems.addRule(['content', 'options'], 'no_correct_option', 'no option is marked correct.');
  } else if (type === 'fill' && typeof content.text === 'string' && Array.isArray(content.gaps)) {
    const markers = [...content.text.matchAll(/\{\{(\d+)\}\}/g)].map((match) => Number(match[1]));
    if (markers.length !== content.gaps.length || markers.some((marker, index) => marker !== index + 1)) {
      problems.addRule(['content', 'text'], 'fill_markers', `the markers must be {{1}} to {{${content.gaps.length}}} in order, one per gap (found ${markers.map((marker) => `{{${marker}}}`).join(' ') || 'none'}).`);
    }
  } else if (type === 'rewrite' && typeof content.text === 'string' && Array.isArray(content.mistakes)) {
    const { text } = content;
    content.mistakes.forEach((mistake, index) => {
      if (!isObject(mistake) || typeof mistake.wrong !== 'string' || mistake.wrong === '') return;
      const count = text.split(mistake.wrong).length - 1;
      if (count !== 1) problems.add(['content', 'mistakes', index, 'wrong'], 'mistake_not_once', `"${mistake.wrong}" must appear exactly once in text (found ${count}).`);
    });
  }
}

// One exercise, its problems added under problems.base; the exercise when it has none.
function checkExercise(value: unknown, problems: Problems): FileExercise | null {
  const count_before = problems.list.length;
  if (!isObject(value)) {
    problems.add([], 'wrong_type', 'must be an object.');
    return null;
  }
  const { content, ...outer } = value;
  checkFields(outer, EXERCISE_FIELDS, [], problems);
  if (typeof value.id === 'string' && value.id.length <= 64 && !KEY_PATTERN.test(value.id)) problems.add(['id'], 'bad_key', 'may use only a-z, 0-9 and -.');
  const type = EXERCISE_TYPES.find((known) => known === value.type);
  if (content === undefined) problems.add(['content'], 'required', 'is missing.');
  else if (!isObject(content)) problems.add(['content'], 'wrong_type', 'must be an object.');
  else if (type !== undefined) {
    checkFields(content, CONTENT_FIELDS[type], ['content'], problems);
    checkRelations(type, content, problems);
  }
  if (problems.list.length > count_before || type === undefined) return null;
  return {
    key: value.id as string, type, topic: (value.topic as string | undefined) ?? null, tags: (value.tags as string[] | undefined) ?? [],
    content: value.content as ContentByType[ExerciseType],
  } as FileExercise;
}

export type CheckedFile = { file: ProjectFile; problems: null } | { file: null; problems: Problem[] };

// A parsed file: the project it describes, or every problem.
export function checkImportValue(parsed: unknown): CheckedFile {
  if (!isObject(parsed)) return { file: null, problems: [{ path: '', code: 'wrong_type', message: 'The file must be one JSON object.' }] };
  const problems = new Problems();
  for (const key of Object.keys(parsed)) {
    if (!['format', 'project', 'exercises'].includes(key)) problems.add([key], 'unknown_field', 'is not a known field.');
  }
  if (parsed.format !== 2) problems.add(['format'], 'unsupported_format', 'must be 2.');
  if (isObject(parsed.project)) checkFields(parsed.project, PROJECT_FIELDS, ['project'], problems);
  else problems.add(['project'], parsed.project === undefined ? 'required' : 'wrong_type', 'is missing.');
  const exercises: FileExercise[] = [];
  if (!Array.isArray(parsed.exercises) || parsed.exercises.length < 1 || parsed.exercises.length > MAX_EXERCISES) {
    const code = !Array.isArray(parsed.exercises) ? 'wrong_type' : parsed.exercises.length < 1 ? 'too_few' : 'too_many';
    problems.add(['exercises'], code, `must be a list of 1 to ${MAX_EXERCISES} items.`);
  } else {
    const first_seen = new Map<string, number>();
    parsed.exercises.forEach((value, index) => {
      const exercise_problems = new Problems(['exercises', index], problems.list);
      const exercise = checkExercise(value, exercise_problems);
      const id = isObject(value) && typeof value.id === 'string' ? value.id : null;
      if (id !== null && first_seen.has(id)) exercise_problems.add(['id'], 'duplicate_key', `"${id}" is already used by exercise ${first_seen.get(id)}.`);
      else if (id !== null) first_seen.set(id, index + 1);
      if (exercise !== null) exercises.push(exercise);
    });
  }
  if (problems.list.length > 0) return { file: null, problems: problems.list };
  const project = parsed.project as { name: string; description?: string };
  return { file: { name: project.name.trim(), description: project.description?.trim() ?? '', exercises }, problems: null };
}

// The file's text: checked as above, after its size and its JSON.
export function checkProjectFile(file_text: string): CheckedFile {
  if (file_text.length > MAX_FILE_CHARS) return { file: null, problems: [{ path: '', code: 'too_large', message: 'The file is larger than 2 MB.' }] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(file_text);
  } catch (error) {
    const position = /position (\d+)/.exec((error as Error).message);
    const line = position === null ? null : file_text.slice(0, Number(position[1])).split('\n').length;
    return { file: null, problems: [{ path: '', code: 'bad_json', message: `Not valid JSON${line === null ? '' : ` (line ${line})`}.` }] };
  }
  return checkImportValue(parsed);
}

// A problem as one line for a person: "Exercise 6 (choice, d2-pick-1): content.options: no option is marked correct."
// exercises: the file's exercises as sent, to name the one a problem is in (1-based, with its type and key when it has them).
export function problemLine(problem: Problem, exercises: unknown): string {
  const match = /^\/exercises\/(\d+)(?:\/|$)/.exec(problem.path);
  if (match === null) return problem.message;
  const index = Number(match[1]);
  const exercise = Array.isArray(exercises) ? exercises[index] : undefined;
  const type = isObject(exercise) && EXERCISE_TYPES.includes(exercise.type as ExerciseType) ? exercise.type as string : null;
  const key = isObject(exercise) && typeof exercise.id === 'string' && KEY_PATTERN.test(exercise.id) ? exercise.id : null;
  const label = [type, key].filter((part) => part !== null);
  return `Exercise ${index + 1}${label.length > 0 ? ` (${label.join(', ')})` : ''}: ${problem.message}`;
}
