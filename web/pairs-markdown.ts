// Rebuilds Markdown from the pairs on screen, for Copy and for editing: the model gave each pair's marker and level
// apart from its text.
import type { Pair } from '../src/shared/api.ts';
import { quoteContentOf } from '../src/shared/web/markdown.ts';

export type PairSide = 'source' | 'translation';

// Code units come back with an empty translation by contract; their source is shown on both sides.
export function translationTextOf(pair: Pair): string {
  return pair.pair_type === 'code' ? pair.source_text : pair.translation_text;
}

// One pair as a Markdown block.
function blockMarkdownOf(pair: Pair, side: PairSide): string {
  const text = side === 'source' ? pair.source_text : translationTextOf(pair);
  if (pair.pair_type === 'heading') {
    const hashes = '#'.repeat(Math.min(6, Math.max(1, pair.level)));
    return `${hashes} ${text}`;
  }
  if (pair.pair_type === 'list_item') {
    // Three spaces per level below the first, so a nested item stays under its parent.
    const indent = '   '.repeat(Math.max(0, pair.level - 1));
    return `${indent}${pair.marker || '-'} ${text}`;
  }
  if (pair.pair_type === 'quote') {
    const lines = quoteContentOf(text).split('\n');
    return lines.map((line) => (line === '' ? '>' : `> ${line}`)).join('\n');
  }
  if (pair.pair_type === 'code' && pair.marker) {
    // The closing fence is the opening one without its language: "```ts" closes with "```".
    const closing_fence = pair.marker.match(/^(`+|~+)/)?.[0] ?? '```';
    return `${pair.marker}\n${text}\n${closing_fence}`;
  }
  return text;
}

export function composePairsMarkdown(pairs: Pair[], side: PairSide): string {
  let markdown = '';
  pairs.forEach((pair, pair_index) => {
    if (pair_index > 0) {
      // Items of one list sit on consecutive lines; every other block is a paragraph of its own.
      const previous_pair = pairs[pair_index - 1];
      const is_same_list = previous_pair.pair_type === 'list_item' && pair.pair_type === 'list_item';
      markdown += is_same_list ? '\n' : '\n\n';
    }
    markdown += blockMarkdownOf(pair, side);
  });
  return markdown;
}
