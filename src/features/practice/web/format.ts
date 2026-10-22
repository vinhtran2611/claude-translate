// Small text helpers for what the page shows. Pure, so they are tested without a browser.
import type { ExerciseType } from '../api-types.ts';

const TYPE_NAMES: Record<ExerciseType, string> = {
  rewrite: 'Rewrite',
  translation: 'Translation',
  correction: 'Correction',
  essay: 'Essay',
  choice: 'Choice',
  gap_fill: 'Gap fill',
  flashcard: 'Flashcard',
};
const TYPE_ORDER = Object.keys(TYPE_NAMES);

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

// "Rewrite 5 · Choice 4 · Flashcard 3": the most frequent first.
export function typeMix(counts: Partial<Record<ExerciseType, number>>): string {
  return (Object.entries(counts) as [ExerciseType, number][])
    .sort((a, b) => b[1] - a[1] || TYPE_ORDER.indexOf(a[0]) - TYPE_ORDER.indexOf(b[0]))
    .map(([type, count]) => `${TYPE_NAMES[type]} ${count}`).join(' · ');
}

// 18 Oct, 15:03, in the browser's time zone.
export function formatDateTime(timestamp: string): string {
  return new Date(timestamp).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// 18:42, from a duration.
export function formatClock(duration_ms: number): string {
  const total_seconds = Math.floor(duration_ms / 1000);
  return `${Math.floor(total_seconds / 60)}:${String(total_seconds % 60).padStart(2, '0')}`;
}

// "today", "yesterday", "3 days ago", then the date; counted in calendar days of the browser's time zone.
export function relativeDay(timestamp: string, now = new Date()): string {
  const date = new Date(timestamp);
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  return `on ${date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric' })}`;
}

// The browser tab's title for one view; the static <title> in practice.html stays "Practice · Claude Translate".
export function pageTitleOf(view: string): string {
  return `${view} · Practice · Claude Translate`;
}
