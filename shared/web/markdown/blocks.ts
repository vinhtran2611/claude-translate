// The block parser for one cell: pair_type already names the block, so each type has exactly one shape.
import type { PairType } from '../../api.ts';
import { type InlineNode, type InlineOptions, parseInline, unescapeString } from './inline.ts';

export interface ListMarker {
  kind: 'bullet' | 'ordered' | 'task';
  text: string;
  is_checked: boolean;
}

export type Alignment = 'left' | 'center' | 'right';

export type Block =
  | { kind: 'paragraph'; children: InlineNode[] }
  | { kind: 'heading'; level: number; children: InlineNode[] }
  | { kind: 'thematic_break' }
  | { kind: 'list_item'; marker: ListMarker; blocks: Block[] }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'list'; is_ordered: boolean; start: number | null; items: Block[][] }
  | { kind: 'code_block'; language: string | null; text: string }
  | { kind: 'table'; alignments: (Alignment | null)[]; header_cells: InlineNode[][]; body_rows: InlineNode[][][] }
  | { kind: 'footnote_definition'; label: string; children: InlineNode[] }
  | { kind: 'link_definition'; label: string; destination: string; title: string | null };

type Definition =
  | { kind: 'footnote_definition'; label: string; body: string }
  | { kind: 'link_definition'; label: string; destination: string; title: string | null };

// CommonMark thematic break (https://spec.commonmark.org/0.31.2/#thematic-breaks), except any indentation is accepted.
export const THEMATIC_BREAK = /^\s*([-*_])(\s*\1){2,}\s*$/;
const THEMATIC_BREAK_PREFIX = /^\s*([-*_])(\s*\1)?\s*$/;
const FOOTNOTE_DEFINITION = /^\[\^([^\s\]]{1,99})\]:[ \t]*/;
const LINK_DEFINITION = /^\[((?:[^\\[\]]|\\.){1,999})\]:[ \t]*\n?[ \t]*(<[^<>\n]*>|\S+)(?:[ \t]+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?[ \t]*$/;
export const TABLE_DELIMITER_ROW = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const TABLE_DELIMITER_PREFIX = /^\s*\|?[\s:|-]*$/;
const ORDERED_MARKER = /^(\d{1,9})([.)])$/;
const TASK_MARKER = /^[-*+]\s+\[([ xX])\]$/;

const BULLETS = ['•', '◦', '▪'];
// A list line inside a quote: "- item", "* item", "1. item", "2) item".
const QUOTE_LIST_LINE = /^\s*([-*+]|\d{1,9}[.)])\s+/;
// A line that is still only a list marker ("-", "2."), with no item text yet.
const BARE_LIST_MARKER = /^\s*([-*+]|\d{1,9}[.)]?)\s*$/;

