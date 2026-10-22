// Checks an import file (docs/practice-import-format.md) and returns every problem: where it is (a JSON Pointer), a stable
// code and a sentence. Strict: an unknown field is a problem, and any problem means nothing is imported. It reads format 4,
// and format 3 converted to format 4 (format-3.ts). A checked file has every default filled in, so what is stored has
// none. Pure, so the page runs it for its live preview and the server runs it again before it stores anything.
import type { ApiProblem, Language, TextLength } from '../../shared/api.ts';
import type {
  ChoiceOption, ExerciseBody, ExerciseContent, ExerciseType, FileExercise, Gap, PlantedMistake, ProjectFile, ProjectInput,
} from './api.ts';
import { contentFromFormat3, type Format3Content, type Format3Type } from './format-3.ts';

export type Problem = ApiProblem;

export const MAX_FILE_CHARS = 2_000_000;
export const MAX_EXERCISES = 500;
export const EXERCISE_TYPES: ExerciseType[] = ['rewrite', 'translation', 'correction', 'essay', 'choice', 'gap_fill', 'flashcard'];
// The formats an import reads, newest first. Export writes the first.
export const IMPORT_FORMATS = [4, 3];
const FORMAT_3_TYPES: Format3Type[] = ['rewrite', 'write', 'choice', 'fill', 'flashcard'];
// The key of a project or an exercise: a-z, 0-9 and -, not starting with -, at most 64 characters.
export const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const KEY_RULE = 'must be 1 to 64 of a-z, 0-9 and -, not starting with -.';
// A time as the API writes it: ISO 8601 in UTC with milliseconds.
const TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TIME_RULE = 'must be a time like 2026-10-21T08:30:00.000Z, or null.';

// What a field may hold. `required` fields must be present; every other field may be left out or be null, which both
// mean "use the default". `about` is the field's description in the JSON Schema (server/schemas.ts).
export type Spec = { about?: string } & (
  | { kind: 'text'; max: number; required?: true }
  | { kind: 'key'; required?: true }
  | { kind: 'oneOf'; values: string[]; required?: true }
  | { kind: 'flag' }
  | { kind: 'whole'; min: number; max: number }
  | { kind: 'time' }
  // A text, or a list of texts (format 3 only).
  | { kind: 'texts'; max: number; required?: true }
  | { kind: 'list'; of: Spec; min: number; max: number; required?: true }
  | { kind: 'object'; fields: Fields; required?: true });
export type Fields = Record<string, Spec>;

const text = (max: number, required?: true): Spec => ({ kind: 'text', max, required });
const list = (of: Spec, min: number, max: number, required?: true): Spec => ({ kind: 'list', of, min, max, required });
const oneOf = (values: string[], required?: true): Spec => ({ kind: 'oneOf', values, required });
const whole = (min: number, max: number): Spec => ({ kind: 'whole', min, max });
const about = (spec: Spec, description: string): Spec => ({ ...spec, about: description });

const objectOf = (fields: Fields): Spec => ({ kind: 'object', fields });

// ---- Format 4 ----

const LENGTHS: TextLength[] = ['sentence', 'paragraph', 'multi_paragraph'];
const LANGUAGES: Language[] = ['en', 'vi'];

const INSTRUCTION = text(1_000, true);
const LENGTH = about(oneOf(LENGTHS, true), 'Sets the size limit of the answer.');
const CONSTRAINTS = about(list(text(100), 0, 3), 'Up to 3 short rules the grader checks; the learner sees them too. Default [].');
const MODEL_ANSWER = about(text(20_000), 'A good answer by the author. The learner sees it after grading. Default null.');
const SOURCE_TEXT = text(20_000, true);

// One planted mistake of a correction.
const PLANTED_MISTAKE_FIELDS: Fields = {
  wrongText: about(text(200, true), 'Appears exactly once in sourceText.'),
  correctText: text(200, true),
  explanationMarkdown: about(text(1_000), 'Markdown: why it is wrong.'),
};
const CHOICE_OPTION_FIELDS: Fields = {
  text: text(500, true),
  isCorrect: about({ kind: 'flag' }, 'Default false.'),
  explanationMarkdown: about(text(1_000, true), 'Markdown: why this option is right or wrong.'),
};
const GAP_FIELDS: Fields = {
  acceptedAnswers: about(list(text(200), 1, 10, true), 'Every answer that counts as right.'),
  hint: about(text(100), 'Shown next to the gap.'),
  explanationMarkdown: about(text(1_000), 'Markdown: why the answer is right.'),
};

