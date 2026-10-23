// Making a project from a translated post (docs/practice-from-translation-design.md §4): how many exercises of each kind,
// the message the model gets, and the check of its reply. Pure, so the server and scripts/eval-generation.ts run the
// same code.
import type { GenerationBlock, GenerationRequest } from '../../shared/api-types.ts';
import type { FileExercise, ProjectFile } from './api-types.ts';
import { checkExerciseInput, fieldProblems, isObject, KEY_PATTERN, problemLine, type Fields, type Problem } from './import-check.ts';
import { countWords, slugOf } from './text.ts';

// The sample (data/practice-imports/t-24-php-security.json) has 50 exercises for 1,860 words.
const WORDS_PER_EXERCISE = 37;
export const MIN_EXERCISES = 10;
export const MAX_GENERATED_EXERCISES = 50;
// A shorter post has too little English to make ten good exercises from.
export const MIN_POST_WORDS = 150;
// Below this share of the plan kept, the run fails: dropping more would leave a thin project.
const MIN_KEPT_SHARE = 0.8;
// The warning threshold for a full post; the sample has 13.
const MIN_GRAMMAR_TAGS = 8;
const MAX_NAME_CHARS = 80;
const MAX_DESCRIPTION_CHARS = 500;
// Vietnamese letters with a mark: a gloss without any is not in Vietnamese. The Latin-1 ones are listed too ("hoá").
const VIETNAMESE_LETTER = /[àáâãèéêìíòóôõùúýăđĩũơưạ-ỹ]/i;
// Translate's first-token formula (translate/server/routes.ts): reading a long input delays the first token.
const CHARS_PER_TOKEN = { en: 4, vi: 1.3 };
const FIRST_TOKEN_MS_PER_INPUT_TOKEN = 0.1;

export type GenerationKind = 'flashcard' | 'vocab' | 'grammar' | 'meaning';
// The order the kinds take in the plan, the prompt and the reply.
export const GENERATION_KINDS: GenerationKind[] = ['flashcard', 'vocab', 'grammar', 'meaning'];
// The owner's mix for a full post: 18 + 10 + 13 + 9 = 50.
const KIND_SHARES: Record<GenerationKind, number> = { flashcard: 18, vocab: 10, grammar: 13, meaning: 9 };

export type GenerationPlan = { total: number } & Record<GenerationKind, number>;

// What a generation is made from.
export type GenerationPost = Pick<GenerationRequest, 'translationId' | 'title' | 'blocks'>;

// A reply that passed: the exercises kept, one line per problem of a dropped one, and quality signals for the log.
export interface GoodReply {
  name: string;
  topic: string;
  exercises: FileExercise[];
  droppedCount: number;
  droppedLines: string[];
  warnings: string[];
}

// The body of POST /generations (GenerationRequest). A block's texts may be as long as a whole post (Translate takes
// 100,000 characters).
const GENERATION_REQUEST_FIELDS: Fields = {
  translationId: { kind: 'whole', min: 1, max: Number.MAX_SAFE_INTEGER, required: true },
  title: { kind: 'text', max: 1_000, required: true },
  sourceLanguage: { kind: 'oneOf', values: ['en'], required: true, about: 'Only English posts can be practised.' },
  blocks: {
    kind: 'list',
    min: 1,
    max: 5_000,
    required: true,
    of: {
      kind: 'object',
      fields: { sourceText: { kind: 'text', max: 100_000, required: true }, translatedText: { kind: 'text', max: 100_000, required: true } },
    },
  },
};

// Every problem of a generation request: its fields, then a post too short to practise.
export function generationRequestProblems(body: Record<string, unknown>): Problem[] {
  const problems = fieldProblems(body, GENERATION_REQUEST_FIELDS);
  if (problems.length > 0) return problems;
  const words = postWordCount(body.blocks as GenerationBlock[]);
  if (words < MIN_POST_WORDS) {
    const message = `The post has ${words} English words; at least ${MIN_POST_WORDS} are needed to make exercises.`;
    problems.push({ path: '/blocks', code: 'too_short', message });
  }
  return problems;
}

export function postWordCount(blocks: GenerationBlock[]): number {
  let words = 0;
  for (const block of blocks) words += countWords(block.sourceText);
  return words;
}

// total = words / 37, from 10 to 50, split 18:10:13:9 by largest remainder (ties go to the kind listed first).
export function planOf(words: number): GenerationPlan {
  const rawTotal = Math.round(words / WORDS_PER_EXERCISE);
  const total = Math.min(MAX_GENERATED_EXERCISES, Math.max(MIN_EXERCISES, rawTotal));
  const shareSum = GENERATION_KINDS.reduce((sum, kind) => sum + KIND_SHARES[kind], 0);
  const plan: GenerationPlan = { total, flashcard: 0, vocab: 0, grammar: 0, meaning: 0 };
  const remainders: { kind: GenerationKind; remainder: number }[] = [];
  let assigned = 0;
  for (const kind of GENERATION_KINDS) {
    const exact = (total * KIND_SHARES[kind]) / shareSum;
    plan[kind] = Math.floor(exact);
    assigned += plan[kind];
    remainders.push({ kind, remainder: exact - plan[kind] });
  }
  // A stable sort keeps the listed order among equal remainders.
  remainders.sort((first, second) => second.remainder - first.remainder);
  for (let index = 0; index < total - assigned; index++) plan[remainders[index].kind]++;
  return plan;
}

