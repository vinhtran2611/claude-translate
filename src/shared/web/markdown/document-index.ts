// The document index: the only cross-pair facts (reference links, footnote numbers, heading anchors).
import type { Pair } from '../../api.ts';
import { definitionOf } from './blocks.ts';
import { type LinkDefinition, normalizeLabel, parseInline, plainTextOf } from './inline.ts';
import { ANCHOR_ID_PREFIX } from './links.ts';

// The fields of a pair the cross-pair index reads.
export type IndexedPair = Pick<Pair, 'pair_type' | 'source_text' | 'translation_text'>;

export interface DocumentIndex {
  link_definitions: Map<string, LinkDefinition>;
  footnote_numbers: Map<string, number>;
  footnote_first_pair: Map<string, number>;
  heading_slugs: Map<number, string>;
  anchor_ids: Set<string>;
}

// GitHub's heading id algorithm (https://github.com/Flet/github-slugger): lowercase, drop punctuation except - and _,
// spaces to hyphens, then -1, -2 for repeats.
export function slugOf(text: string, used_slugs: Set<string>): string {
  const base = text.toLowerCase().trim().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');
  let slug = base;
  for (let repeat = 1; used_slugs.has(slug); repeat++) slug = `${base}-${repeat}`;
  used_slugs.add(slug);
  return slug;
}

// "[^label]" that is not the start of a definition "[^label]:".
const FOOTNOTE_REFERENCE = /\[\^([^\s\]]{1,99})\](?!:)/g;

// pairs: [{ pair_type, source_text, translation_text }]. Returns
//   link_definitions: Map(normalized label -> { destination, title })   for [text][label] in any cell
//   footnote_numbers: Map(label -> n)       n by order of first reference, as GitHub numbers them
//   footnote_first_pair: Map(label -> pair_index)   the source cell that carries the back-reference target id
//   heading_slugs: Map(pair_index -> slug)   GitHub slug of each source heading, deduplicated in order
//   anchor_ids: Set(element id)             every id the source column carries, so "#x" can be checked
export function documentIndexOf(pairs: readonly (IndexedPair | undefined)[]): DocumentIndex {
  const link_definitions = new Map<string, LinkDefinition>();
  const footnote_numbers = new Map<string, number>();
  const footnote_first_pair = new Map<string, number>();
  const heading_slugs = new Map<number, string>();
  const anchor_ids = new Set<string>();
  const used_slugs = new Set<string>();
  pairs.forEach((pair, pair_index) => {
    if (!pair || pair.pair_type === 'code') return;
    for (const text of [pair.source_text, pair.translation_text]) {
      const definition = definitionOf(text);
      if (definition?.kind !== 'link_definition') continue;
      // The first definition of a label wins, as in CommonMark.
      const label = normalizeLabel(definition.label);
      if (link_definitions.has(label)) continue;
      link_definitions.set(label, { destination: definition.destination, title: definition.title });
    }
    const source_definition = definitionOf(pair.source_text);
    if (source_definition?.kind === 'footnote_definition') {
      anchor_ids.add(`${ANCHOR_ID_PREFIX}fn-${source_definition.label}`);
    }
    for (const match of pair.source_text.matchAll(FOOTNOTE_REFERENCE)) {
      const label = match[1];
      if (footnote_numbers.has(label)) continue;
      footnote_numbers.set(label, footnote_numbers.size + 1);
      footnote_first_pair.set(label, pair_index);
      anchor_ids.add(`${ANCHOR_ID_PREFIX}fnref-${label}`);
    }
    if (pair.pair_type === 'heading') {
      const slug = slugOf(plainTextOf(parseInline(pair.source_text)), used_slugs);
      heading_slugs.set(pair_index, slug);
      anchor_ids.add(`${ANCHOR_ID_PREFIX}${slug}`);
    }
  });
  return { link_definitions, footnote_numbers, footnote_first_pair, heading_slugs, anchor_ids };
}
