// Tests for the translate page's pure helpers: web/detect-language.ts and web/pairs-markdown.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pair } from '../src/shared/api.ts';
import { detectSourceLanguage } from '../web/detect-language.ts';
import { composePairsMarkdown } from '../web/pairs-markdown.ts';

function pair(pair_type: Pair['pair_type'], source_text: string, level = 0, marker = ''): Pair {
  return { pair_type, level, marker, source_text, translation_text: `${source_text} (vi)` };
}

test('English text is detected as English', () => {
  assert.equal(detectSourceLanguage('Please check the latency of this service.'), 'en');
});

test('Vietnamese mixed with English terms is detected as Vietnamese', () => {
  assert.equal(detectSourceLanguage('anh check giúp em latency p99'), 'vi');
});

test('English that names a Vietnamese person stays English', () => {
  assert.equal(detectSourceLanguage('Thanks Nguyễn Văn An for the review'), 'en');
});

test('quoted Vietnamese inside English does not count', () => {
  assert.equal(detectSourceLanguage('The sign said "cấm đỗ xe" in red.'), 'en');
});

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
