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

const paragraphs = (...sourceTexts: string[]): CheckedBlock[] => sourceTexts.map((sourceText) => ({ blockType: 'paragraph', sourceText }));

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
    inputExcerpt: 'most ambitious and successful version of',
    sourceExcerpt: 'ambitious and successful version of this',
  });
});

test('a fixed typo counts as a change', () => {
  const sources = PDF_REFORMATTED.map((pair) => ({ ...pair, sourceText: pair.sourceText.replace('Al assistant', 'AI assistant') }));
  assert.equal(findSourceDivergence(PDF_INPUT, sources)?.sourceExcerpt, 'AI assistant, fine tuned via RL,');
});

test('a source that stops early reports an empty source excerpt', () => {
  assert.deepEqual(findSourceDivergence('one two three', paragraphs('one two')), { inputExcerpt: 'three', sourceExcerpt: '' });
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
  assert.equal(findSourceDivergence(PAGE_BREAK_INPUT, dropped)?.inputExcerpt, "2/3/22, 9:31 PM The Bitter Lesson");
  const changed: CheckedBlock[] = [
    { blockType: 'paragraph', sourceText: "a colossal waste of researcher's time." },
    { blockType: 'other', sourceText: '2/3/22, 9:31 PM The Bitter Lesson' },
    { blockType: 'other', sourceText: 'www.example.net/lesson.html page 2' },
    { blockType: 'paragraph', sourceText: 'Next paragraph.' },
  ];
  assert.notEqual(findSourceDivergence(PAGE_BREAK_INPUT, changed), null);
});

const PROSE_INPUT = 'They are trained on human data, which is both 1) human generated and 2) finite. What do you do when you run out?';

test('an inline enumeration split into list items, with bold added, keeps every word', () => {
  const pairs: CheckedBlock[] = [
    { blockType: 'paragraph', sourceText: 'They are trained on **human data**, which is both' },
    { blockType: 'list_item', sourceText: 'human generated and' },
    { blockType: 'list_item', sourceText: 'finite.' },
    { blockType: 'paragraph', sourceText: 'What do you do when you run out?' },
  ];
  assert.equal(findSourceDivergence(PROSE_INPUT, pairs), null);
});

test('a heading Markdown mode added between paragraphs is skipped', () => {
  const pairs: CheckedBlock[] = [
    { blockType: 'heading', sourceText: 'Training data' },
    { blockType: 'paragraph', sourceText: 'They are trained on human data, which is both 1) human generated and 2) finite.' },
    { blockType: 'heading', sourceText: 'Running out' },
    { blockType: 'paragraph', sourceText: 'What do you do when you run out?' },
  ];
  assert.equal(findSourceDivergence(PROSE_INPUT, pairs), null);
});

test('a heading the input already had still matches, past its # marks', () => {
  assert.equal(findSourceDivergence('## Setup\n\nRun it.', [{ blockType: 'heading', sourceText: 'Setup' }, ...paragraphs('Run it.')]), null);
});

test('a heading that replaced or moved input words is still reported', () => {
  const replaced: CheckedBlock[] = [{ blockType: 'heading', sourceText: 'Install' }, ...paragraphs('Run it.')];
  assert.deepEqual(findSourceDivergence('Setup\nRun it.', replaced), { inputExcerpt: 'Setup Run it.', sourceExcerpt: 'Run it.' });
  const moved: CheckedBlock[] = [{ blockType: 'heading', sourceText: 'What do you do when you run out?' }, ...paragraphs('They are trained on human data, which is both 1) human generated and 2) finite.')];
  assert.equal(findSourceDivergence(PROSE_INPUT, moved)?.inputExcerpt, 'What do you do when you');
});