// The post as the model reads it, English and Vietnamese side by side, after the plan.
export function userMessageOf(post: GenerationPost, plan: GenerationPlan): string {
  const counts = GENERATION_KINDS.map((kind) => `${kind}="${plan[kind]}"`).join(' ');
  const title = post.title.replaceAll('"', '&quot;');
  const blockLines = post.blocks.map((block, index) => {
    return `<block n="${index + 1}"><en>${block.sourceText}</en><vi>${block.translatedText}</vi></block>`;
  });
  const lines = [
    'Make exercises from this post.',
    `<plan total="${plan.total}" ${counts}/>`,
    `<post title="${title}" translation_id="${post.translationId}">`,
    ...blockLines,
    '</post>',
  ];
  return lines.join('\n');
}

// Added to the runner's first-token limits, by Translate's formula, for the English and the Vietnamese it reads.
export function firstTokenAllowanceMsOf(blocks: GenerationBlock[]): number {
  let tokens = 0;
  for (const block of blocks) {
    tokens += block.sourceText.length / CHARS_PER_TOKEN.en;
    tokens += block.translatedText.length / CHARS_PER_TOKEN.vi;
  }
  return Math.round(tokens * FIRST_TOKEN_MS_PER_INPUT_TOKEN);
}

// "flashcard", or a choice's first tag: "vocab", "grammar", "meaning". null when it is none of these.
export function kindOf(exercise: FileExercise): GenerationKind | null {
  if (exercise.content.type === 'flashcard') return 'flashcard';
  const firstTag = exercise.tags[0];
  if (firstTag === 'vocab' || firstTag === 'grammar' || firstTag === 'meaning') return firstTag;
  return null;
}

