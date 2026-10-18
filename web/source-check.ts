// The one place that decides whether the source column kept every word of the input.
import type { Pair } from '../shared/api.ts';
import { parseInline, plainTextOf } from '../shared/web/markdown.ts';

// Syntax the source column may drop or add around the words: heading #, quote >, list markers and checkboxes,
// fences, table pipes, thematic breaks and setext underlines.
const BLOCK_SYNTAX_WORD = /^(#{1,6}|>+|[-*+-◦▪]|\d{1,9}[.)]|(`{3,}|~{3,})[\w-]*|\||[-*_=]{3,}|\[[ xX]?\]?|\])$/;
// Arbitrary: enough words to find the spot by eye.
const EXCERPT_WORD_COUNT = 6;

// The two sides of a source check: only the type and the left column's text matter.
export type CheckedPair = Pick<Pair, 'pair_type' | 'source_text'>;

// Where the left column first parts from the input; '' when that side has run out.
export interface SourceDivergence {
  input_excerpt: string;
  source_excerpt: string;
}

// Line by line: an inline parse of the whole text would read a code fence as the start of a code span.
function wordsOf(text: string): string[] {
  return text.split('\n').flatMap((line) => plainTextOf(parseInline(line)).normalize('NFC').split(/\s+/).filter(Boolean));
}

// The input with each word run of a type "other" pair cut out, once, wherever it is; the pairs are then left out of
// the ordered comparison. A run not found in the input stays in that comparison, so a changed one is still caught.
function withoutMovedUnits(input_words: string[], pairs: CheckedPair[]): { remaining_words: string[]; ordered_pairs: CheckedPair[] } {
  const remaining_words = [...input_words];
  const ordered_pairs: CheckedPair[] = [];
  for (const pair of pairs) {
    const unit_words = pair.pair_type === 'other' ? wordsOf(pair.source_text) : [];
    const found_at = unit_words.length === 0 ? -1 : remaining_words.findIndex((_, start) =>
      unit_words.every((word, offset) => remaining_words[start + offset] === word));
    if (found_at === -1) ordered_pairs.push(pair);
    else remaining_words.splice(found_at, unit_words.length);
  }
  return { remaining_words, ordered_pairs };
}

// pairs: [{ pair_type, source_text }]. null when every input word appears in the sources once, in order, except that
// a type "other" unit (page furniture) may sit anywhere. Otherwise the first place they part, as
// { input_excerpt, source_excerpt } ('' when that side has run out). A word ending in "-" may join the next one,
// with or without the hyphen, since rejoining a word split across a PDF line is allowed.
export function findSourceDivergence(input_text: string, pairs: CheckedPair[]): SourceDivergence | null {
  const { remaining_words: input_words, ordered_pairs } = withoutMovedUnits(wordsOf(input_text), pairs);
  const source_words = ordered_pairs.flatMap((pair) => wordsOf(pair.source_text));
  let input_index = 0;
  let source_index = 0;
  while (input_index < input_words.length || source_index < source_words.length) {
    const input_word = input_words[input_index];
    const source_word = source_words[source_index];
    const next_input_word = input_words[input_index + 1];
    if (input_word === source_word) {
      input_index += 1;
      source_index += 1;
    } else if (input_word?.endsWith('-') && next_input_word !== undefined &&
      (source_word === input_word + next_input_word || source_word === input_word.slice(0, -1) + next_input_word)) {
      input_index += 2;
      source_index += 1;
    } else if (input_word !== undefined && BLOCK_SYNTAX_WORD.test(input_word)) {
      input_index += 1;
    } else if (source_word !== undefined && BLOCK_SYNTAX_WORD.test(source_word)) {
      source_index += 1;
    } else {
      return {
        input_excerpt: input_words.slice(input_index, input_index + EXCERPT_WORD_COUNT).join(' '),
        source_excerpt: source_words.slice(source_index, source_index + EXCERPT_WORD_COUNT).join(' '),
      };
    }
  }
  return null;
}
