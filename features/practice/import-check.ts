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
// description in the JSON Schema.
type Spec = { about?: string } & (
  | { kind: 'text'; max: number; required?: true }
  | { kind: 'key'; required?: true }
  | { kind: 'oneOf'; values: string[]; required?: true }
  | { kind: 'flag' }
  | { kind: 'whole'; min: number; max: number }
  // A text, or a list of texts.
  | { kind: 'texts'; max: number; required?: true }
  | { kind: 'list'; of: Spec; min: number; max: number; required?: true }
  | { kind: 'object'; fields: Fields; required?: true });
type Fields = Record<string, Spec>;

const text = (max: number, required?: true): Spec => ({ kind: 'text', max, required });
const list = (of: Spec, min: number, max: number, required?: true): Spec => ({ kind: 'list', of, min, max, required });
const about = (spec: Spec, description: string): Spec => ({ ...spec, about: description });

const CONTENT_FIELDS: { [Type in ExerciseType]: Fields } = {
  rewrite: {
    instruction: text(1_000, true),
    text: about(text(20_000, true), 'The text to rewrite, translate or correct.'),
    length: { kind: 'oneOf', values: ['sentence', 'paragraph', 'essay'], required: true },
    source_lang: about({ kind: 'oneOf', values: ['en', 'vi'] }, '"vi" makes it a translation. Default "en".'),
    prefill: about({ kind: 'flag' }, 'The answer box starts with text: error correction. Default false.'),
    constraints: about(list(text(100), 1, 3), 'Short rules the grader checks.'),
    mistakes: about(list({ kind: 'object', fields: { wrong: text(200, true), right: text(200, true), note: text(500) } }, 1, 30),
      'Planted mistakes, for error correction. Each wrong appears exactly once in text.'),
    reference: about(text(20_000), 'A model answer, for the grader only.'),
  },
  write: {
    prompt: text(2_000, true), min_words: about({ kind: 'whole', min: 1, max: 2_000 }, 'Default 250.'),
    minutes: about({ kind: 'whole', min: 1, max: 180 }, 'A guide, never a limit.'), sample: about(text(20_000), 'A model essay, shown after grading.'),
  },
  choice: {
    question: text(2_000, true),
    context: text(5_000),
    options: about(list({ kind: 'object', fields: { text: text(500, true), why: text(1_000, true), correct: { kind: 'flag' } } }, 2, 6, true),
      'One correct option is single choice; two or more is multi-select. At least one must be correct.'),
  },
  fill: {
    text: about(text(5_000, true), 'Holds the markers {{1}} {{2}} ..., one per gap, in order.'),
    gaps: list({ kind: 'object', fields: { answer: about({ kind: 'texts', max: 200, required: true }, 'A text, or a list of accepted answers.'), hint: text(100), why: text(1_000) } }, 1, 30, true),
    instruction: text(1_000),
  },
  flashcard: {
    front: text(300, true), back: text(2_000, true), hint: text(300), example: about(text(1_000), 'Plain text.'),
    explanation: about(text(5_000), 'Markdown, up to 5,000 characters: the concept and a worked explanation, rendered under the answer.'),
  },
};

// The rules a field list cannot say (checkRelations), for the schema's description of each type.
const TYPE_RULES: { [Type in ExerciseType]: string } = {
  rewrite: 'Graded by the AI. Each mistakes[].wrong appears exactly once in content.text.',
  write: 'Free writing, graded by the AI with estimated bands.',
  choice: 'Graded by the AI. At least one option has correct: true.',
  fill: 'Graded by the AI. content.text holds the markers {{1}} to {{n}} in order, one per gap.',
  flashcard: 'Not graded: you flip it and rate yourself.',
};

// key_name: "key" in format 3 and in PUT, "id" in format 2.
function exerciseFields(key_name: 'key' | 'id', is_key_required: boolean): Fields {
  return {
    [key_name]: about(is_key_required ? { kind: 'key', required: true } : { kind: 'key' }, 'Names the exercise inside its project. Never changes.'),
    type: { kind: 'oneOf', values: EXERCISE_TYPES, required: true },
    topic: text(100),
    tags: about(list(text(40), 0, 10), 'Shown as chips.'),
  };
}

const PROJECT_FIELDS: { [Format in 2 | 3]: Fields } = {
  2: { name: text(80, true), description: text(500) },
  3: { key: about({ kind: 'key', required: true }, 'Names the project: importing the file again updates it.'), name: text(80, true), description: text(500) },
};

const PROJECT_INPUT_FIELDS: Fields = { name: text(80, true), description: text(500), archived: about({ kind: 'flag' }, 'Hidden from the default list. Default false.') };

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
    case 'key':
      if (typeof value !== 'string' || !KEY_PATTERN.test(value)) problems.add(at, typeof value === 'string' ? 'bad_key' : 'wrong_type', KEY_RULE);
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

