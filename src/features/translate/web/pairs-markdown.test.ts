// Tests for pairs-markdown.ts: the pairs on screen rebuilt as Markdown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pair } from '../../../shared/api-types.ts';
import { composePairsMarkdown } from './pairs-markdown.ts';

function pair(pair_type: Pair['pair_type'], source_text: string, level = 0, marker = ''): Pair {
  return { pair_type, level, marker, source_text, translation_text: `${source_text} (vi)` };
}

test('headings, list items and paragraphs are rebuilt as Markdown', () => {
  const pairs = [pair('heading', 'Title', 2), pair('list_item', 'one', 1, '-'), pair('list_item', 'two', 2, '1.'), pair('paragraph', 'End.')];
  assert.equal(composePairsMarkdown(pairs, 'source'), '## Title\n\n- one\n   1. two\n\nEnd.');
});

test('the translation side uses the translated text', () => {
  assert.equal(composePairsMarkdown([pair('paragraph', 'Hello')], 'translation'), 'Hello (vi)');
});

test('a code block keeps its fence and shows its source on both sides', () => {
  const code: Pair = { pair_type: 'code', level: 0, marker: '```ts', source_text: 'let a = 1;', translation_text: '' };
  assert.equal(composePairsMarkdown([code], 'translation'), '```ts\nlet a = 1;\n```');
});

test('a quote gets its markers back, with ">" alone on a blank line', () => {
  assert.equal(composePairsMarkdown([pair('quote', 'first\n\nsecond')], 'source'), '> first\n>\n> second');
});
