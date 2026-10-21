// Checks an import file (docs/practice-import-format.md) and returns every problem: where it is (a JSON Pointer), a stable
// code and a sentence. Strict: an unknown field is a problem, and any problem means nothing is imported. Pure, so the page
// runs it for its live preview and the server runs it again before it stores anything.
import type { ApiProblem } from '../../shared/api.ts';
import type { ContentByType, ExerciseBody, ExerciseType, FileExercise, ProjectFile, ProjectInput } from './api.ts';

export type Problem = ApiProblem;

export const MAX_FILE_CHARS = 2_000_000;
export const MAX_EXERCISES = 500;
export const EXERCISE_TYPES: ExerciseType[] = ['rewrite', 'write', 'choice', 'fill', 'flashcard'];
// The key of a project or an exercise: a-z, 0-9 and -, not starting with -, at most 64 characters.
export const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const KEY_RULE = 'must be 1 to 64 of a-z, 0-9 and -, not starting with -.';

// What a field may hold. `required` fields must be present; every other field may be left out. `about` is the field's
// description in the JSON Schema (server/schemas.ts).
export type Spec = { about?: string } & (
  | { kind: 'text'; max: number; required?: true }
  | { kind: 'key'; required?: true }
  | { kind: 'oneOf'; values: string[]; required?: true }
  | { kind: 'flag' }
  | { kind: 'whole'; min: number; max: number }
  // A text, or a list of texts.
  | { kind: 'texts'; max: number; required?: true }
  | { kind: 'list'; of: Spec; min: number; max: number; required?: true }
  | { kind: 'object'; fields: Fields; required?: true });
export type Fields = Record<string, Spec>;

const text = (max: number, required?: true): Spec => ({ kind: 'text', max, required });
const list = (of: Spec, min: number, max: number, required?: true): Spec => ({ kind: 'list', of, min, max, required });
const about = (spec: Spec, description: string): Spec => ({ ...spec, about: description });

const objectOf = (fields: Fields): Spec => ({ kind: 'object', fields });

// One planted mistake of an error-correction rewrite.
const MISTAKE_FIELDS: Fields = { wrong: text(200, true), right: text(200, true), note: text(500) };
const CHOICE_OPTION_FIELDS: Fields = { text: text(500, true), why: text(1_000, true), correct: { kind: 'flag' } };
const GAP_FIELDS: Fields = {
  answer: about({ kind: 'texts', max: 200, required: true }, 'A text, or a list of accepted answers.'),
  hint: text(100),
  why: text(1_000),
};

export const CONTENT_FIELDS: { [Type in ExerciseType]: Fields } = {
  rewrite: {
    instruction: text(1_000, true),
    text: about(text(20_000, true), 'The text to rewrite, translate or correct.'),
    length: { kind: 'oneOf', values: ['sentence', 'paragraph', 'essay'], required: true },
    source_lang: about({ kind: 'oneOf', values: ['en', 'vi'] }, '"vi" makes it a translation. Default "en".'),
    prefill: about({ kind: 'flag' }, 'The answer box starts with text: error correction. Default false.'),
    constraints: about(list(text(100), 1, 3), 'Short rules the grader checks.'),
    mistakes: about(list(objectOf(MISTAKE_FIELDS), 1, 30), 'Planted mistakes, for error correction. Each wrong appears exactly once in text.'),
    reference: about(text(20_000), 'A model answer, for the grader only.'),
  },
  write: {
    prompt: text(2_000, true),
    min_words: about({ kind: 'whole', min: 1, max: 2_000 }, 'Default 250.'),
    minutes: about({ kind: 'whole', min: 1, max: 180 }, 'A guide, never a limit.'),
    sample: about(text(20_000), 'A model essay, shown after grading.'),
  },
  choice: {
    question: text(2_000, true),
    context: text(5_000),
    options: about(
      list(objectOf(CHOICE_OPTION_FIELDS), 2, 6, true),
      'One correct option is single choice; two or more is multi-select. At least one must be correct.',
    ),
  },
  fill: {
    text: about(text(5_000, true), 'Holds the markers {{1}} {{2}} ..., one per gap, in order.'),
    gaps: list(objectOf(GAP_FIELDS), 1, 30, true),
    instruction: text(1_000),
  },
  flashcard: {
    front: text(300, true),
    back: text(2_000, true),
    hint: text(300),
    example: about(text(1_000), 'Plain text.'),
    explanation: about(text(5_000), 'Markdown, up to 5,000 characters: the concept and a worked explanation, rendered under the answer.'),
  },
};

