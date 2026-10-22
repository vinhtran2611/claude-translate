// Rebuilds Markdown from the pairs on screen, for Copy and for editing: the model gave each pair's marker and level
// apart from its text.
import type { TranslatedBlock } from '../../../shared/api-types.ts';
import { quoteContentOf } from '../../../shared/web/markdown.ts';

export type PairSide = 'source' | 'translation';

// Code units come back with an empty translation by contract; their source is shown on both sides.
export function translationTextOf(pair: TranslatedBlock): string {
  return pair.blockType === 'code' ? pair.sourceText : pair.translatedText;
}

// One pair as a Markdown block.
function blockMarkdownOf(pair: TranslatedBlock, side: PairSide): string {
  const text = side === 'source' ? pair.sourceText : translationTextOf(pair);
  if (pair.blockType === 'heading') {
    const hashes = '#'.repeat(Math.min(6, Math.max(1, pair.level)));
    return `${hashes} ${text}`;
  }
  if (pair.blockType === 'list_item') {
    // Three spaces per level below the first, so a nested item stays under its parent.
    const indent = '   '.repeat(Math.max(0, pair.level - 1));
    return `${indent}${pair.marker || '-'} ${text}`;
  }
  if (pair.blockType === 'quote') {
    const lines = quoteContentOf(text).split('\n');
    return lines.map((line) => (line === '' ? '>' : `> ${line}`)).join('\n');
  }
  if (pair.blockType === 'code' && pair.marker) {
    // The closing fence is the opening one without its language: "```ts" closes with "```".
    const closingFence = pair.marker.match(/^(`+|~+)/)?.[0] ?? '```';
    return `${pair.marker}\n${text}\n${closingFence}`;
  }
  return text;
}

export function composePairsMarkdown(pairs: TranslatedBlock[], side: PairSide): string {
  let markdown = '';
  pairs.forEach((pair, pairIndex) => {
    if (pairIndex > 0) {
      // Items of one list sit on consecutive lines; every other block is a paragraph of its own.
      const previousPair = pairs[pairIndex - 1];
      const isSameList = previousPair.blockType === 'list_item' && pair.blockType === 'list_item';
      markdown += isSameList ? '\n' : '\n\n';
    }
    markdown += blockMarkdownOf(pair, side);
  });
  return markdown;
}
