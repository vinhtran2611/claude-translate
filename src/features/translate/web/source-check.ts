// The one place that decides whether the source column kept every word of the input.
import type { TranslatedBlock } from '../../../shared/api-types.ts';
import { parseInline, plainTextOf } from '../../../shared/web/markdown.ts';

// Syntax the source column may drop or add around the words: heading #, quote >, list markers and checkboxes,
// fences, table pipes, thematic breaks and setext underlines.
const BLOCK_SYNTAX_WORD = /^(#{1,6}|>+|[-*+-◦▪]|\d{1,9}[.)]|(`{3,}|~{3,})[\w-]*|\||[-*_=]{3,}|\[[ xX]?\]?|\])$/;
// Arbitrary: enough words to find the spot by eye.
const EXCERPT_WORD_COUNT = 6;

// The two sides of a source check: only the type and the left column's text matter.
export type CheckedBlock = Pick<TranslatedBlock, 'blockType' | 'sourceText'>;

// Where the left column first parts from the input; '' when that side has run out.
export interface SourceDivergence {
  inputExcerpt: string;
  sourceExcerpt: string;
}

// Line by line: an inline parse of the whole text would read a code fence as the start of a code span.
function wordsOf(text: string): string[] {
  return text.split('\n').flatMap((line) => plainTextOf(parseInline(line)).normalize('NFC').split(/\s+/).filter(Boolean));
}

// The input with each word run of a type "other" pair cut out, once, wherever it is; the pairs are then left out of
// the ordered comparison. A run not found in the input stays in that comparison, so a changed one is still caught.
function withoutMovedUnits(inputWords: string[], pairs: CheckedBlock[]): { remainingWords: string[]; orderedPairs: CheckedBlock[] } {
  const remainingWords = [...inputWords];
  const orderedPairs: CheckedBlock[] = [];
  for (const pair of pairs) {
    const unitWords = pair.blockType === 'other' ? wordsOf(pair.sourceText) : [];
    const foundAt = unitWords.length === 0 ? -1 : remainingWords.findIndex((_, start) =>
      unitWords.every((word, offset) => remainingWords[start + offset] === word));
    if (foundAt === -1) orderedPairs.push(pair);
    else remainingWords.splice(foundAt, unitWords.length);
  }
  return { remainingWords, orderedPairs };
}

// The words of the pairs in order, and for each heading pair the index of its first word mapped to the index just
// past its last one.
function sourceWordsOf(pairs: CheckedBlock[]): { sourceWords: string[]; headingEnds: Map<number, number> } {
  const sourceWords: string[] = [];
  const headingEnds = new Map<number, number>();
  for (const pair of pairs) {
    const pairWords = wordsOf(pair.sourceText);
    if (pair.blockType === 'heading' && pairWords.length > 0) headingEnds.set(sourceWords.length, sourceWords.length + pairWords.length);
    sourceWords.push(...pairWords);
  }
  return { sourceWords, headingEnds };
}

// True when words are the next words of the input from inputIndex, past any block syntax the input has there.
function isNextInInput(inputWords: string[], inputIndex: number, words: string[]): boolean {
  let start = inputIndex;
  while (start < inputWords.length && BLOCK_SYNTAX_WORD.test(inputWords[start])) start += 1;
  return words.every((word, offset) => inputWords[start + offset] === word);
}

// pairs: [{ blockType, sourceText }]. null when every input word appears in the sources once, in order, except that
// a type "other" unit (page furniture) may sit anywhere, and a heading whose words are not the next input words is
// one Markdown mode added (a section title) and is skipped. Skipping it lets nothing else through: an input word the
// heading replaced or moved is still missing from its place. Otherwise the first place they part, as
// { inputExcerpt, sourceExcerpt } ('' when that side has run out). A word ending in "-" may join the next one,
// with or without the hyphen, since rejoining a word split across a PDF line is allowed.
export function findSourceDivergence(inputText: string, pairs: CheckedBlock[]): SourceDivergence | null {
  const { remainingWords: inputWords, orderedPairs } = withoutMovedUnits(wordsOf(inputText), pairs);
  const { sourceWords, headingEnds } = sourceWordsOf(orderedPairs);
  let inputIndex = 0;
  let sourceIndex = 0;
  while (inputIndex < inputWords.length || sourceIndex < sourceWords.length) {
    const headingEnd = headingEnds.get(sourceIndex);
    if (headingEnd !== undefined) {
      const headingWords = sourceWords.slice(sourceIndex, headingEnd);
      if (!isNextInInput(inputWords, inputIndex, headingWords)) {
        sourceIndex = headingEnd;
        continue;
      }
    }
    const inputWord = inputWords[inputIndex];
    const sourceWord = sourceWords[sourceIndex];
    const nextInputWord = inputWords[inputIndex + 1];
    if (inputWord === sourceWord) {
      inputIndex += 1;
      sourceIndex += 1;
    } else if (inputWord?.endsWith('-') && nextInputWord !== undefined &&
      (sourceWord === inputWord + nextInputWord || sourceWord === inputWord.slice(0, -1) + nextInputWord)) {
      inputIndex += 2;
      sourceIndex += 1;
    } else if (inputWord !== undefined && BLOCK_SYNTAX_WORD.test(inputWord)) {
      inputIndex += 1;
    } else if (sourceWord !== undefined && BLOCK_SYNTAX_WORD.test(sourceWord)) {
      sourceIndex += 1;
    } else {
      return {
        inputExcerpt: inputWords.slice(inputIndex, inputIndex + EXCERPT_WORD_COUNT).join(' '),
        sourceExcerpt: sourceWords.slice(sourceIndex, sourceIndex + EXCERPT_WORD_COUNT).join(' '),
      };
    }
  }
  return null;
}