// The rules a field list cannot say (checkRelations), for the schema's description of each type.
export const TYPE_RULES: { [Type in ExerciseType]: string } = {
  rewrite: 'Graded by the AI. Each mistakes[].wrong appears exactly once in content.text.',
  write: 'Free writing, graded by the AI with estimated bands.',
  choice: 'Graded by the AI. At least one option has correct: true.',
  fill: 'Graded by the AI. content.text holds the markers {{1}} to {{n}} in order, one per gap.',
  flashcard: 'Not graded: you flip it and rate yourself.',
};

// The key is required in a file, and may be left out in PUT (the URL names the exercise).
export function exerciseFields(is_key_required: boolean): Fields {
  const key: Spec = is_key_required ? { kind: 'key', required: true } : { kind: 'key' };
  return {
    key: about(key, 'Names the exercise inside its project. Never changes.'),
    type: { kind: 'oneOf', values: EXERCISE_TYPES, required: true },
    topic: text(100),
    tags: about(list(text(40), 0, 10), 'Shown as chips.'),
  };
}

export const PROJECT_FIELDS: Fields = {
  key: about({ kind: 'key', required: true }, 'Names the project: importing the file again updates it.'),
  name: text(80, true),
  description: text(500),
};

// The body of PUT /projects/:key: the URL names the key.
const PROJECT_INPUT_FIELDS: Fields = {
  name: text(80, true),
  description: text(500),
  archived: about({ kind: 'flag' }, 'Hidden from the default list. Default false.'),
};

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
  let name = '';
  segments.forEach((segment, index) => {
    if (typeof segment === 'number') name += `[${segment}]`;
    else if (index === 0) name += segment;
    else name += `.${segment}`;
  });
  return name;
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
    case 'key':
      if (typeof value !== 'string') problems.add(at, 'wrong_type', KEY_RULE);
      else if (!KEY_PATTERN.test(value)) problems.add(at, 'bad_key', KEY_RULE);
      break;
    case 'oneOf':
      if (!spec.values.includes(value as string)) problems.add(at, 'not_allowed', `must be one of: ${spec.values.join(', ')}.`);
      break;
    case 'flag':
      if (typeof value !== 'boolean') problems.add(at, 'wrong_type', 'must be true or false.');
      break;
    case 'whole': {
      const rule = `must be a whole number from ${spec.min} to ${spec.max}.`;
      if (!Number.isInteger(value)) problems.add(at, 'wrong_type', rule);
      else if ((value as number) < spec.min || (value as number) > spec.max) problems.add(at, 'out_of_range', rule);
      break;
    }
    case 'texts': {
      // A list of 1 to 10 texts is checked text by text; anything else must be one text.
      const is_text_list = Array.isArray(value) && value.length >= 1 && value.length <= 10;
      if (!is_text_list) {
        checkText(value, spec.max, at, problems);
        break;
      }
      value.forEach((item, index) => {
        checkText(item, spec.max, [...at, index], problems);
      });
      break;
    }
    case 'list': {
      const rule = `must be a list of ${spec.min} to ${spec.max} items.`;
      if (!Array.isArray(value)) {
        problems.add(at, 'wrong_type', rule);
      } else if (value.length < spec.min) {
        problems.add(at, 'too_few', rule);
      } else if (value.length > spec.max) {
        problems.add(at, 'too_many', rule);
      } else {
        value.forEach((item, index) => {
          checkValue(item, spec.of, [...at, index], problems);
        });
      }
      break;
    }
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

// A choice exercise needs at least one correct option.
function checkChoiceOptions(options: unknown[], problems: Problems): void {
  const has_correct_option = options.some((option) => isObject(option) && option.correct === true);
  if (!has_correct_option) problems.addRule(['content', 'options'], 'no_correct_option', 'no option is marked correct.');
}

// A fill exercise's text holds {{1}} to {{n}}, in order, one per gap.
function checkFillMarkers(text: string, gaps: unknown[], problems: Problems): void {
  const markers = [...text.matchAll(/\{\{(\d+)\}\}/g)].map((match) => Number(match[1]));
  const is_in_order = markers.length === gaps.length && markers.every((marker, index) => marker === index + 1);
  if (is_in_order) return;
  const found = markers.map((marker) => `{{${marker}}}`).join(' ') || 'none';
  const message = `the markers must be {{1}} to {{${gaps.length}}} in order, one per gap (found ${found}).`;
  problems.addRule(['content', 'text'], 'fill_markers', message);
}

