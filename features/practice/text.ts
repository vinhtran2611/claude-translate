// Small facts about an exercise or an answer that both the server (lists) and the page (templates) need.
import type { ExerciseBody, Rating, RewriteContent } from './api.ts';

// Words as IELTS counts them, roughly: runs of non-space characters.
export function countWords(text: string): number {
  const words = text.trim().split(/\s+/);
  return words[0] === '' ? 0 : words.length;
}

export const RATING_LABELS: Record<Rating, string> = { unknown: 'Didn’t know', almost: 'Almost', known: 'Knew it' };

export function rewriteVerb(content: RewriteContent): string {
  return content.prefill === true ? 'Correct' : content.source_lang === 'vi' ? 'Translate' : 'Rewrite';
}

// The short name a list shows: "Rewrite sentence", "Multiple choice".
export function kindOf(exercise: ExerciseBody): string {
  switch (exercise.type) {
    case 'rewrite': return `${rewriteVerb(exercise.content as RewriteContent)} ${(exercise.content as RewriteContent).length}`;
    case 'write': return 'Free writing';
    case 'choice': return 'Multiple choice';
    case 'fill': return 'Fill in the blanks';
    case 'flashcard': return 'Flashcard';
  }
}

const PREVIEW_CHARS = 200;

// The words that identify an exercise in a list.
export function previewOf(exercise: ExerciseBody): string {
  const content = exercise.content as unknown as Record<string, string>;
  const text = { rewrite: content.text, write: content.prompt, choice: content.question, fill: content.text, flashcard: content.front }[exercise.type];
  return text.replace(/\{\{\d+\}\}/g, '____').replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS);
}
