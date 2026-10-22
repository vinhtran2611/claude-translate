// Tests for source-check.ts (npm test, or node --test src/features/translate/web/source-check.test.ts), no packages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findSourceDivergence, type CheckedBlock } from './source-check.ts';

const PDF_INPUT = `Long Term Goal
Our top level goal is to work towards the creation of safe, beneficial AGI. The most ambitious and
successful version of this agent could answer general questions, write functions, identify bugs,
design an API -- it would display all the capabilities of a general Al assistant, fine
tuned via RL, of this proto-
AGI and incre-
mentally better.
Data ingest:
- raw/ directory
- wiki`;

const paragraphs = (...source_texts: string[]): CheckedBlock[] => source_texts.map((sourceText) => ({ blockType: 'paragraph', sourceText }));

const PDF_REFORMATTED = paragraphs(
  'Long Term Goal',
  'Our top level goal is to work towards the creation of safe, beneficial AGI. The most ambitious and successful version of this agent could answer general questions, write functions, identify bugs, design an API -- it would display all the capabilities of a general Al assistant, fine tuned via RL, of this proto-AGI and incrementally better.',
  'Data ingest:',
  'raw/ directory',
  'wiki',
);

test('reformatting that only joins lines, rejoins hyphenated words and drops bullets keeps every word', () => {
  assert.equal(findSourceDivergence(PDF_INPUT, PDF_REFORMATTED), null);
});

test('a dropped word is reported where it went missing', () => {
  const sources = PDF_REFORMATTED.map((pair) => ({ ...pair, sourceText: pair.sourceText.replace('most ambitious', 'ambitious') }));
  assert.deepEqual(findSourceDivergence(PDF_INPUT, sources), {
    input_excerpt: 'most ambitious and successful version of',
    source_excerpt: 'ambitious and successful version of this',
  });
});

test('a fixed typo counts as a change', () => {
  const sources = PDF_REFORMATTED.map((pair) => ({ ...pair, sourceText: pair.sourceText.replace('Al assistant', 'AI assistant') }));
  assert.equal(findSourceDivergence(PDF_INPUT, sources)?.source_excerpt, 'AI assistant, fine tuned via RL,');
});

test('a source that stops early reports an empty source excerpt', () => {
  assert.deepEqual(findSourceDivergence('one two three', paragraphs('one two')), { input_excerpt: 'three', source_excerpt: '' });
});

test('markers, heading marks, fences and checkboxes the source leaves out are not words', () => {
  const input = '## Setup\n\n1. Install\n- [ ] Run `npm test`\n> quoted\n\n```js\nconst a = 1;\n```\n\n---';
  assert.equal(findSourceDivergence(input, paragraphs('Setup', 'Install', 'Run `npm test`', 'quoted', 'const a = 1;', '---')), null);
});

test('a verbatim echo that keeps a line-end hyphen still matches', () => {
  assert.equal(findSourceDivergence('of this proto-\nAGI', paragraphs('of this proto-\nAGI')), null);
});

const PAGE_BREAK_INPUT = 'a colossal waste of\n2/3/22, 9:31 PM The Bitter Lesson\nwww.example.net/lesson.html 2/2\nresearcher\'s time.\nNext paragraph.';

test('page furniture moved out of the sentence it interrupted still matches', () => {
  const pairs: CheckedBlock[] = [
    { blockType: 'paragraph', sourceText: "a colossal waste of researcher's time." },
    { blockType: 'other', sourceText: '2/3/22, 9:31 PM The Bitter Lesson' },
    { blockType: 'other', sourceText: 'www.example.net/lesson.html 2/2' },
    { blockType: 'paragraph', sourceText: 'Next paragraph.' },
  ];
  assert.equal(findSourceDivergence(PAGE_BREAK_INPUT, pairs), null);
});

test('page furniture that was dropped or changed is still reported', () => {
  const dropped: CheckedBlock[] = [{ blockType: 'paragraph', sourceText: "a colossal waste of researcher's time." }, { blockType: 'paragraph', sourceText: 'Next paragraph.' }];
  assert.equal(findSourceDivergence(PAGE_BREAK_INPUT, dropped)?.input_excerpt, "2/3/22, 9:31 PM The Bitter Lesson");
  const changed: CheckedBlock[] = [
    { blockType: 'paragraph', sourceText: "a colossal waste of researcher's time." },
    { blockType: 'other', sourceText: '2/3/22, 9:31 PM The Bitter Lesson' },
    { blockType: 'other', sourceText: 'www.example.net/lesson.html page 2' },
    { blockType: 'paragraph', sourceText: 'Next paragraph.' },
  ];
  assert.notEqual(findSourceDivergence(PAGE_BREAK_INPUT, changed), null);
});