// Each planted mistake of an error-correction rewrite appears exactly once in its text.
function checkMistakes(text: string, mistakes: unknown[], problems: Problems): void {
  mistakes.forEach((mistake, index) => {
    if (!isObject(mistake) || typeof mistake.wrong !== 'string' || mistake.wrong === '') return;
    const count = text.split(mistake.wrong).length - 1;
    if (count === 1) return;
    const message = `"${mistake.wrong}" must appear exactly once in text (found ${count}).`;
    problems.add(['content', 'mistakes', index, 'wrong'], 'mistake_not_once', message);
  });
}

// The rules a field list cannot say. They run on what looks right so far, so one slip is not reported twice.
function checkRelations(type: ExerciseType, content: Record<string, unknown>, problems: Problems): void {
  if (type === 'choice' && Array.isArray(content.options)) {
    checkChoiceOptions(content.options, problems);
  } else if (type === 'fill' && typeof content.text === 'string' && Array.isArray(content.gaps)) {
    checkFillMarkers(content.text, content.gaps, problems);
  } else if (type === 'rewrite' && typeof content.text === 'string' && Array.isArray(content.mistakes)) {
    checkMistakes(content.text, content.mistakes, problems);
  }
}

// One exercise, its problems added under problems.base; the exercise when it has none.
// url_key: in PUT, the key in the URL, which a key in the body must equal.
function checkExercise(value: unknown, problems: Problems, url_key: string | null = null): FileExercise | null {
  const count_before = problems.list.length;
  if (!isObject(value)) {
    problems.add([], 'wrong_type', 'must be an object.');
    return null;
  }
  const { content, ...outer } = value;
  checkFields(outer, exerciseFields(url_key === null), [], problems);
  if (url_key !== null && typeof value.key === 'string' && KEY_PATTERN.test(value.key) && value.key !== url_key) {
    problems.add(['key'], 'key_mismatch', `"${value.key}" is not the key in the URL ("${url_key}").`);
  }
  const type = EXERCISE_TYPES.find((known) => known === value.type);
  if (content === undefined) problems.add(['content'], 'required', 'is missing.');
  else if (!isObject(content)) problems.add(['content'], 'wrong_type', 'must be an object.');
  else if (type !== undefined) {
    checkFields(content, CONTENT_FIELDS[type], ['content'], problems);
    checkRelations(type, content, problems);
  }
  if (problems.list.length > count_before || type === undefined) return null;
  // No problems, so every field has the shape its spec says.
  return {
    key: url_key ?? (value.key as string),
    type,
    topic: (value.topic as string | undefined) ?? null,
    tags: (value.tags as string[] | undefined) ?? [],
    content: value.content as ContentByType[ExerciseType],
  } as FileExercise;
}

export type CheckedFile = { file: ProjectFile; problems: null } | { file: null; problems: Problem[] };

const FORMAT_2_EDITS = 'To make a format 2 file format 3: set "format" to 3, add a "key" to "project" (a-z, 0-9 and -, like "m1-day-01"), and rename each exercise\'s "id" to "key".';

// A parsed file (format 3): the project it describes, or every problem.
export function checkImportValue(parsed: unknown): CheckedFile {
  if (!isObject(parsed)) return { file: null, problems: [{ path: '', code: 'wrong_type', message: 'The file must be one JSON object.' }] };
  const problems = new Problems();
  for (const key of Object.keys(parsed)) {
    if (!['format', 'project', 'exercises'].includes(key)) problems.add([key], 'unknown_field', 'is not a known field.');
  }
  if (parsed.format === 2) problems.add(['format'], 'unsupported_format', `must be 3. ${FORMAT_2_EDITS}`);
  else if (parsed.format !== 3) problems.add(['format'], 'unsupported_format', 'must be 3.');
  if (isObject(parsed.project)) checkFields(parsed.project, PROJECT_FIELDS, ['project'], problems);
  else problems.add(['project'], parsed.project === undefined ? 'required' : 'wrong_type', 'is missing.');
  const exercises = checkFileExercises(parsed.exercises, problems);
  if (problems.list.length > 0) return { file: null, problems: problems.list };
  const project = parsed.project as { key: string; name: string; description?: string };
  const file: ProjectFile = {
    key: project.key,
    name: project.name.trim(),
    description: project.description?.trim() ?? '',
    exercises,
  };
  return { file, problems: null };
}