// The content fields of each type, `type` itself left out (it is checked first, to know which fields apply).
export const CONTENT_FIELDS: { [Type in ExerciseType]: Fields } = {
  rewrite: {
    instruction: INSTRUCTION,
    sourceText: about(SOURCE_TEXT, 'The text to say another way.'),
    length: LENGTH,
    constraints: CONSTRAINTS,
    modelAnswer: MODEL_ANSWER,
  },
  translation: {
    instruction: INSTRUCTION,
    sourceText: about(SOURCE_TEXT, 'The text to translate, in sourceLanguage.'),
    sourceLanguage: oneOf(LANGUAGES, true),
    targetLanguage: about(oneOf(LANGUAGES, true), 'Not the same as sourceLanguage.'),
    length: LENGTH,
    constraints: CONSTRAINTS,
    modelAnswer: MODEL_ANSWER,
  },
  correction: {
    instruction: INSTRUCTION,
    sourceText: about(SOURCE_TEXT, 'The text with the mistakes; the answer box starts with it.'),
    length: LENGTH,
    plantedMistakes: about(list(objectOf(PLANTED_MISTAKE_FIELDS), 0, 30), 'The mistakes put in sourceText on purpose. Default [].'),
    constraints: CONSTRAINTS,
    modelAnswer: MODEL_ANSWER,
  },
  essay: {
    instruction: text(2_000, true),
    minWords: about(whole(1, 2_000), 'Default 250.'),
    suggestedMinutes: about(whole(1, 180), 'A guide, never a limit. Default null.'),
    constraints: CONSTRAINTS,
    modelAnswer: MODEL_ANSWER,
  },
  choice: {
    instruction: text(1_000),
    question: text(2_000, true),
    context: about(text(5_000), 'A text the question is about.'),
    options: about(
      list(objectOf(CHOICE_OPTION_FIELDS), 2, 6, true),
      'One correct option is single choice; two or more is multi-select. At least one must be correct.',
    ),
  },
  gap_fill: {
    instruction: text(1_000),
    textWithGaps: about(text(5_000, true), 'Holds the markers {{1}} {{2}} ..., one per gap, in order.'),
    gaps: list(objectOf(GAP_FIELDS), 1, 30, true),
  },
  flashcard: {
    front: text(300, true),
    back: text(2_000, true),
    hint: text(300),
    example: about(text(1_000), 'An example sentence, plain text.'),
    explanationMarkdown: about(text(5_000), 'Markdown, up to 5,000 characters: the concept and a worked explanation, rendered under the answer.'),
  },
};

// The rules a field list cannot say (checkRelations), for the schema's description of each type.
export const TYPE_RULES: { [Type in ExerciseType]: string } = {
  rewrite: 'Say the same text another way. Graded by the AI.',
  translation: 'Translate sourceText from sourceLanguage into targetLanguage; the two differ. Graded by the AI.',
  correction: 'Fix the mistakes in sourceText; the answer box starts with it. Each plantedMistakes[].wrongText appears exactly once in sourceText. Graded by the AI.',
  essay: 'Free writing, for example IELTS Task 2. Graded by the AI with estimated bands.',
  choice: 'Graded by the AI. At least one option has isCorrect: true.',
  gap_fill: 'Graded by the AI. textWithGaps holds the markers {{1}} to {{n}} in order, one per gap.',
  flashcard: 'Not graded: you flip it and rate yourself.',
};

