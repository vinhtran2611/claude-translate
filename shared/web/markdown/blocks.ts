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

// One block list per cell.
export function parseCellBlocks(pair_type: PairType, marker: string, level: number, text: string, inline_options: InlineOptions): Block[] {
  const inline = (inline_text: string): InlineNode[] => parseInline(inline_text, inline_options);
  if (pair_type === 'code') return [{ kind: 'code_block', language: marker.replace(/^[`~]+\s*/, '').split(/\s/)[0] || null, text }];
  if (pair_type === 'heading') return [{ kind: 'heading', level: Math.min(6, Math.max(1, level)), children: inline(text.replace(/\n+/g, ' ')) }];
  if (pair_type === 'table') return [tableBlockOf(text, inline_options) ?? { kind: 'paragraph', children: inline(text) }];
  if (pair_type === 'quote') return [{ kind: 'quote', blocks: quoteBlocksOf(quoteContentOf(text), inline_options) }];
  if (pair_type === 'list_item') return [{ kind: 'list_item', marker: listMarkerOf(marker, level), blocks: paragraphsOf(text, inline_options) }];
  if (pair_type === 'other' && THEMATIC_BREAK.test(text)) return [{ kind: 'thematic_break' }];
  // A streaming "-" or "--" may be a thematic break still arriving: nothing is shown until it is decided.
  if (pair_type === 'other' && inline_options.is_streaming && THEMATIC_BREAK_PREFIX.test(text)) return [];
  const definition = definitionOf(text);
  if (definition?.kind === 'footnote_definition') return [{ kind: 'footnote_definition', label: definition.label, children: inline(definition.body) }];
  if (definition?.kind === 'link_definition') return [definition];
  return paragraphsOf(text, inline_options);
}

export function definitionOf(text: string): Definition | null {
  const footnote_match = FOOTNOTE_DEFINITION.exec(text);
  if (footnote_match) return { kind: 'footnote_definition', label: footnote_match[1], body: text.slice(footnote_match[0].length) };
  const link_match = LINK_DEFINITION.exec(text.trim());
  if (!link_match || link_match[1].trim() === '') return null;
  const title = link_match[3] ?? link_match[4] ?? link_match[5];
  return { kind: 'link_definition', label: link_match[1], destination: unescapeString(link_match[2].replace(/^<|>$/g, '')), title: title === undefined ? null : unescapeString(title) };
}

export function listMarkerOf(marker: string, level: number): ListMarker {
  const task_match = TASK_MARKER.exec(marker.trim());
  if (task_match) return { kind: 'task', text: '', is_checked: task_match[1] !== ' ' };
  const ordered_match = ORDERED_MARKER.exec(marker.trim());
  if (ordered_match) return { kind: 'ordered', text: `${ordered_match[1]}${ordered_match[2]}`, is_checked: false };
  return { kind: 'bullet', text: ['•', '◦', '▪'][(Math.max(1, level) - 1) % 3], is_checked: false };
}

// The model copies a quote without its first "> ", but inner lines may or may not keep theirs. When every inner
// non-blank line starts with ">", that marker is the outer quote's and is stripped once; otherwise lines are content.
export function quoteContentOf(text: string): string {
  const lines = text.replace(/^>[ \t]?/, '').split('\n');
  const inner_lines = lines.slice(1).filter((line) => line.trim() !== '');
  const has_outer_markers = inner_lines.length > 0 && inner_lines.every((line) => /^\s*>/.test(line));
  return has_outer_markers ? [lines[0], ...lines.slice(1).map((line) => line.replace(/^\s*>[ \t]?/, ''))].join('\n') : lines.join('\n');
}

// The streaming tail policy belongs to the end of the cell's text only: a segment that something else follows
// (an earlier paragraph, a finished table cell) is parsed as final.
function optionsAt(inline_options: InlineOptions, is_at_text_end: boolean): InlineOptions {
  return inline_options.is_streaming && !is_at_text_end ? { ...inline_options, is_streaming: false } : inline_options;
}

function paragraphsOf(text: string, inline_options: InlineOptions): Block[] {
  const parts = text.split(/\n[ \t]*\n/).filter((part) => part.trim() !== '');
  return parts.map((part, index) => ({ kind: 'paragraph', children: parseInline(part.trim(), optionsAt(inline_options, index === parts.length - 1)) }));
}

function quoteBlocksOf(text: string, inline_options: InlineOptions): Block[] {
  const blocks: Block[] = [];
  const lines = text.split('\n');
  const LIST_LINE = /^\s*([-*+]|\d{1,9}[.)])\s+/;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === '') { index++; continue; }
    if (/^\s*>/.test(line)) {
      const nested: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) nested.push(lines[index++].replace(/^\s*>[ \t]?/, ''));
      blocks.push({ kind: 'quote', blocks: quoteBlocksOf(nested.join('\n'), optionsAt(inline_options, index === lines.length)) });
      continue;
    }
    const list_match = LIST_LINE.exec(line);
    if (list_match) {
      const is_ordered = /\d/.test(list_match[1]);
      const items: Block[][] = [];
      while (index < lines.length && LIST_LINE.test(lines[index])) {
        const item_text = lines[index++].replace(LIST_LINE, '');
        items.push([{ kind: 'paragraph', children: parseInline(item_text, optionsAt(inline_options, index === lines.length)) }]);
      }
      blocks.push({ kind: 'list', is_ordered, start: is_ordered ? parseInt(list_match[1], 10) : null, items });
      continue;
    }
    if (THEMATIC_BREAK.test(line)) { blocks.push({ kind: 'thematic_break' }); index++; continue; }
    // A streaming last line that is still only a list marker ("-", "2.") is held until its item text arrives.
    if (inline_options.is_streaming && index === lines.length - 1 && /^\s*([-*+]|\d{1,9}[.)]?)\s*$/.test(line)) break;
    const paragraph_lines: string[] = [];
    while (index < lines.length && lines[index].trim() !== '' && !/^\s*>/.test(lines[index])) paragraph_lines.push(lines[index++]);
    blocks.push({ kind: 'paragraph', children: parseInline(paragraph_lines.join('\n'), optionsAt(inline_options, index === lines.length)) });
  }
  return blocks;
}

// GFM pipe table (https://github.github.com/gfm/#tables-extension-), or tab-separated rows as pasted from a doc.
// While streaming, a delimiter row still arriving is held back so "|--" never flashes as a row. null: not a table.
export function tableBlockOf(text: string, inline_options: InlineOptions): Block | null {
  const lines = text.split('\n').map((line) => line.replace(/\r$/, '')).filter((line) => line.trim() !== '');
  if (lines.length === 0) return null;
  const is_streaming = inline_options.is_streaming;
  // A backslash ending a streaming row may be escaping a pipe that has not arrived; it is held like any other.
  if (is_streaming) lines[lines.length - 1] = lines[lines.length - 1].replace(/(?<!\\)(\\\\)*\\$/, '$1');
  const is_pipe_table = lines[0].includes('|');
  const separator = is_pipe_table ? null : '\t';
  if (!is_pipe_table && !lines[0].includes('\t')) return null;
  const cellsOf = (line: string): string[] => is_pipe_table ? splitTableRow(line) : line.split('\t').map((cell) => cell.trim());
  // Only the last cell of the last line can still be growing, and only if no separator has closed it yet.
  const rowOf = (line: string, line_index: number): InlineNode[][] => {
    const cells = cellsOf(line);
    const is_last_line = line_index === lines.length - 1;
    const is_line_closed = is_pipe_table ? /(?<!\\)\|\s*$/.test(line) : separator !== null && line.endsWith(separator);
    return cells.map((cell, column) => parseInline(cell, optionsAt(inline_options, is_last_line && !is_line_closed && column === cells.length - 1)));
  };
  const header_line_index = 0;
  let body_start = 1;
  let alignments: (Alignment | null)[] = [];
  if (is_pipe_table) {
    const has_delimiter_row = lines.length > 1 && TABLE_DELIMITER_ROW.test(lines[1]) && lines[1].includes('-')
      && splitTableRow(lines[1]).length === splitTableRow(lines[0]).length;
    const is_delimiter_arriving = is_streaming && (lines.length === 1 || lines.length === 2 && TABLE_DELIMITER_PREFIX.test(lines[1]));
    if (!has_delimiter_row && !is_delimiter_arriving) return null;
    alignments = has_delimiter_row
      ? splitTableRow(lines[1]).map((cell) => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : cell.startsWith(':') ? 'left' : null)
      : [];
    body_start = has_delimiter_row ? 2 : lines.length;
  }
  const header_cells = rowOf(lines[header_line_index], header_line_index);
  const body_rows = lines.slice(body_start).map((line, offset) => rowOf(line, body_start + offset));
  const column_count = is_pipe_table ? header_cells.length : Math.max(header_cells.length, ...body_rows.map((cells) => cells.length));
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