// One block list per cell.
export function parseCellBlocks(pair_type: PairType, marker: string, level: number, text: string, inline_options: InlineOptions): Block[] {
  const inline = (inline_text: string): InlineNode[] => parseInline(inline_text, inline_options);
  if (pair_type === 'code') {
    // The marker is the opening fence, like "```ts": its first word is the language.
    const language = marker.replace(/^[`~]+\s*/, '').split(/\s/)[0] || null;
    return [{ kind: 'code_block', language, text }];
  }
  if (pair_type === 'heading') {
    const heading_level = Math.min(6, Math.max(1, level));
    return [{ kind: 'heading', level: heading_level, children: inline(text.replace(/\n+/g, ' ')) }];
  }
  if (pair_type === 'table') {
    const table = tableBlockOf(text, inline_options);
    return [table ?? { kind: 'paragraph', children: inline(text) }];
  }
  if (pair_type === 'quote') {
    return [{ kind: 'quote', blocks: quoteBlocksOf(quoteContentOf(text), inline_options) }];
  }
  if (pair_type === 'list_item') {
    return [{ kind: 'list_item', marker: listMarkerOf(marker, level), blocks: paragraphsOf(text, inline_options) }];
  }
  if (pair_type === 'other' && THEMATIC_BREAK.test(text)) return [{ kind: 'thematic_break' }];
  // A streaming "-" or "--" may be a thematic break still arriving: nothing is shown until it is decided.
  if (pair_type === 'other' && inline_options.is_streaming && THEMATIC_BREAK_PREFIX.test(text)) return [];

  const definition = definitionOf(text);
  if (definition?.kind === 'footnote_definition') {
    return [{ kind: 'footnote_definition', label: definition.label, children: inline(definition.body) }];
  }
  if (definition?.kind === 'link_definition') return [definition];
  return paragraphsOf(text, inline_options);
}

export function definitionOf(text: string): Definition | null {
  const footnote_match = FOOTNOTE_DEFINITION.exec(text);
  if (footnote_match) {
    return { kind: 'footnote_definition', label: footnote_match[1], body: text.slice(footnote_match[0].length) };
  }
  const link_match = LINK_DEFINITION.exec(text.trim());
  if (!link_match || link_match[1].trim() === '') return null;
  const [, label, written_destination, double_quoted_title, single_quoted_title, parenthesized_title] = link_match;
  const destination = unescapeString(written_destination.replace(/^<|>$/g, ''));
  const written_title = double_quoted_title ?? single_quoted_title ?? parenthesized_title;
  const title = written_title === undefined ? null : unescapeString(written_title);
  return { kind: 'link_definition', label, destination, title };
}

export function listMarkerOf(marker: string, level: number): ListMarker {
  const task_match = TASK_MARKER.exec(marker.trim());
  if (task_match) return { kind: 'task', text: '', is_checked: task_match[1] !== ' ' };
  const ordered_match = ORDERED_MARKER.exec(marker.trim());
  if (ordered_match) return { kind: 'ordered', text: `${ordered_match[1]}${ordered_match[2]}`, is_checked: false };
  // Bullets change with depth: level 1 "•", level 2 "◦", level 3 "▪", then again from "•".
  const bullet = BULLETS[(Math.max(1, level) - 1) % BULLETS.length];
  return { kind: 'bullet', text: bullet, is_checked: false };
}

// The model copies a quote without its first "> ", but inner lines may or may not keep theirs. When every inner
// non-blank line starts with ">", that marker is the outer quote's and is stripped once; otherwise lines are content.
export function quoteContentOf(text: string): string {
  const lines = text.replace(/^>[ \t]?/, '').split('\n');
  const inner_lines = lines.slice(1).filter((line) => line.trim() !== '');
  const has_outer_markers = inner_lines.length > 0 && inner_lines.every((line) => /^\s*>/.test(line));
  if (!has_outer_markers) return lines.join('\n');
  const unmarked_lines = lines.slice(1).map((line) => line.replace(/^\s*>[ \t]?/, ''));
  return [lines[0], ...unmarked_lines].join('\n');
}

// The streaming tail policy belongs to the end of the cell's text only: a segment that something else follows
// (an earlier paragraph, a finished table cell) is parsed as final.
function optionsAt(inline_options: InlineOptions, is_at_text_end: boolean): InlineOptions {
  if (inline_options.is_streaming && !is_at_text_end) return { ...inline_options, is_streaming: false };
  return inline_options;
}

function paragraphsOf(text: string, inline_options: InlineOptions): Block[] {
  const parts = text.split(/\n[ \t]*\n/).filter((part) => part.trim() !== '');
  return parts.map((part, index) => {
    const is_last = index === parts.length - 1;
    return { kind: 'paragraph', children: parseInline(part.trim(), optionsAt(inline_options, is_last)) };
  });
}

function quoteBlocksOf(text: string, inline_options: InlineOptions): Block[] {
  const blocks: Block[] = [];
  const lines = text.split('\n');
  let index = 0;
  const isQuoteLine = (line: string): boolean => /^\s*>/.test(line);
  // Inline options for a block that ends just before lines[index].
  const optionsHere = (): InlineOptions => optionsAt(inline_options, index === lines.length);

  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === '') {
      index++;
      continue;
    }

    if (isQuoteLine(line)) {
      const nested: string[] = [];
      while (index < lines.length && isQuoteLine(lines[index])) {
        nested.push(lines[index].replace(/^\s*>[ \t]?/, ''));
        index++;
      }
      blocks.push({ kind: 'quote', blocks: quoteBlocksOf(nested.join('\n'), optionsHere()) });
      continue;
    }

    const list_match = QUOTE_LIST_LINE.exec(line);
    if (list_match) {
      const is_ordered = /\d/.test(list_match[1]);
      const items: Block[][] = [];
      while (index < lines.length && QUOTE_LIST_LINE.test(lines[index])) {
        const item_text = lines[index].replace(QUOTE_LIST_LINE, '');
        index++;
        items.push([{ kind: 'paragraph', children: parseInline(item_text, optionsHere()) }]);
      }
      const start = is_ordered ? parseInt(list_match[1], 10) : null;
      blocks.push({ kind: 'list', is_ordered, start, items });
      continue;
    }

    if (THEMATIC_BREAK.test(line)) {
      blocks.push({ kind: 'thematic_break' });
      index++;
      continue;
    }

    // A streaming last line that is still only a list marker ("-", "2.") is held until its item text arrives.
    const is_last_line = index === lines.length - 1;
    if (inline_options.is_streaming && is_last_line && BARE_LIST_MARKER.test(line)) break;

    const paragraph_lines: string[] = [];
    while (index < lines.length && lines[index].trim() !== '' && !isQuoteLine(lines[index])) {
      paragraph_lines.push(lines[index]);
      index++;
    }
    blocks.push({ kind: 'paragraph', children: parseInline(paragraph_lines.join('\n'), optionsHere()) });
  }
  return blocks;
}

function alignmentOf(delimiter_cell: string): Alignment | null {
  const is_left = delimiter_cell.startsWith(':');
  const is_right = delimiter_cell.endsWith(':');
  if (is_left && is_right) return 'center';
  if (is_right) return 'right';
  if (is_left) return 'left';
  return null;
}

// GFM pipe table (https://github.github.com/gfm/#tables-extension-), or tab-separated rows as pasted from a doc.
// While streaming, a delimiter row still arriving is held back so "|--" never flashes as a row. null: not a table.
export function tableBlockOf(text: string, inline_options: InlineOptions): Block | null {
  const lines = text
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.trim() !== '');
  if (lines.length === 0) return null;
  const is_streaming = inline_options.is_streaming;
  const last_index = lines.length - 1;
  // A backslash ending a streaming row may be escaping a pipe that has not arrived; it is held like any other.
  if (is_streaming) lines[last_index] = lines[last_index].replace(/(?<!\\)(\\\\)*\\$/, '$1');
  const is_pipe_table = lines[0].includes('|');
  if (!is_pipe_table && !lines[0].includes('\t')) return null;

  const cellsOf = (line: string): string[] => {
    if (is_pipe_table) return splitTableRow(line);
    return line.split('\t').map((cell) => cell.trim());
  };
  // Only the last cell of the last line can still be growing, and only if no separator has closed it yet.
  const rowOf = (line: string, line_index: number): InlineNode[][] => {
    const cells = cellsOf(line);
    const is_last_line = line_index === last_index;
    const is_line_closed = is_pipe_table ? /(?<!\\)\|\s*$/.test(line) : line.endsWith('\t');
    return cells.map((cell, column) => {
      const is_growing = is_last_line && !is_line_closed && column === cells.length - 1;
      return parseInline(cell, optionsAt(inline_options, is_growing));
    });
  };

  let body_start = 1;
  let alignments: (Alignment | null)[] = [];
  if (is_pipe_table) {
    const has_delimiter_row = lines.length > 1
      && TABLE_DELIMITER_ROW.test(lines[1])
      && lines[1].includes('-')
      && splitTableRow(lines[1]).length === splitTableRow(lines[0]).length;
    const is_delimiter_arriving = is_streaming
      && (lines.length === 1 || (lines.length === 2 && TABLE_DELIMITER_PREFIX.test(lines[1])));
    if (!has_delimiter_row && !is_delimiter_arriving) return null;
    if (has_delimiter_row) {
      alignments = splitTableRow(lines[1]).map(alignmentOf);
      body_start = 2;
    } else {
      body_start = lines.length;
    }
  }

  const header_cells = rowOf(lines[0], 0);
  const body_rows = lines.slice(body_start).map((line, offset) => rowOf(line, body_start + offset));
  // A pipe table has the header's columns; a pasted tab table has as many as its widest row.
  let column_count = header_cells.length;
  if (!is_pipe_table) column_count = Math.max(header_cells.length, ...body_rows.map((cells) => cells.length));
  // Pads or cuts a row to column_count cells.
  const fit = <Cell>(cells: Cell[], empty: Cell): Cell[] => Array.from({ length: column_count }, (_, column) => cells[column] ?? empty);
  return {
    kind: 'table',
    alignments: fit(alignments, null),
    header_cells: fit(header_cells, []),
    body_rows: body_rows.map((cells) => fit(cells, [])),
  };
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}
