// The page's small formats (format.ts): nothing here touches the DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatClock, pluralize, relativeDay, typeMix } from './format.ts';

test('small formats: counts, the type mix, the clock, the day', () => {
  assert.equal(pluralize(1, 'exercise'), '1 exercise');
  assert.equal(pluralize(0, 'exercise'), '0 exercises');
  assert.equal(typeMix({ flashcard: 3, rewrite: 5, choice: 4 }), 'Rewrite 5 · Choice 4 · Flashcard 3');
  assert.equal(typeMix({ choice: 2, rewrite: 2 }), 'Rewrite 2 · Choice 2');
  assert.equal(typeMix({ gap_fill: 1, essay: 1 }), 'Essay 1 · Gap fill 1');
  assert.equal(formatClock(75_000), '1:15');
  const now = new Date(2026, 9, 18, 9, 0);
  assert.equal(relativeDay(new Date(2026, 9, 18, 0, 5).toISOString(), now), 'today');
  assert.equal(relativeDay(new Date(2026, 9, 17, 23, 59).toISOString(), now), 'yesterday');
  assert.equal(relativeDay(new Date(2026, 9, 15, 12, 0).toISOString(), now), '3 days ago');
  assert.match(relativeDay(new Date(2026, 8, 4, 12, 0).toISOString(), now), /^on 4 Sep/);
});
