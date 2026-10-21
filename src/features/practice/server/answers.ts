// What an answer is: the check of one that arrives over HTTP, and the self-rated flashcard.
import type { AnswerByType, ChoiceContent, ExerciseBody, ExerciseType, FillContent, RewriteContent } from '../api-types.ts';
import { RATING_LABELS } from '../text.ts';

// Arbitrary: the longest a person would write for each kind of answer.
const MAX_TEXT_CHARS = { sentence: 1_000, paragraph: 5_000, essay: 20_000 };
const MAX_GAP_CHARS = 200;

export type AnswerCheck = { answer: AnswerByType[ExerciseType]; problem: null } | { answer: null; problem: string };

const reject = (problem: string): AnswerCheck => ({ answer: null, problem });

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Who grades a type: the AI, or you (a flashcard).
export function graderOf(type: ExerciseType): 'ai' | 'self' {
  return type === 'flashcard' ? 'self' : 'ai';
}

// The answer in the shape its type stores, or why it cannot be one.
export function checkAnswer(exercise: ExerciseBody, value: unknown): AnswerCheck {
  if (!isObject(value)) return reject('answer must be an object');
  switch (exercise.type) {
    case 'rewrite':
    case 'write': {
      const max = MAX_TEXT_CHARS[exercise.type === 'write' ? 'essay' : (exercise.content as RewriteContent).length];
      const text = typeof value.text === 'string' ? value.text.trim().normalize('NFC') : '';
      return text === '' || text.length > max ? reject(`answer.text must be non-empty and at most ${max} characters`) : { answer: { text }, problem: null };
    }
    case 'choice': {
      const options = (exercise.content as ChoiceContent).options;
      const chosen = value.chosen;
      const is_valid = Array.isArray(chosen) && chosen.length > 0 && new Set(chosen).size === chosen.length
        && chosen.every((index) => Number.isInteger(index) && index >= 0 && index < options.length);
      const is_single = options.filter((option) => option.correct === true).length === 1;
      return is_valid && !(is_single && chosen.length > 1) ? { answer: { chosen: [...chosen].sort((a, b) => a - b) }, problem: null } : reject('answer.chosen must list the picked options');
    }
    case 'fill': {
      const { gaps } = exercise.content as FillContent;
      const typed = value.gaps;
      return Array.isArray(typed) && typed.length === gaps.length && typed.every((gap) => typeof gap === 'string' && gap.length <= MAX_GAP_CHARS)
        ? { answer: { gaps: typed.map((gap) => gap.trim().normalize('NFC')) }, problem: null } : reject(`answer.gaps must be ${gaps.length} texts of at most ${MAX_GAP_CHARS} characters`);
    }
    case 'flashcard':
      return typeof value.rating === 'string' && Object.hasOwn(RATING_LABELS, value.rating)
        ? { answer: { rating: value.rating as keyof typeof RATING_LABELS }, problem: null } : reject('answer.rating must be unknown, almost or known');
  }
}

// A flashcard has nothing to grade: its result is your rating, and the history line says it in words.
export function rateFlashcard({ rating }: AnswerByType['flashcard']): { result: { rating: typeof rating }; summary: string } {
  return { result: { rating }, summary: RATING_LABELS[rating] };
}
