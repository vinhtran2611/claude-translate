// Turns the model's <pair><source>…</source><translation>…</translation></pair> reply into page events as the text
// arrives: each <pair> is one translated block (block_start, then source_delta and translation_delta). The <pair> tags
// are the reply format the prompts ask for. Text outside any pair becomes outside_text_delta, which is how a reply that
// ignores the format still reaches the page.
import type { BlockType } from '../../../shared/api-types.ts';
import type { StreamEvent } from '../api-types.ts';

const PAIR_TYPES = new Set<string>(['heading', 'paragraph', 'list_item', 'table', 'code', 'quote', 'other']);
const PAIR_OPEN_TAG = /<pair\b([^>]*)>/;
const PAIR_CLOSE_TAG = '</pair>';
type ParserState = 'between_pairs' | 'in_pair' | 'in_source' | 'in_translation';
const FIELD_OPEN_TAGS: Record<string, ParserState> = { '<source>': 'in_source', '<translation>': 'in_translation' };

export interface PairStreamParser {
  // The events for this piece of the reply. Text that may be the start of a tag is held until more arrives.
  push(text: string): StreamEvent[];
  // The events for whatever is still held, once the reply has ended.
  finish(): StreamEvent[];
}

// <pair type="list_item" level="2" marker="-">: an unknown type becomes 'other', a missing level 0, a missing or empty
// marker null.
function parsePairAttributes(attributeText: string): { blockType: BlockType; level: number; marker: string | null } {
  const attributes: Record<string, string | undefined> = {};
  for (const match of attributeText.matchAll(/(\w+)="([^"]*)"/g)) attributes[match[1]] = match[2];
  const isKnownType = attributes.type !== undefined && PAIR_TYPES.has(attributes.type);
  let marker: string | null = attributes.marker ?? null;
  if (marker === '') marker = null;
  return {
    blockType: isKnownType ? (attributes.type as BlockType) : 'other',
    level: Number.parseInt(attributes.level ?? '', 10) || 0,
    marker,
  };
}

// Index from which text could still be the start of closingTag; text.length when no suffix can be.
function heldTailStart(text: string, closingTag: string): number {
  for (let index = Math.max(0, text.length - closingTag.length + 1); index < text.length; index++) {
    if (closingTag.startsWith(text.slice(index))) return index;
  }
  return text.length;
}

export function createPairStreamParser(): PairStreamParser {
  // Text received but not yet turned into events.
  let buffer = '';
  let state: ParserState = 'between_pairs';
  let pairIndex = -1;
  // True right after <source> or <translation>: the newline that usually follows the tag is not part of the text.
  let isFieldStart = false;

  // The delta event for text inside the field being read.
  const fieldDelta = (text: string): StreamEvent => {
    if (state === 'in_source') return ['source_delta', { blockIndex: pairIndex, text }];
    return ['translation_delta', { blockIndex: pairIndex, text }];
  };

  // Each read step below handles the buffer in one state. It returns true when it changed state and the loop should
  // go on, false when it must wait for more text.

  const readBetweenPairs = (events: StreamEvent[]): boolean => {
    const openMatch = PAIR_OPEN_TAG.exec(buffer);
    if (openMatch) {
      const outsideText = buffer.slice(0, openMatch.index);
      if (outsideText.trim() !== '') events.push(['outside_text_delta', { text: outsideText }]);
      pairIndex += 1;
      events.push(['block_start', { blockIndex: pairIndex, ...parsePairAttributes(openMatch[1]) }]);
      buffer = buffer.slice(openMatch.index + openMatch[0].length);
      state = 'in_pair';
      return true;
    }
    // No <pair> yet: send what cannot be part of one, and hold a "<" that may still become a tag.
    const lastOpenBracket = buffer.lastIndexOf('<');
    const isTagPending = lastOpenBracket !== -1 && buffer.indexOf('>', lastOpenBracket) === -1;
    const flushEnd = isTagPending ? lastOpenBracket : buffer.length;
    const outsideText = buffer.slice(0, flushEnd);
    if (outsideText.trim() !== '') events.push(['outside_text_delta', { text: outsideText }]);
    buffer = buffer.slice(flushEnd);
    return false;
  };

  // Inside <pair> but outside its fields: only <source>, <translation> and </pair> matter; anything else is skipped.
  const readInPair = (): boolean => {
    buffer = buffer.trimStart();
    const fieldTag = Object.keys(FIELD_OPEN_TAGS).find((tag) => buffer.startsWith(tag));
    if (fieldTag !== undefined) {
      state = FIELD_OPEN_TAGS[fieldTag];
      buffer = buffer.slice(fieldTag.length);
      isFieldStart = true;
      return true;
    }
    if (buffer.startsWith(PAIR_CLOSE_TAG)) {
      state = 'between_pairs';
      buffer = buffer.slice(PAIR_CLOSE_TAG.length);
      return true;
    }
    const knownTags = [...Object.keys(FIELD_OPEN_TAGS), PAIR_CLOSE_TAG];
    const isTagPrefix = knownTags.some((tag) => tag.startsWith(buffer));
    if (isTagPrefix) return false;
    const nextBracket = buffer.indexOf('<', 1);
    buffer = nextBracket === -1 ? '' : buffer.slice(nextBracket);
    return true;
  };

  // Inside <source> or <translation>: the text up to its closing tag.
  const readField = (events: StreamEvent[]): boolean => {
    const fieldName = state === 'in_source' ? 'source' : 'translation';
    const closingTag = `</${fieldName}>`;
    if (isFieldStart) {
      if (buffer.startsWith('\n')) buffer = buffer.slice(1);
      isFieldStart = false;
      if (buffer === '') return false;
    }
    const closeIndex = buffer.indexOf(closingTag);
    if (closeIndex !== -1) {
      // The newline before the closing tag is not part of the text either.
      const fieldText = buffer.slice(0, closeIndex).replace(/\n$/, '');
      if (fieldText !== '') events.push(fieldDelta(fieldText));
      buffer = buffer.slice(closeIndex + closingTag.length);
      state = 'in_pair';
      return true;
    }
    // Holds a trailing newline too: it belongs to the field only if more text follows before the closing tag.
    let holdFrom = heldTailStart(buffer, closingTag);
    if (holdFrom > 0 && buffer[holdFrom - 1] === '\n') holdFrom -= 1;
    const fieldText = buffer.slice(0, holdFrom);
    if (fieldText !== '') events.push(fieldDelta(fieldText));
    buffer = buffer.slice(holdFrom);
    return false;
  };

  function push(text: string): StreamEvent[] {
    buffer += text;
    const events: StreamEvent[] = [];
    while (buffer !== '') {
      let canGoOn = false;
      if (state === 'between_pairs') canGoOn = readBetweenPairs(events);
      else if (state === 'in_pair') canGoOn = readInPair();
      else canGoOn = readField(events);
      if (!canGoOn) break;
    }
    return events;
  }

  function finish(): StreamEvent[] {
    const events: StreamEvent[] = [];
    const isInField = state === 'in_source' || state === 'in_translation';
    const fieldText = buffer.replace(/\n$/, '');
    if (isInField && fieldText !== '') {
      events.push(fieldDelta(fieldText));
    } else if (state === 'between_pairs' && buffer.trim() !== '') {
      events.push(['outside_text_delta', { text: buffer }]);
    }
    buffer = '';
    return events;
  }

  return { push, finish };
}
