// What an answer is: the check of one that arrives over HTTP (docs/data-model-proposal.md §3.9, rules 1, 4 and 5).
import type { TextLength } from '../../../shared/api-types.ts';
import type { Answer, ExerciseContent, ExerciseType, TextAnswer } from '../api-types.ts';
import { RATING_LABELS } from '../text.ts';

// Arbitrary: the longest a person would write for each length of answer; an essay has the longest limit.
const MAX_TEXT_CHARS: Record<TextLength, number> = { sentence: 1_000, paragraph: 5_000, multi_paragraph: 20_000 };
const MAX_ESSAY_CHARS = 20_000;
const MAX_GAP_CHARS = 200;

export type AnswerCheck = { answer: Answer; problem: null } | { answer: null; problem: string };

const reject = (problem: string): AnswerCheck => ({ answer: null, problem });

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Every type but a flashcard is graded by the AI; a flashcard's rating is its result (rule 6).
export function isGradedByAi(type: ExerciseType): boolean {
  return type !== 'flashcard';
}

function checkText(max: number, value: Record<string, unknown>, type: TextAnswer['type']): AnswerCheck {
  let text = '';
  if (typeof value.text === 'string') text = value.text.trim().normalize('NFC');
  if (text === '' || text.length > max) return reject(`answer.text must be non-empty and at most ${max} characters`);
  return { answer: { type, text }, problem: null };
}

// Indexes of options: whole numbers in range, no repeats. With one correct option, exactly one (rule 4).
function checkChosen(optionCount: number, correctCount: number, chosen: unknown): number[] | null {
  if (!Array.isArray(chosen) || chosen.length === 0) return null;
  if (new Set(chosen).size !== chosen.length) return null;
  const isEachAnOption = chosen.every((index) => Number.isInteger(index) && index >= 0 && index < optionCount);
  if (!isEachAnOption) return null;
  if (correctCount === 1 && chosen.length !== 1) return null;
  return [...chosen].sort((a, b) => a - b);
}

// The answer in the shape its exercise stores, or why it cannot be one. answer.type must be the exercise's type (rule 1).
export function checkAnswer(content: ExerciseContent, value: unknown): AnswerCheck {
  if (!isObject(value)) return reject('answer must be an object');
  if (value.type !== content.type) return reject(`answer.type must be "${content.type}", the type of the exercise`);
  switch (content.type) {
    case 'rewrite':
    case 'translation':
    case 'correction':
      return checkText(MAX_TEXT_CHARS[content.length], value, content.type);
    case 'essay':
      return checkText(MAX_ESSAY_CHARS, value, content.type);
    case 'choice': {
      const correctCount = content.options.filter((option) => option.isCorrect).length;
      const chosen = checkChosen(content.options.length, correctCount, value.chosenOptionIndexes);
      if (chosen === null) return reject('answer.chosenOptionIndexes must list the picked options, each once (one when one option is correct)');
      return { answer: { type: 'choice', chosenOptionIndexes: chosen }, problem: null };
    }
    case 'gap_fill': {
      const { gaps } = content;
      const typed = value.gapAnswers;
      const isValid = Array.isArray(typed) && typed.length === gaps.length
        && typed.every((gap) => typeof gap === 'string' && gap.length <= MAX_GAP_CHARS);
      if (!isValid) return reject(`answer.gapAnswers must be ${gaps.length} texts of at most ${MAX_GAP_CHARS} characters`);
      const gapAnswers = typed.map((gap: string) => gap.trim().normalize('NFC'));
      return { answer: { type: 'gap_fill', gapAnswers }, problem: null };
    }
    case 'flashcard': {
      const rating = value.rating;
      const isRating = typeof rating === 'string' && Object.hasOwn(RATING_LABELS, rating);
      if (!isRating) return reject('answer.rating must be didnt_know, almost or knew');
      return { answer: { type: 'flashcard', rating: rating as keyof typeof RATING_LABELS }, problem: null };
    }
  }
}
