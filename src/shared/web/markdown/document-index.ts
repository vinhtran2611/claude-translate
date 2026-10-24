// The document index: the only cross-pair facts (reference links, footnote numbers, heading anchors, list numbers).
import type { TranslatedBlock } from '../../api-types.ts';
import { definitionOf } from './blocks.ts';
import { type LinkDefinition, normalizeLabel, parseInline, plainTextOf } from './inline.ts';
import { ANCHOR_ID_PREFIX } from './links.ts';

// The fields of a pair the cross-pair index reads.
type IndexedBlock = Pick<TranslatedBlock, 'blockType' | 'level' | 'marker' | 'sourceText' | 'translatedText'>;

export interface DocumentIndex {
  linkDefinitions: Map<string, LinkDefinition>;
  footnoteNumbers: Map<string, number>;
  footnoteFirstPair: Map<string, number>;
  headingSlugs: Map<number, string>;
  anchorIds: Set<string>;
  listNumbers: Map<number, number>;
}

const NUMBERED_MARKER = /^\s*(\d{1,9})[.)]\s*$/;

// Each list item is its own pair, and the model writes every numbered marker as "1.", so the number shown is counted
// here, as CommonMark counts it: the first item of a numbered list keeps its number and each later one adds 1. A list
// ends at a pair that is no list item; an item at a shallower level ends the lists nested deeper; a bullet at a level
// ends the numbered list at that level.
function listNumbersOf(pairs: readonly (IndexedBlock | undefined)[]): Map<number, number> {
  const listNumbers = new Map<number, number>();
  // level -> the number the next item of the open numbered list at that level gets.
  const nextNumbers = new Map<number, number>();
  pairs.forEach((pair, pairIndex) => {
    if (!pair || pair.blockType !== 'list_item') {
      nextNumbers.clear();
      return;
    }
    const level = Math.max(1, pair.level);
    for (const openLevel of nextNumbers.keys()) {
      if (openLevel > level) nextNumbers.delete(openLevel);
    }
    const numberMatch = NUMBERED_MARKER.exec(pair.marker ?? '');
    if (numberMatch === null) {
      nextNumbers.delete(level);
      return;
    }
    const number = nextNumbers.get(level) ?? parseInt(numberMatch[1], 10);
    listNumbers.set(pairIndex, number);
    nextNumbers.set(level, number + 1);
  });
  return listNumbers;
}

// GitHub's heading id algorithm (https://github.com/Flet/github-slugger): lowercase, drop punctuation except - and _,
// spaces to hyphens, then -1, -2 for repeats.
function slugOf(text: string, usedSlugs: Set<string>): string {
  const base = text.toLowerCase().trim().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');
  let slug = base;
  for (let repeat = 1; usedSlugs.has(slug); repeat++) slug = `${base}-${repeat}`;
  usedSlugs.add(slug);
  return slug;
}

// "[^label]" that is not the start of a definition "[^label]:".
const FOOTNOTE_REFERENCE = /\[\^([^\s\]]{1,99})\](?!:)/g;

// pairs: [{ blockType, sourceText, translatedText }]. Returns
//   linkDefinitions: Map(normalized label -> { destination, title })   for [text][label] in any cell
//   footnoteNumbers: Map(label -> n)       n by order of first reference, as GitHub numbers them
//   footnoteFirstPair: Map(label -> pairIndex)   the source cell that carries the back-reference target id
//   headingSlugs: Map(pairIndex -> slug)   GitHub slug of each source heading, deduplicated in order
//   anchorIds: Set(element id)             every id the source column carries, so "#x" can be checked
//   listNumbers: Map(pairIndex -> n)       the number each numbered list item shows (see listNumbersOf)
export function documentIndexOf(pairs: readonly (IndexedBlock | undefined)[]): DocumentIndex {
  const linkDefinitions = new Map<string, LinkDefinition>();
  const footnoteNumbers = new Map<string, number>();
  const footnoteFirstPair = new Map<string, number>();
  const headingSlugs = new Map<number, string>();
  const anchorIds = new Set<string>();
  const usedSlugs = new Set<string>();
  pairs.forEach((pair, pairIndex) => {
    if (!pair || pair.blockType === 'code') return;
    for (const text of [pair.sourceText, pair.translatedText]) {
      const definition = definitionOf(text);
      if (definition?.kind !== 'link_definition') continue;
      // The first definition of a label wins, as in CommonMark.
      const label = normalizeLabel(definition.label);
      if (linkDefinitions.has(label)) continue;
      linkDefinitions.set(label, { destination: definition.destination, title: definition.title });
    }
    const sourceDefinition = definitionOf(pair.sourceText);
    if (sourceDefinition?.kind === 'footnote_definition') {
      anchorIds.add(`${ANCHOR_ID_PREFIX}fn-${sourceDefinition.label}`);
    }
    for (const match of pair.sourceText.matchAll(FOOTNOTE_REFERENCE)) {
      const label = match[1];
      if (footnoteNumbers.has(label)) continue;
      footnoteNumbers.set(label, footnoteNumbers.size + 1);
      footnoteFirstPair.set(label, pairIndex);
      anchorIds.add(`${ANCHOR_ID_PREFIX}fnref-${label}`);
    }
    if (pair.blockType === 'heading') {
      const slug = slugOf(plainTextOf(parseInline(pair.sourceText)), usedSlugs);
      headingSlugs.set(pairIndex, slug);
      anchorIds.add(`${ANCHOR_ID_PREFIX}${slug}`);
    }
  });
  const listNumbers = listNumbersOf(pairs);
  return { linkDefinitions, footnoteNumbers, footnoteFirstPair, headingSlugs, anchorIds, listNumbers };
}