// The reply as JSON: one object, maybe in one ```json fence. null when it is not.
function parseReply(reply: string): unknown {
  let text = reply.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*)\n```$/.exec(text);
  if (fence !== null) text = fence[1];
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// The rules of a generated exercise beyond the import rules: a flashcard or a single-answer choice of 4 distinct
// options, and a first tag that names its kind.
function generationProblems(exercise: FileExercise): Problem[] {
  const problems: Problem[] = [];
  const { content } = exercise;
  if (content.type === 'choice') {
    const correctCount = content.options.filter((option) => option.isCorrect).length;
    const texts = content.options.map((option) => option.text.trim().toLowerCase());
    const distinctCount = new Set(texts).size;
    if (content.options.length !== 4) {
      problems.push({ path: '/content/options', code: 'option_count', message: `content.options: must be 4 options (found ${content.options.length}).` });
    }
    if (correctCount !== 1) {
      problems.push({ path: '/content/options', code: 'correct_count', message: `content.options: exactly one must be correct (found ${correctCount}).` });
    }
    if (distinctCount !== texts.length) {
      problems.push({ path: '/content/options', code: 'duplicate_option', message: 'content.options: two options have the same text.' });
    }
  } else if (content.type !== 'flashcard') {
    problems.push({ path: '/content/type', code: 'not_allowed', message: 'content.type must be flashcard or choice.' });
  }
  const kind = kindOf(exercise);
  const isFlashcardTagRight = content.type !== 'flashcard' || exercise.tags[0] === 'vocab';
  if (kind === null || !isFlashcardTagRight) {
    const allowed = content.type === 'flashcard' ? 'vocab' : 'vocab, grammar or meaning';
    problems.push({ path: '/tags/0', code: 'bad_first_tag', message: `tags[0] must be ${allowed}.` });
  }
  return problems;
}

// Quality signals, never a reason to drop: the mix against the plan, the spread of grammar points, the Vietnamese glosses.
function warningsOf(exercises: FileExercise[], plan: GenerationPlan): string[] {
  const warnings: string[] = [];
  for (const kind of GENERATION_KINDS) {
    const count = exercises.filter((exercise) => kindOf(exercise) === kind).length;
    if (count !== plan[kind]) warnings.push(`${count} ${kind} exercises, ${plan[kind]} planned.`);
  }
  const grammarTags = new Set(exercises.flatMap((exercise) => exercise.tags.filter((tag) => tag.startsWith('grammar:'))));
  if (plan.total === MAX_GENERATED_EXERCISES && grammarTags.size < MIN_GRAMMAR_TAGS) {
    warnings.push(`Only ${grammarTags.size} distinct grammar tags.`);
  }
  for (const exercise of exercises) {
    if (!hasVietnamese(exercise)) warnings.push(`${exercise.key}: no Vietnamese in the gloss.`);
  }
  return warnings;
}

// A flashcard's back, or the right option of a meaning choice, holds Vietnamese; true for any other exercise.
export function hasVietnamese(exercise: FileExercise): boolean {
  const { content } = exercise;
  if (content.type === 'flashcard') return VIETNAMESE_LETTER.test(content.back);
  if (content.type !== 'choice' || kindOf(exercise) !== 'meaning') return true;
  const rightOption = content.options.find((option) => option.isCorrect);
  if (rightOption === undefined) return false;
  return VIETNAMESE_LETTER.test(`${rightOption.text} ${rightOption.explanationMarkdown}`);
}

// One exercise of the reply, with the reply's topic when it has none: the exercise, or its problems (paths from the reply's
// root, so problemLine names the exercise).
function checkGeneratedExercise(value: unknown, index: number, topic: string): { exercise: FileExercise | null; problems: Problem[] } {
  const at = (problem: Problem): Problem => ({ ...problem, path: `/exercises/${index}${problem.path}` });
  if (!isObject(value)) {
    return { exercise: null, problems: [at({ path: '', code: 'wrong_type', message: 'must be an object.' })] };
  }
  const key = typeof value.key === 'string' ? value.key : '';
  if (!KEY_PATTERN.test(key)) {
    const problem = { path: '/key', code: 'bad_key', message: 'key must be 1 to 64 of a-z, 0-9 and -, not starting with -.' };
    return { exercise: null, problems: [at(problem)] };
  }
  const isTopicLeftOut = value.topic === undefined || value.topic === null;
  const filled = isTopicLeftOut ? { ...value, topic } : value;
  const checked = checkExerciseInput(filled, key);
  if (checked.exercise === null) return { exercise: null, problems: checked.problems.map(at) };
  const exercise: FileExercise = { key, ...checked.exercise };
  return { exercise, problems: generationProblems(exercise).map(at) };
}

// The model's reply (docs/practice-from-translation-design.md §4.4). A bad exercise is dropped, not repaired; the run fails
// when the reply is not the JSON object asked for, or when fewer than 80% of the plan are left.
export function checkReply(reply: string, plan: GenerationPlan): { reply: GoodReply; problem: null } | { reply: null; problem: string } {
  const parsed = parseReply(reply);
  const shapeProblem = 'The reply is not a JSON object with name, topic and exercises.';
  if (!isObject(parsed)) return { reply: null, problem: shapeProblem };
  const { name: nameValue, topic: topicValue, exercises: exerciseValues } = parsed;
  const isReplyShape = typeof nameValue === 'string' && typeof topicValue === 'string' && Array.isArray(exerciseValues);
  if (!isReplyShape || nameValue.trim() === '') return { reply: null, problem: shapeProblem };
  const topic = topicValue.trim();
  const exercises: FileExercise[] = [];
  const droppedLines: string[] = [];
  const usedKeys = new Set<string>();
  exerciseValues.forEach((value, index) => {
    const { exercise, problems } = checkGeneratedExercise(value, index, topic);
    if (exercise !== null && usedKeys.has(exercise.key)) {
      problems.push({ path: `/exercises/${index}/key`, code: 'duplicate_key', message: `key "${exercise.key}" is used twice.` });
    }
    if (exercise !== null && problems.length === 0) {
      exercises.push(exercise);
      usedKeys.add(exercise.key);
      return;
    }
    for (const problem of problems) droppedLines.push(problemLine(problem, exerciseValues));
  });
  const droppedCount = exerciseValues.length - exercises.length;
  const minKept = Math.ceil(plan.total * MIN_KEPT_SHARE);
  if (exercises.length < minKept) {
    const firstLines = droppedLines.slice(0, 3).join(' ');
    const problem = `Only ${exercises.length} of the ${plan.total} exercises asked for passed the check. ${firstLines}`;
    return { reply: null, problem: problem.trim() };
  }
  const name = nameValue.trim().slice(0, MAX_NAME_CHARS);
  const warnings = warningsOf(exercises, plan);
  return { reply: { name, topic, exercises, droppedCount, droppedLines, warnings }, problem: null };
}

// "t-24-php-security-release": the translation's id and the project's name, at most 64 characters.
export function projectKeyOf(translationId: number, name: string): string {
  const prefix = `t-${translationId}`;
  const slug = slugOf(name, 64 - prefix.length - 1);
  if (slug === '') return prefix;
  return `${prefix}-${slug}`;
}

// The project made from a good reply, as an import file holds it.
export function projectFileOf(post: Pick<GenerationPost, 'translationId' | 'title'>, reply: GoodReply, key: string): ProjectFile {
  const count = reply.exercises.length;
  const description = `Made from translation ${post.translationId}: "${post.title}". ${count} flashcards and multiple-choice questions on the post's vocabulary, grammar and meaning.`;
  return {
    key,
    name: reply.name,
    description: description.slice(0, MAX_DESCRIPTION_CHARS),
    exercises: reply.exercises,
  };
}
