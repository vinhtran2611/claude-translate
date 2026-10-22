// Small facts about an exercise or an answer that both the server (lists) and the page (templates) need. All of it is
// worked out when it is read, never stored (docs/data-model-proposal.md §3.9, rule 9).
import type { RunStatus, TextLength } from '../../shared/api-types.ts';
import type { Answer, ExerciseContent, FlashcardRating } from './api-types.ts';

// Words as IELTS counts them, roughly: runs of non-space characters.
export function countWords(text: string): number {
  const words = text.trim().split(/\s+/);
  return words[0] === '' ? 0 : words.length;
}

export const RATING_LABELS: Record<FlashcardRating, string> = { didnt_know: 'Didn’t know', almost: 'Almost', knew: 'Knew it' };

export const LENGTH_NAMES: Record<TextLength, string> = { sentence: 'sentence', paragraph: 'paragraph', multi_paragraph: 'multi-paragraph' };

// The short name a list shows: "Rewrite, sentence", "Multiple choice".
export function labelOf(content: ExerciseContent): string {
  switch (content.type) {
    case 'rewrite':
      return `Rewrite, ${LENGTH_NAMES[content.length]}`;
    case 'translation':
      return `Translation, ${LENGTH_NAMES[content.length]}`;
    case 'correction':
      return `Correction, ${LENGTH_NAMES[content.length]}`;
    case 'essay':
      return 'Essay';
    case 'choice':
      return 'Multiple choice';
    case 'gap_fill':
      return 'Gap fill';
    case 'flashcard':
      return 'Flashcard';
  }
}

// The text that names an exercise best: what it asks about.
function mainTextOf(content: ExerciseContent): string {
  switch (content.type) {
    case 'rewrite':
    case 'translation':
    case 'correction':
      return content.sourceText;
    case 'essay':
      return content.instruction;
    case 'choice':
      return content.question;
    case 'gap_fill':
      return content.textWithGaps;
    case 'flashcard':
      return content.front;
  }
}

const PREVIEW_CHARS = 200;

// The words that identify an exercise in a list: its main text on one line, gaps shown as ____.
export function previewOf(content: ExerciseContent): string {
  const oneLine = mainTextOf(content)
    .replace(/\{\{\d+\}\}/g, '____')
    .replace(/\s+/g, ' ')
    .trim();
  return oneLine.slice(0, PREVIEW_CHARS);
}

// The history line of an attempt: a flashcard's rating, or how its latest grading went (latestStatus: null when it has
// none). The grader's text is not parsed, so a finished grading says only "Graded".
export function historyLineOf(answer: Answer, latestStatus: RunStatus | null): string {
  if (answer.type === 'flashcard') return RATING_LABELS[answer.rating];
  if (latestStatus === 'running') return 'Grading…';
  if (latestStatus === 'succeeded') return 'Graded';
  return 'Not graded';
}