// The file's "exercises": a list of 1 to MAX_EXERCISES exercises, each key used once. The ones without problems.
function checkFileExercises(value: unknown, problems: Problems): FileExercise[] {
  const rule = `must be a list of 1 to ${MAX_EXERCISES} items.`;
  if (!Array.isArray(value)) {
    problems.add(['exercises'], 'wrong_type', rule);
    return [];
  }
  if (value.length < 1) {
    problems.add(['exercises'], 'too_few', rule);
    return [];
  }
  if (value.length > MAX_EXERCISES) {
    problems.add(['exercises'], 'too_many', rule);
    return [];
  }
  const exercises: FileExercise[] = [];
  // key -> the 1-based number of the exercise that used it first.
  const first_seen = new Map<string, number>();
  value.forEach((exercise_value, index) => {
    const exercise_problems = new Problems(['exercises', index], problems.list);
    const exercise = checkExercise(exercise_value, exercise_problems);
    const key = isObject(exercise_value) && typeof exercise_value.key === 'string' ? exercise_value.key : null;
    if (key !== null && first_seen.has(key)) {
      exercise_problems.add(['key'], 'duplicate_key', `"${key}" is already used by exercise ${first_seen.get(key)}.`);
    } else if (key !== null) {
      first_seen.set(key, index + 1);
    }
    if (exercise !== null) exercises.push(exercise);
  });
  return exercises;
}

// The file's text: checked as above, after its size and its JSON.
export function checkProjectFile(file_text: string): CheckedFile {
  if (file_text.length > MAX_FILE_CHARS) return { file: null, problems: [{ path: '', code: 'too_large', message: 'The file is larger than 2 MB.' }] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(file_text);
  } catch (error) {
    const position = /position (\d+)/.exec((error as Error).message);
    let line_note = '';
    if (position !== null) {
      const line = file_text.slice(0, Number(position[1])).split('\n').length;
      line_note = ` (line ${line})`;
    }
    return { file: null, problems: [{ path: '', code: 'bad_json', message: `Not valid JSON${line_note}.` }] };
  }
  return checkImportValue(parsed);
}

// The body of PUT .../exercises/:key: the exercise, or every problem.
export function checkExerciseInput(value: unknown, url_key: string): { exercise: ExerciseBody; problems: null } | { exercise: null; problems: Problem[] } {
  const problems = new Problems();
  const exercise = checkExercise(value, problems, url_key);
  if (exercise === null) return { exercise: null, problems: problems.list };
  const { key: _key, ...body } = exercise;
  return { exercise: body, problems: null };
}

// The body of PUT /projects/:key, with the defaults filled in: the project, or every problem.
export function checkProjectInput(value: unknown): { project: Required<ProjectInput>; problems: null } | { project: null; problems: Problem[] } {
  const problems = new Problems();
  if (!isObject(value)) {
    problems.add([], 'wrong_type', 'The body must be a JSON object.');
    return { project: null, problems: problems.list };
  }
  // GET gives "" for no description, so a PUT of what GET gave must take it back.
  const fields = { ...value };
  if (fields.description === '') delete fields.description;
  checkFields(fields, PROJECT_INPUT_FIELDS, [], problems);
  if (problems.list.length > 0) return { project: null, problems: problems.list };
  const { name, description = '', archived = false } = fields as unknown as ProjectInput;
  return { project: { name: name.trim(), description: description.trim(), archived }, problems: null };
}

// A key in a URL, as a problem when it cannot be one ("#key", per docs/practice-api-design.md §3.3).
export function keyProblems(key: string): Problem[] {
  return KEY_PATTERN.test(key) ? [] : [{ path: '#key', code: 'bad_key', message: `The key in the URL ${KEY_RULE}` }];
}

// A problem as one line for a person: "Exercise 6 (choice, d2-pick-1): content.options: no option is marked correct."
// exercises: the file's exercises as sent, to name the one a problem is in (1-based, with its type and key when it has them).
export function problemLine(problem: Problem, exercises: unknown): string {
  const match = /^\/exercises\/(\d+)(?:\/|$)/.exec(problem.path);
  if (match === null) return problem.message;
  const index = Number(match[1]);
  const exercise = Array.isArray(exercises) ? exercises[index] : undefined;
  const type = isObject(exercise) && EXERCISE_TYPES.includes(exercise.type as ExerciseType) ? exercise.type as string : null;
  const key = isObject(exercise) && typeof exercise.key === 'string' && KEY_PATTERN.test(exercise.key) ? exercise.key : null;
  const label = [type, key].filter((part) => part !== null);
  return `Exercise ${index + 1}${label.length > 0 ? ` (${label.join(', ')})` : ''}: ${problem.message}`;
}