// One exercise, its problems added under problems.base; the exercise when it has none. key_name: see exerciseFields.
// url_key: in PUT, the key in the URL, which a key in the body must equal.
function checkExercise(value: unknown, problems: Problems, key_name: 'key' | 'id', url_key: string | null = null): FileExercise | null {
  const count_before = problems.list.length;
  if (!isObject(value)) {
    problems.add([], 'wrong_type', 'must be an object.');
    return null;
  }
  const { content, ...outer } = value;
  checkFields(outer, exerciseFields(key_name, url_key === null), [], problems);
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
  return {
    key: url_key ?? value[key_name] as string, type, topic: (value.topic as string | undefined) ?? null, tags: (value.tags as string[] | undefined) ?? [],
    content: value.content as ContentByType[ExerciseType],
  } as FileExercise;
}

export type CheckedFile = { file: ProjectFile; problems: null } | { file: null; problems: Problem[] };

const FORMAT_2_EDITS = 'To make a format 2 file format 3: set "format" to 3, add a "key" to "project" (a-z, 0-9 and -, like "m1-day-01"), and rename each exercise\'s "id" to "key".';

// A parsed file of the given format (3: POST /import; 2: the first API, until step 5): the project it describes, or every problem.
export function checkImportValue(parsed: unknown, format: 2 | 3 = 3): CheckedFile {
  if (!isObject(parsed)) return { file: null, problems: [{ path: '', code: 'wrong_type', message: 'The file must be one JSON object.' }] };
  const problems = new Problems();
  const key_name = format === 3 ? 'key' : 'id';
  for (const key of Object.keys(parsed)) {
    if (!['format', 'project', 'exercises'].includes(key)) problems.add([key], 'unknown_field', 'is not a known field.');
  }
  if (parsed.format !== format) problems.add(['format'], 'unsupported_format', `must be ${format}.${parsed.format === 2 ? ` ${FORMAT_2_EDITS}` : ''}`);
  if (isObject(parsed.project)) checkFields(parsed.project, PROJECT_FIELDS[format], ['project'], problems);
  else problems.add(['project'], parsed.project === undefined ? 'required' : 'wrong_type', 'is missing.');
  const exercises: FileExercise[] = [];
  if (!Array.isArray(parsed.exercises) || parsed.exercises.length < 1 || parsed.exercises.length > MAX_EXERCISES) {
    const code = !Array.isArray(parsed.exercises) ? 'wrong_type' : parsed.exercises.length < 1 ? 'too_few' : 'too_many';
    problems.add(['exercises'], code, `must be a list of 1 to ${MAX_EXERCISES} items.`);
  } else {
    const first_seen = new Map<string, number>();
    parsed.exercises.forEach((value, index) => {
      const exercise_problems = new Problems(['exercises', index], problems.list);
      const exercise = checkExercise(value, exercise_problems, key_name);
      const key = isObject(value) && typeof value[key_name] === 'string' ? value[key_name] as string : null;
      if (key !== null && first_seen.has(key)) exercise_problems.add([key_name], 'duplicate_key', `"${key}" is already used by exercise ${first_seen.get(key)}.`);
      else if (key !== null) first_seen.set(key, index + 1);
      if (exercise !== null) exercises.push(exercise);
    });
  }
  if (problems.list.length > 0) return { file: null, problems: problems.list };
  const project = parsed.project as { key?: string; name: string; description?: string };
  return { file: { key: project.key ?? null, name: project.name.trim(), description: project.description?.trim() ?? '', exercises }, problems: null };
}

// The file's text: checked as above, after its size and its JSON.
export function checkProjectFile(file_text: string, format: 2 | 3 = 3): CheckedFile {
  if (file_text.length > MAX_FILE_CHARS) return { file: null, problems: [{ path: '', code: 'too_large', message: 'The file is larger than 2 MB.' }] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(file_text);
  } catch (error) {
    const position = /position (\d+)/.exec((error as Error).message);
    const line = position === null ? null : file_text.slice(0, Number(position[1])).split('\n').length;
    return { file: null, problems: [{ path: '', code: 'bad_json', message: `Not valid JSON${line === null ? '' : ` (line ${line})`}.` }] };
  }
  return checkImportValue(parsed, format);
}

// The body of PUT .../exercises/:key: the exercise, or every problem.
export function checkExerciseInput(value: unknown, url_key: string): { exercise: ExerciseBody; problems: null } | { exercise: null; problems: Problem[] } {
  const problems = new Problems();
  const exercise = checkExercise(value, problems, 'key', url_key);
  if (exercise === null) return { exercise: null, problems: problems.list };
  const { key: _key, ...body } = exercise;
  return { exercise: body, problems: null };
}

// The body of PUT /projects/:key, with the defaults filled in: the project, or every problem.
export function checkProjectInput(value: unknown): { project: Required<ProjectInput>; problems: null } | { project: null; problems: Problem[] } {
  const problems = new Problems();
  if (isObject(value)) checkFields(value, PROJECT_INPUT_FIELDS, [], problems);
  else problems.add([], 'wrong_type', 'The body must be a JSON object.');
  if (problems.list.length > 0) return { project: null, problems: problems.list };
  const { name, description = '', archived = false } = value as unknown as ProjectInput;
  return { project: { name: name.trim(), description: description.trim(), archived }, problems: null };
}

