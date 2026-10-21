// Turns the model's <pair><source>…</source><translation>…</translation></pair> reply into page events as the text
// arrives. Text outside any pair becomes unpaired_delta, which is how a reply that ignores the format still reaches
// the page.
import type { PairType, StreamEvent } from '../shared/api.ts';

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

// <pair type="list_item" level="2" marker="-">: an unknown type becomes 'other', a missing level 0.
function parsePairAttributes(attribute_text: string): { pair_type: PairType; level: number; marker: string } {
  const attributes: Record<string, string | undefined> = {};
  for (const match of attribute_text.matchAll(/(\w+)="([^"]*)"/g)) attributes[match[1]] = match[2];
  const is_known_type = attributes.type !== undefined && PAIR_TYPES.has(attributes.type);
  return {
    pair_type: is_known_type ? (attributes.type as PairType) : 'other',
    level: Number.parseInt(attributes.level ?? '', 10) || 0,
    marker: attributes.marker ?? '',
  };
}

// Index from which text could still be the start of closing_tag; text.length when no suffix can be.
function heldTailStart(text: string, closing_tag: string): number {
  for (let index = Math.max(0, text.length - closing_tag.length + 1); index < text.length; index++) {
    if (closing_tag.startsWith(text.slice(index))) return index;
  }
  return text.length;
}

export function createPairStreamParser(): PairStreamParser {
  // Text received but not yet turned into events.
  let buffer = '';
  let state: ParserState = 'between_pairs';
  let pair_index = -1;
  // True right after <source> or <translation>: the newline that usually follows the tag is not part of the text.
  let is_field_start = false;

  // The delta event for text inside the field being read.
  const fieldDelta = (text: string): StreamEvent => {
    if (state === 'in_source') return ['source_delta', { pair_index, text }];
    return ['translation_delta', { pair_index, text }];
  };

  // Each read step below handles the buffer in one state. It returns true when it changed state and the loop should
  // go on, false when it must wait for more text.

  const readBetweenPairs = (events: StreamEvent[]): boolean => {
    const open_match = PAIR_OPEN_TAG.exec(buffer);
    if (open_match) {
      const unpaired_text = buffer.slice(0, open_match.index);
      if (unpaired_text.trim() !== '') events.push(['unpaired_delta', { text: unpaired_text }]);
      pair_index += 1;
      events.push(['pair_start', { pair_index, ...parsePairAttributes(open_match[1]) }]);
      buffer = buffer.slice(open_match.index + open_match[0].length);
      state = 'in_pair';
      return true;
    }
    // No <pair> yet: send what cannot be part of one, and hold a "<" that may still become a tag.
    const last_open_bracket = buffer.lastIndexOf('<');
    const is_tag_pending = last_open_bracket !== -1 && buffer.indexOf('>', last_open_bracket) === -1;
    const flush_end = is_tag_pending ? last_open_bracket : buffer.length;
    const unpaired_text = buffer.slice(0, flush_end);
    if (unpaired_text.trim() !== '') events.push(['unpaired_delta', { text: unpaired_text }]);
    buffer = buffer.slice(flush_end);
    return false;
  };

  // Inside <pair> but outside its fields: only <source>, <translation> and </pair> matter; anything else is skipped.
  const readInPair = (): boolean => {
    buffer = buffer.trimStart();
    const field_tag = Object.keys(FIELD_OPEN_TAGS).find((tag) => buffer.startsWith(tag));
    if (field_tag !== undefined) {
      state = FIELD_OPEN_TAGS[field_tag];
      buffer = buffer.slice(field_tag.length);
      is_field_start = true;
      return true;
    }
    if (buffer.startsWith(PAIR_CLOSE_TAG)) {
      state = 'between_pairs';
      buffer = buffer.slice(PAIR_CLOSE_TAG.length);
      return true;
    }
    const known_tags = [...Object.keys(FIELD_OPEN_TAGS), PAIR_CLOSE_TAG];
    const is_tag_prefix = known_tags.some((tag) => tag.startsWith(buffer));
    if (is_tag_prefix) return false;
    const next_bracket = buffer.indexOf('<', 1);
    buffer = next_bracket === -1 ? '' : buffer.slice(next_bracket);
    return true;
  };

  // Inside <source> or <translation>: the text up to its closing tag.
  const readField = (events: StreamEvent[]): boolean => {
    const field_name = state === 'in_source' ? 'source' : 'translation';
    const closing_tag = `</${field_name}>`;
    if (is_field_start) {
      if (buffer.startsWith('\n')) buffer = buffer.slice(1);
      is_field_start = false;
      if (buffer === '') return false;
    }
    const close_index = buffer.indexOf(closing_tag);
    if (close_index !== -1) {
      // The newline before the closing tag is not part of the text either.
      const field_text = buffer.slice(0, close_index).replace(/\n$/, '');
      if (field_text !== '') events.push(fieldDelta(field_text));
      buffer = buffer.slice(close_index + closing_tag.length);
      state = 'in_pair';
      return true;
    }
    // Holds a trailing newline too: it belongs to the field only if more text follows before the closing tag.
    let hold_from = heldTailStart(buffer, closing_tag);
    if (hold_from > 0 && buffer[hold_from - 1] === '\n') hold_from -= 1;
    const field_text = buffer.slice(0, hold_from);
    if (field_text !== '') events.push(fieldDelta(field_text));
    buffer = buffer.slice(hold_from);
    return false;
  };

  function push(text: string): StreamEvent[] {
    buffer += text;
    const events: StreamEvent[] = [];
    while (buffer !== '') {
      let can_go_on = false;
      if (state === 'between_pairs') can_go_on = readBetweenPairs(events);
      else if (state === 'in_pair') can_go_on = readInPair();
      else can_go_on = readField(events);
      if (!can_go_on) break;
    }
    return events;
  }

  function finish(): StreamEvent[] {
    const events: StreamEvent[] = [];
    const is_in_field = state === 'in_source' || state === 'in_translation';
    const field_text = buffer.replace(/\n$/, '');
    if (is_in_field && field_text !== '') {
      events.push(fieldDelta(field_text));
    } else if (state === 'between_pairs' && buffer.trim() !== '') {
      events.push(['unpaired_delta', { text: buffer }]);
    }
    buffer = '';
    return events;
  }

  return { push, finish };
}
