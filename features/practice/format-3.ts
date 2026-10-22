// Format 3: the import file, the stored exercise content and the answers from before the data model of
// docs/data-model-proposal.md. The importer still reads format 3 files, the schema 3 migration moves stored rows with
// the same functions, and the page uses them for drafts saved before. Pure, so the server and the browser share it.
// The mapping is the spec's §5.
import type { Answer, ChoiceOption, ExerciseContent, ExerciseType, FlashcardRating, Gap, PlantedMistake } from './api.ts';

export type Format3Type = 'rewrite' | 'write' | 'choice' | 'fill' | 'flashcard';
export type Format3Length = 'sentence' | 'paragraph' | 'essay';

export interface Format3Rewrite {
  instruction: string;
  text: string;
  length: Format3Length;
  // 'vi' makes it a translation. Default 'en'.
  source_lang?: 'en' | 'vi';
  // The answer box starts with `text`: error correction.
  prefill?: boolean;
  constraints?: string[];
  mistakes?: Format3Mistake[];
  reference?: string;
}

export interface Format3Mistake {
  wrong: string;
  right: string;
  note?: string;
}

export interface Format3Write {
  prompt: string;
  // Default 250.
  min_words?: number;
  minutes?: number;
  sample?: string;
}

export interface Format3Choice {
  question: string;
  context?: string;
  options: { text: string; why: string; correct?: boolean }[];
}

export interface Format3Fill {
  text: string;
  // answer: a text or a list of accepted answers.
  gaps: { answer: string | string[]; hint?: string; why?: string }[];
  instruction?: string;
}

export interface Format3Flashcard {
  front: string;
  back: string;
  hint?: string;
  example?: string;
  explanation?: string;
}

export interface Format3ContentByType {
  rewrite: Format3Rewrite;
  write: Format3Write;
  choice: Format3Choice;
  fill: Format3Fill;
  flashcard: Format3Flashcard;
}

export type Format3Content = Format3ContentByType[Format3Type];

// Format 3 had no default for an essay's length but this one.
const DEFAULT_MIN_WORDS = 250;

// An optional format 3 field as the new model holds it: a missing one is null. (A file checked by import-check.ts never
// has null in it, but a stored row is not checked, so null is read as missing too.)
function orNull<Value>(value: Value | undefined | null): Value | null {
  if (value === undefined) return null;
  return value;
}

function textLengthOf(length: Format3Length) {
  if (length === 'essay') return 'multi_paragraph' as const;
  return length;
}

function plantedMistakeOf(mistake: Format3Mistake): PlantedMistake {
  return {
    wrongText: mistake.wrong,
    correctText: mistake.right,
    explanationMarkdown: orNull(mistake.note),
  };
}

// A rewrite was three exercises in one: prefill made it a correction, source_lang 'vi' a translation. When both are set,
// prefill wins (the old page showed it as a correction too). Planted mistakes are kept only on a correction.
function rewriteContentOf(content: Format3Rewrite): ExerciseContent {
  const constraints = content.constraints ?? [];
  const modelAnswer = orNull(content.reference);
  const length = textLengthOf(content.length);
  if (content.prefill === true) {
    const mistakes = content.mistakes ?? [];
    return {
      type: 'correction',
      instruction: content.instruction,
      sourceText: content.text,
      length,
      plantedMistakes: mistakes.map(plantedMistakeOf),
      constraints,
      modelAnswer,
    };
  }
  if (content.source_lang === 'vi') {
    return {
      type: 'translation',
      instruction: content.instruction,
      sourceText: content.text,
      sourceLanguage: 'vi',
      targetLanguage: 'en',
      length,
      constraints,
      modelAnswer,
    };
  }
  return {
    type: 'rewrite',
    instruction: content.instruction,
    sourceText: content.text,
    length,
    constraints,
    modelAnswer,
  };
}

function essayContentOf(content: Format3Write): ExerciseContent {
  return {
    type: 'essay',
    instruction: content.prompt,
    minWords: content.min_words ?? DEFAULT_MIN_WORDS,
    suggestedMinutes: orNull(content.minutes),
    constraints: [],
    modelAnswer: orNull(content.sample),
  };
}

function choiceContentOf(content: Format3Choice): ExerciseContent {
  const options = content.options.map((option): ChoiceOption => ({
    text: option.text,
    isCorrect: option.correct === true,
    explanationMarkdown: option.why,
  }));
  return {
    type: 'choice',
    instruction: null,
    question: content.question,
    context: orNull(content.context),
    options,
  };
}

function gapFillContentOf(content: Format3Fill): ExerciseContent {
  const gaps = content.gaps.map((gap): Gap => {
    let accepted_answers = gap.answer;
    if (typeof accepted_answers === 'string') accepted_answers = [accepted_answers];
    return {
      acceptedAnswers: accepted_answers,
      hint: orNull(gap.hint),
      explanationMarkdown: orNull(gap.why),
    };
  });
  return {
    type: 'gap_fill',
    instruction: orNull(content.instruction),
    textWithGaps: content.text,
    gaps,
  };
}

function flashcardContentOf(content: Format3Flashcard): ExerciseContent {
  return {
    type: 'flashcard',
    front: content.front,
    back: content.back,
    hint: orNull(content.hint),
    example: orNull(content.example),
    explanationMarkdown: orNull(content.explanation),
  };
}

// A format 3 exercise's content in the new model, with every default filled in.
export function contentFromFormat3(type: Format3Type, content: Format3Content): ExerciseContent {
  switch (type) {
    case 'rewrite':
      return rewriteContentOf(content as Format3Rewrite);
    case 'write':
      return essayContentOf(content as Format3Write);
    case 'choice':
      return choiceContentOf(content as Format3Choice);
    case 'fill':
      return gapFillContentOf(content as Format3Fill);
    case 'flashcard':
      return flashcardContentOf(content as Format3Flashcard);
  }
}

const RATINGS: Record<string, FlashcardRating> = { unknown: 'didnt_know', almost: 'almost', known: 'knew' };

// A format 3 answer ({ text }, { chosen }, { gaps } or { rating }) in the new model, for an exercise of `type` (the type
// of its converted content). null when it does not have the shape that type needs.
export function answerFromFormat3(type: ExerciseType, answer: unknown): Answer | null {
  if (typeof answer !== 'object' || answer === null) return null;
  const fields = answer as Record<string, unknown>;
  switch (type) {
    case 'rewrite':
    case 'translation':
    case 'correction':
    case 'essay':
      if (typeof fields.text !== 'string') return null;
      return { type, text: fields.text };
    case 'choice':
      if (!Array.isArray(fields.chosen)) return null;
      return { type, chosenOptionIndexes: fields.chosen };
    case 'gap_fill':
      if (!Array.isArray(fields.gaps)) return null;
      return { type, gapAnswers: fields.gaps };
    case 'flashcard': {
      const old_rating = String(fields.rating);
      // hasOwn, so a name like "constructor" is not read from the object's prototype.
      if (!Object.hasOwn(RATINGS, old_rating)) return null;
      return { type, rating: RATINGS[old_rating] };
    }
  }
}