// A key in a URL, as a problem when it cannot be one ("#key", per docs/practice-api-design.md §3.3).
export function keyProblems(key: string): Problem[] {
  return KEY_PATTERN.test(key) ? [] : [{ path: '#key', code: 'bad_key', message: `The key in the URL ${KEY_RULE}` }];
}

// ---- JSON Schema (draft 2020-12), made from the same specs, so it can never disagree with the checks ----

function schemaOf(spec: Spec): Record<string, unknown> {
  const description = spec.about === undefined ? {} : { description: spec.about };
  switch (spec.kind) {
    case 'text': return { type: 'string', minLength: 1, maxLength: spec.max, ...description };
    case 'key': return { type: 'string', pattern: KEY_PATTERN.source, ...description };
    case 'oneOf': return { enum: spec.values, ...description };
    case 'flag': return { type: 'boolean', ...description };
    case 'whole': return { type: 'integer', minimum: spec.min, maximum: spec.max, ...description };
    case 'texts': {
      const one = { type: 'string', minLength: 1, maxLength: spec.max };
      return { oneOf: [one, { type: 'array', minItems: 1, maxItems: 10, items: one }], ...description };
    }
    case 'list': return { type: 'array', minItems: spec.min, maxItems: spec.max, items: schemaOf(spec.of), ...description };
    case 'object': return objectSchema(spec.fields, description);
  }
}

function objectSchema(fields: Fields, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const required = Object.entries(fields).filter(([, spec]) => 'required' in spec && spec.required).map(([key]) => key);
  return {
    type: 'object', additionalProperties: false, required, ...extra,
    properties: Object.fromEntries(Object.entries(fields).map(([key, spec]) => [key, schemaOf(spec)])),
  };
}

const SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

// GET /api/practice/schemas/exercise.json: one exercise as a file holds it, one $defs entry per type.
export function exerciseSchema(): Record<string, unknown> {
  const $defs = Object.fromEntries(EXERCISE_TYPES.map((type) => {
    const { type: _type, ...outer } = exerciseFields('key', true);
    const fields = { ...outer, content: { kind: 'object', fields: CONTENT_FIELDS[type], required: true } as Spec };
    const schema = objectSchema(fields, { description: TYPE_RULES[type] });
    const properties = schema.properties as Record<string, unknown>;
    return [type, { ...schema, required: ['key', 'type', 'content'], properties: { key: properties.key, type: { const: type }, ...properties } }];
  }));
  return {
    $schema: SCHEMA_DIALECT, $id: '/api/practice/schemas/exercise.json', title: 'Practice exercise',
    description: 'In PUT /api/practice/projects/{project}/exercises/{key}, key may be left out; when present it must equal the URL key. Texts must not be only spaces.',
    oneOf: EXERCISE_TYPES.map((type) => ({ $ref: `#/$defs/${type}` })), $defs,
  };
}

// GET /api/practice/schemas/import.json: the import file, format 3.
export function importSchema(): Record<string, unknown> {
  return {
    $schema: SCHEMA_DIALECT, $id: '/api/practice/schemas/import.json', title: 'Practice import file (format 3)',
    description: 'One file is one project. Importing it again updates the project and its exercises by key; it never deletes an exercise.',
    type: 'object', additionalProperties: false, required: ['format', 'project', 'exercises'],
    properties: {
      format: { const: 3 },
      project: objectSchema(PROJECT_FIELDS[3]),
      exercises: { type: 'array', minItems: 1, maxItems: MAX_EXERCISES, items: { $ref: 'exercise.json' }, description: 'Keys are unique in the file.' },
    },
  };
}

// A problem as one line for a person: "Exercise 6 (choice, d2-pick-1): content.options: no option is marked correct."
// exercises: the file's exercises as sent, to name the one a problem is in (1-based, with its type and key when it has them).
export function problemLine(problem: Problem, exercises: unknown): string {
  const match = /^\/exercises\/(\d+)(?:\/|$)/.exec(problem.path);
  if (match === null) return problem.message;
  const index = Number(match[1]);
  const exercise = Array.isArray(exercises) ? exercises[index] : undefined;
  const type = isObject(exercise) && EXERCISE_TYPES.includes(exercise.type as ExerciseType) ? exercise.type as string : null;
  const key_value = isObject(exercise) ? exercise.key ?? exercise.id : undefined;
  const key = typeof key_value === 'string' && KEY_PATTERN.test(key_value) ? key_value : null;
  const label = [type, key].filter((part) => part !== null);
  return `Exercise ${index + 1}${label.length > 0 ? ` (${label.join(', ')})` : ''}: ${problem.message}`;
}