// The fields of an exercise around its content. The key is required in a file, and may be left out in PUT (the URL
// names the exercise).
export function exerciseFields(is_key_required: boolean): Fields {
  const key: Spec = is_key_required ? { kind: 'key', required: true } : { kind: 'key' };
  return {
    key: about(key, 'Names the exercise inside its project.'),
    topic: text(100),
    tags: about(list(text(40), 0, 10), 'Shown as chips. Default [].'),
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
  archivedAt: about({ kind: 'time' }, 'A time hides the project from the default list; null shows it. Default null.'),
};

// ---- Format 3 (read only; format-3.ts converts it) ----

const FORMAT_3_MISTAKE_FIELDS: Fields = { wrong: text(200, true), right: text(200, true), note: text(500) };
const FORMAT_3_OPTION_FIELDS: Fields = { text: text(500, true), why: text(1_000, true), correct: { kind: 'flag' } };
const FORMAT_3_GAP_FIELDS: Fields = { answer: { kind: 'texts', max: 200, required: true }, hint: text(100), why: text(1_000) };

const FORMAT_3_CONTENT_FIELDS: { [Type in Format3Type]: Fields } = {
  rewrite: {
    instruction: text(1_000, true),
    text: text(20_000, true),
    length: oneOf(['sentence', 'paragraph', 'essay'], true),
    source_lang: oneOf(['en', 'vi']),
    prefill: { kind: 'flag' },
    constraints: list(text(100), 1, 3),
    mistakes: list(objectOf(FORMAT_3_MISTAKE_FIELDS), 1, 30),
    reference: text(20_000),
  },
  write: {
    prompt: text(2_000, true),
    min_words: whole(1, 2_000),
    minutes: whole(1, 180),
    sample: text(20_000),
  },
  choice: {
    question: text(2_000, true),
    context: text(5_000),
    options: list(objectOf(FORMAT_3_OPTION_FIELDS), 2, 6, true),
  },
  fill: {
    text: text(5_000, true),
    gaps: list(objectOf(FORMAT_3_GAP_FIELDS), 1, 30, true),
    instruction: text(1_000),
  },
  flashcard: {
    front: text(300, true),
    back: text(2_000, true),
    hint: text(300),
    example: text(1_000),
    explanation: text(5_000),
  },
};

function format3ExerciseFields(): Fields {
  return { ...exerciseFields(true), type: oneOf(FORMAT_3_TYPES, true) };
}

// ---- The checks ----

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type Segment = string | number;

// ["exercises", 5, "content"] -> "/exercises/5/content" (RFC 6901).
function pointerOf(segments: Segment[]): string {
  return segments.map((segment) => `/${String(segment).replaceAll('~', '~0').replaceAll('/', '~1')}`).join('');
}

// ["content", "options", 0, "explanationMarkdown"] -> "content.options[0].explanationMarkdown", the name a person reads.
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
    case 'time': {
      const is_time = typeof value === 'string' && TIME_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
      if (!is_time) problems.add(at, 'wrong_type', TIME_RULE);
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

function isRequired(spec: Spec): boolean {
  return 'required' in spec && spec.required === true;
}

// A field left out, or null where it may be left out: either way it takes its default.
function isLeftOut(value: unknown, spec: Spec): boolean {
  if (value === undefined) return true;
  return value === null && !isRequired(spec);
}

function checkFields(object: Record<string, unknown>, fields: Fields, at: Segment[], problems: Problems): void {
  for (const key of Object.keys(object)) {
    if (!Object.hasOwn(fields, key)) problems.add([...at, key], 'unknown_field', 'is not a known field.');
  }
  for (const [key, spec] of Object.entries(fields)) {
    const value = object[key];
    if (!isLeftOut(value, spec)) checkValue(value, spec, [...at, key], problems);
    else if (isRequired(spec)) problems.add([...at, key], 'required', 'is missing.');
  }
}

// A choice exercise needs at least one correct option.
function checkChoiceOptions(options: unknown[], correct_field: string, problems: Problems): void {
  const has_correct_option = options.some((option) => isObject(option) && option[correct_field] === true);
  if (!has_correct_option) problems.addRule(['content', 'options'], 'no_correct_option', 'no option is marked correct.');
}

// A gap-fill text holds {{1}} to {{n}}, in order, one per gap.
function checkGapMarkers(text_field: string, text: string, gaps: unknown[], problems: Problems): void {
  const markers = [...text.matchAll(/\{\{(\d+)\}\}/g)].map((match) => Number(match[1]));
  const is_in_order = markers.length === gaps.length && markers.every((marker, index) => marker === index + 1);
  if (is_in_order) return;
  const found = markers.map((marker) => `{{${marker}}}`).join(' ') || 'none';
  const message = `the markers must be {{1}} to {{${gaps.length}}} in order, one per gap (found ${found}).`;
  problems.addRule(['content', text_field], 'gap_markers', message);
}

// Each planted mistake of a correction appears exactly once in its text.
function checkMistakes(names: { text: string; list: string; wrong: string }, text: string, mistakes: unknown[], problems: Problems): void {
  mistakes.forEach((mistake, index) => {
    if (!isObject(mistake)) return;
    const wrong = mistake[names.wrong];
    if (typeof wrong !== 'string' || wrong === '') return;
    const count = text.split(wrong).length - 1;
    if (count === 1) return;
    const message = `"${wrong}" must appear exactly once in ${names.text} (found ${count}).`;
    problems.add(['content', names.list, index, names.wrong], 'mistake_not_once', message);
  });
}

// The rules a field list cannot say (format 4). They run on what looks right so far, so one slip is not reported twice.
function checkRelations(type: ExerciseType, content: Record<string, unknown>, problems: Problems): void {
  if (type === 'choice' && Array.isArray(content.options)) {
    checkChoiceOptions(content.options, 'isCorrect', problems);
  } else if (type === 'gap_fill' && typeof content.textWithGaps === 'string' && Array.isArray(content.gaps)) {
    checkGapMarkers('textWithGaps', content.textWithGaps, content.gaps, problems);
  } else if (type === 'correction' && typeof content.sourceText === 'string' && Array.isArray(content.plantedMistakes)) {
    const names = { text: 'sourceText', list: 'plantedMistakes', wrong: 'wrongText' };
    checkMistakes(names, content.sourceText, content.plantedMistakes, problems);
  } else if (type === 'translation' && LANGUAGES.includes(content.sourceLanguage as Language)) {
    if (content.sourceLanguage === content.targetLanguage) {
      problems.add(['content', 'targetLanguage'], 'same_language', 'must not be the same as sourceLanguage.');
    }
  }
}

// The same rules, for format 3.
function checkFormat3Relations(type: Format3Type, content: Record<string, unknown>, problems: Problems): void {
  if (type === 'choice' && Array.isArray(content.options)) {
    checkChoiceOptions(content.options, 'correct', problems);
  } else if (type === 'fill' && typeof content.text === 'string' && Array.isArray(content.gaps)) {
    checkGapMarkers('text', content.text, content.gaps, problems);
  } else if (type === 'rewrite' && typeof content.text === 'string' && Array.isArray(content.mistakes)) {
    checkMistakes({ text: 'text', list: 'mistakes', wrong: 'wrong' }, content.text, content.mistakes, problems);
  }
}

// ---- Defaults: a checked format 4 content with every optional field filled in ----

function textOrNull(value: unknown): string | null {
  if (typeof value === 'string') return value;
  return null;
}

function listOrEmpty<Item>(value: unknown): Item[] {
  if (Array.isArray(value)) return value;
  return [];
}

function plantedMistakeOf(value: Record<string, unknown>): PlantedMistake {
  return {
    wrongText: value.wrongText as string,
    correctText: value.correctText as string,
    explanationMarkdown: textOrNull(value.explanationMarkdown),
  };
}

function choiceOptionOf(value: Record<string, unknown>): ChoiceOption {
  return {
    text: value.text as string,
    isCorrect: value.isCorrect === true,
    explanationMarkdown: value.explanationMarkdown as string,
  };
}

function gapOf(value: Record<string, unknown>): Gap {
  return {
    acceptedAnswers: value.acceptedAnswers as string[],
    hint: textOrNull(value.hint),
    explanationMarkdown: textOrNull(value.explanationMarkdown),
  };
}

// The content as it is stored. Called only on content without problems, so every field has the shape its spec says.
// The fields are written in the spec's order, so two equal contents are also equal as JSON text.
function contentWithDefaults(type: ExerciseType, content: Record<string, unknown>): ExerciseContent {
  const instruction = content.instruction as string;
  const source_text = content.sourceText as string;
  const length = content.length as TextLength;
  const constraints = listOrEmpty<string>(content.constraints);
  const model_answer = textOrNull(content.modelAnswer);
  switch (type) {
    case 'rewrite':
      return { type, instruction, sourceText: source_text, length, constraints, modelAnswer: model_answer };
    case 'translation':
      return {
        type,
        instruction,
        sourceText: source_text,
        sourceLanguage: content.sourceLanguage as Language,
        targetLanguage: content.targetLanguage as Language,
        length,
        constraints,
        modelAnswer: model_answer,
      };
    case 'correction': {
      const mistakes = listOrEmpty<Record<string, unknown>>(content.plantedMistakes);
      return {
        type,
        instruction,
        sourceText: source_text,
        length,
        plantedMistakes: mistakes.map(plantedMistakeOf),
        constraints,
        modelAnswer: model_answer,
      };
    }
    case 'essay': {
      let min_words = 250;
      if (typeof content.minWords === 'number') min_words = content.minWords;
      let suggested_minutes: number | null = null;
      if (typeof content.suggestedMinutes === 'number') suggested_minutes = content.suggestedMinutes;
      return { type, instruction, minWords: min_words, suggestedMinutes: suggested_minutes, constraints, modelAnswer: model_answer };
    }
    case 'choice': {
      const options = listOrEmpty<Record<string, unknown>>(content.options);
      return {
        type,
        instruction: textOrNull(content.instruction),
        question: content.question as string,
        context: textOrNull(content.context),
        options: options.map(choiceOptionOf),
      };
    }
    case 'gap_fill': {
      const gaps = listOrEmpty<Record<string, unknown>>(content.gaps);
      return {
        type,
        instruction: textOrNull(content.instruction),
        textWithGaps: content.textWithGaps as string,
        gaps: gaps.map(gapOf),
      };
    }
    case 'flashcard':
      return {
        type,
        front: content.front as string,
        back: content.back as string,
        hint: textOrNull(content.hint),
        example: textOrNull(content.example),
        explanationMarkdown: textOrNull(content.explanationMarkdown),
      };
  }
}

// ---- One exercise ----

// The topic and tags of an exercise without problems: null and [] when left out.
function topicAndTagsOf(value: Record<string, unknown>): { topic: string | null; tags: string[] } {
  return { topic: textOrNull(value.topic), tags: listOrEmpty<string>(value.tags) };
}

// The content of a format 4 exercise; its problems added. null when it has problems, or no known type.
function checkContent(content: unknown, problems: Problems): ExerciseContent | null {
  const count_before = problems.list.length;
  if (content === undefined || content === null) {
    problems.add(['content'], 'required', 'is missing.');
    return null;
  }
  if (!isObject(content)) {
    problems.add(['content'], 'wrong_type', 'must be an object.');
    return null;
  }
  const { type: type_value, ...fields } = content;
  const type = EXERCISE_TYPES.find((known) => known === type_value);
  if (type_value === undefined) {
    problems.add(['content', 'type'], 'required', 'is missing.');
    return null;
  }
  if (type === undefined) {
    problems.add(['content', 'type'], 'not_allowed', `must be one of: ${EXERCISE_TYPES.join(', ')}.`);
    return null;
  }
  checkFields(fields, CONTENT_FIELDS[type], ['content'], problems);
  checkRelations(type, content, problems);
  if (problems.list.length > count_before) return null;
  return contentWithDefaults(type, content);
}

// One format 4 exercise, its problems added under problems.base; the exercise when it has none.
// url_key: in PUT, the key in the URL, which a key in the body must equal.
function checkExercise(value: unknown, problems: Problems, url_key: string | null = null): FileExercise | null {
  const count_before = problems.list.length;
  if (!isObject(value)) {
    problems.add([], 'wrong_type', 'must be an object.');
    return null;
  }
  const { content: content_value, ...outer } = value;
  checkFields(outer, exerciseFields(url_key === null), [], problems);
  if (url_key !== null && typeof value.key === 'string' && KEY_PATTERN.test(value.key) && value.key !== url_key) {
    problems.add(['key'], 'key_mismatch', `"${value.key}" is not the key in the URL ("${url_key}").`);
  }
  const content = checkContent(content_value, problems);
  if (problems.list.length > count_before || content === null) return null;
  return { key: url_key ?? (value.key as string), ...topicAndTagsOf(value), content };
}

// One format 3 exercise, checked by the format 3 rules, then converted.
function checkFormat3Exercise(value: unknown, problems: Problems): FileExercise | null {
  const count_before = problems.list.length;
  if (!isObject(value)) {
    problems.add([], 'wrong_type', 'must be an object.');
    return null;
  }
  const { content, ...outer } = value;
  checkFields(outer, format3ExerciseFields(), [], problems);
  const type = FORMAT_3_TYPES.find((known) => known === value.type);
  if (content === undefined || content === null) problems.add(['content'], 'required', 'is missing.');
  else if (!isObject(content)) problems.add(['content'], 'wrong_type', 'must be an object.');
  else if (type !== undefined) {
    checkFields(content, FORMAT_3_CONTENT_FIELDS[type], ['content'], problems);
    checkFormat3Relations(type, content, problems);
  }
  if (problems.list.length > count_before || type === undefined) return null;
  // No problems, so every field has the shape its spec says.
  const converted = contentFromFormat3(type, content as unknown as Format3Content);
  return { key: value.key as string, ...topicAndTagsOf(value), content: converted };
}

// ---- A whole file ----

export type CheckedFile = { file: ProjectFile; problems: null } | { file: null; problems: Problem[] };

const FORMAT_2_EDITS = 'To make a format 2 file format 3 (still read): set "format" to 3, add a "key" to "project" (a-z, 0-9 and -, like "m1-day-01"), and rename each exercise\'s "id" to "key".';

// A parsed file (format 4, or format 3): the project it describes, or every problem.
export function checkImportValue(parsed: unknown): CheckedFile {
  if (!isObject(parsed)) return { file: null, problems: [{ path: '', code: 'wrong_type', message: 'The file must be one JSON object.' }] };
  const problems = new Problems();
  for (const key of Object.keys(parsed)) {
    if (!['format', 'project', 'exercises'].includes(key)) problems.add([key], 'unknown_field', 'is not a known field.');
  }
  if (parsed.format === 2) problems.add(['format'], 'unsupported_format', `must be 4 or 3. ${FORMAT_2_EDITS}`);
  else if (!IMPORT_FORMATS.includes(parsed.format as number)) problems.add(['format'], 'unsupported_format', 'must be 4 (format 3 is still read).');
  if (isObject(parsed.project)) checkFields(parsed.project, PROJECT_FIELDS, ['project'], problems);
  else problems.add(['project'], parsed.project === undefined ? 'required' : 'wrong_type', 'is missing.');
  // A format 2 file is closest to format 3, so its exercises are checked by those rules.
  const is_format_3 = parsed.format === 3 || parsed.format === 2;
  const exercises = checkFileExercises(parsed.exercises, is_format_3, problems);
  if (problems.list.length > 0) return { file: null, problems: problems.list };
  const project = parsed.project as { key: string; name: string; description?: string | null };
  const file: ProjectFile = {
    key: project.key,
    name: project.name.trim(),
    description: textOrNull(project.description)?.trim() ?? null,
    exercises,
  };
  return { file, problems: null };
}

// The file's "exercises": a list of 1 to MAX_EXERCISES exercises, each key used once. The ones without problems.
function checkFileExercises(value: unknown, is_format_3: boolean, problems: Problems): FileExercise[] {
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
    let exercise: FileExercise | null;
    if (is_format_3) exercise = checkFormat3Exercise(exercise_value, exercise_problems);
    else exercise = checkExercise(exercise_value, exercise_problems);
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

// The body of PUT .../exercises/:key (format 4): the exercise, or every problem.
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
  checkFields(value, PROJECT_INPUT_FIELDS, [], problems);
  if (problems.list.length > 0) return { project: null, problems: problems.list };
  const project = {
    name: (value.name as string).trim(),
    description: textOrNull(value.description)?.trim() ?? null,
    archivedAt: textOrNull(value.archivedAt),
  };
  return { project, problems: null };
}

// A key in a URL, as a problem when it cannot be one ("#key", per docs/practice-api-design.md §3.3).
export function keyProblems(key: string): Problem[] {
  return KEY_PATTERN.test(key) ? [] : [{ path: '#key', code: 'bad_key', message: `The key in the URL ${KEY_RULE}` }];
}

// The type an exercise of a file names: content.type (format 4) or type (format 3). null when it names no known one.
function typeNamedBy(exercise: Record<string, unknown>): string | null {
  const known_types: string[] = [...EXERCISE_TYPES, ...FORMAT_3_TYPES];
  let type = exercise.type;
  if (isObject(exercise.content) && exercise.content.type !== undefined) type = exercise.content.type;
  if (typeof type === 'string' && known_types.includes(type)) return type;
  return null;
}

// A problem as one line for a person: "Exercise 6 (choice, d2-pick-1): content.options: no option is marked correct."
// exercises: the file's exercises as sent, to name the one a problem is in (1-based, with its type and key when it has them).
export function problemLine(problem: Problem, exercises: unknown): string {
  const match = /^\/exercises\/(\d+)(?:\/|$)/.exec(problem.path);
  if (match === null) return problem.message;
  const index = Number(match[1]);
  const exercise = Array.isArray(exercises) ? exercises[index] : undefined;
  const type = isObject(exercise) ? typeNamedBy(exercise) : null;
  const key = isObject(exercise) && typeof exercise.key === 'string' && KEY_PATTERN.test(exercise.key) ? exercise.key : null;
  const label = [type, key].filter((part) => part !== null);
  return `Exercise ${index + 1}${label.length > 0 ? ` (${label.join(', ')})` : ''}: ${problem.message}`;
}
