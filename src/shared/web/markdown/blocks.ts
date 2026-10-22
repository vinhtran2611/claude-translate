// The block parser for one cell: the blockType already names the block, so each type has exactly one shape.
import type { BlockType } from '../../api-types.ts';
import { type InlineNode, type InlineOptions, parseInline, unescapeString } from './inline.ts';

export interface ListMarker {
  kind: 'bullet' | 'ordered' | 'task';
  text: string;
  isChecked: boolean;
}

export type Alignment = 'left' | 'center' | 'right';

export type Block =
  | { kind: 'paragraph'; children: InlineNode[] }
  | { kind: 'heading'; level: number; children: InlineNode[] }
  | { kind: 'thematic_break' }
  | { kind: 'list_item'; marker: ListMarker; blocks: Block[] }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'list'; isOrdered: boolean; start: number | null; items: Block[][] }
  | { kind: 'code_block'; language: string | null; text: string }
  | { kind: 'table'; alignments: (Alignment | null)[]; headerCells: InlineNode[][]; bodyRows: InlineNode[][][] }
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
// marker: null when the block has none (the same as an empty one here).
export function parseCellBlocks(pairType: BlockType, blockMarker: string | null, level: number, text: string, inlineOptions: InlineOptions): Block[] {
  const marker = blockMarker ?? '';
  const inline = (inlineText: string): InlineNode[] => parseInline(inlineText, inlineOptions);
  if (pairType === 'code') {
    // The marker is the opening fence, like "```ts": its first word is the language.
    const language = marker.replace(/^[`~]+\s*/, '').split(/\s/)[0] || null;
    return [{ kind: 'code_block', language, text }];
  }
  if (pairType === 'heading') {
    const headingLevel = Math.min(6, Math.max(1, level));
    return [{ kind: 'heading', level: headingLevel, children: inline(text.replace(/\n+/g, ' ')) }];
  }
  if (pairType === 'table') {
    const table = tableBlockOf(text, inlineOptions);
    return [table ?? { kind: 'paragraph', children: inline(text) }];
  }
  if (pairType === 'quote') {
    return [{ kind: 'quote', blocks: quoteBlocksOf(quoteContentOf(text), inlineOptions) }];
  }
  if (pairType === 'list_item') {
    return [{ kind: 'list_item', marker: listMarkerOf(marker, level), blocks: paragraphsOf(text, inlineOptions) }];
  }
  if (pairType === 'other' && THEMATIC_BREAK.test(text)) return [{ kind: 'thematic_break' }];
  // A streaming "-" or "--" may be a thematic break still arriving: nothing is shown until it is decided.
  if (pairType === 'other' && inlineOptions.isStreaming && THEMATIC_BREAK_PREFIX.test(text)) return [];

  const definition = definitionOf(text);
  if (definition?.kind === 'footnote_definition') {
    return [{ kind: 'footnote_definition', label: definition.label, children: inline(definition.body) }];
  }
  if (definition?.kind === 'link_definition') return [definition];
  return paragraphsOf(text, inlineOptions);
}

export function definitionOf(text: string): Definition | null {
  const footnoteMatch = FOOTNOTE_DEFINITION.exec(text);
  if (footnoteMatch) {
    return { kind: 'footnote_definition', label: footnoteMatch[1], body: text.slice(footnoteMatch[0].length) };
  }
  const linkMatch = LINK_DEFINITION.exec(text.trim());
  if (!linkMatch || linkMatch[1].trim() === '') return null;
  const [, label, writtenDestination, doubleQuotedTitle, singleQuotedTitle, parenthesizedTitle] = linkMatch;
  const destination = unescapeString(writtenDestination.replace(/^<|>$/g, ''));
  const writtenTitle = doubleQuotedTitle ?? singleQuotedTitle ?? parenthesizedTitle;
  const title = writtenTitle === undefined ? null : unescapeString(writtenTitle);
  return { kind: 'link_definition', label, destination, title };
}

export function listMarkerOf(marker: string, level: number): ListMarker {
  const taskMatch = TASK_MARKER.exec(marker.trim());
  if (taskMatch) return { kind: 'task', text: '', isChecked: taskMatch[1] !== ' ' };
  const orderedMatch = ORDERED_MARKER.exec(marker.trim());
  if (orderedMatch) return { kind: 'ordered', text: `${orderedMatch[1]}${orderedMatch[2]}`, isChecked: false };
  // Bullets change with depth: level 1 "•", level 2 "◦", level 3 "▪", then again from "•".
  const bullet = BULLETS[(Math.max(1, level) - 1) % BULLETS.length];
  return { kind: 'bullet', text: bullet, isChecked: false };
}

// The model copies a quote without its first "> ", but inner lines may or may not keep theirs. When every inner
// non-blank line starts with ">", that marker is the outer quote's and is stripped once; otherwise lines are content.
export function quoteContentOf(text: string): string {
  const lines = text.replace(/^>[ \t]?/, '').split('\n');
  const innerLines = lines.slice(1).filter((line) => line.trim() !== '');
  const hasOuterMarkers = innerLines.length > 0 && innerLines.every((line) => /^\s*>/.test(line));
  if (!hasOuterMarkers) return lines.join('\n');
  const unmarkedLines = lines.slice(1).map((line) => line.replace(/^\s*>[ \t]?/, ''));
  return [lines[0], ...unmarkedLines].join('\n');
}

// The streaming tail policy belongs to the end of the cell's text only: a segment that something else follows
// (an earlier paragraph, a finished table cell) is parsed as final.
function optionsAt(inlineOptions: InlineOptions, isAtTextEnd: boolean): InlineOptions {
  if (inlineOptions.isStreaming && !isAtTextEnd) return { ...inlineOptions, isStreaming: false };
  return inlineOptions;
}

function paragraphsOf(text: string, inlineOptions: InlineOptions): Block[] {
  const parts = text.split(/\n[ \t]*\n/).filter((part) => part.trim() !== '');
  return parts.map((part, index) => {
    const isLast = index === parts.length - 1;
    return { kind: 'paragraph', children: parseInline(part.trim(), optionsAt(inlineOptions, isLast)) };
  });
}

function quoteBlocksOf(text: string, inlineOptions: InlineOptions): Block[] {
  const blocks: Block[] = [];
  const lines = text.split('\n');
  let index = 0;
  const isQuoteLine = (line: string): boolean => /^\s*>/.test(line);
  // Inline options for a block that ends just before lines[index].
  const optionsHere = (): InlineOptions => optionsAt(inlineOptions, index === lines.length);

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

    const listMatch = QUOTE_LIST_LINE.exec(line);
    if (listMatch) {
      const isOrdered = /\d/.test(listMatch[1]);
      const items: Block[][] = [];
      while (index < lines.length && QUOTE_LIST_LINE.test(lines[index])) {
        const itemText = lines[index].replace(QUOTE_LIST_LINE, '');
        index++;
        items.push([{ kind: 'paragraph', children: parseInline(itemText, optionsHere()) }]);
      }
      const start = isOrdered ? parseInt(listMatch[1], 10) : null;
      blocks.push({ kind: 'list', isOrdered, start, items });
      continue;
    }

    if (THEMATIC_BREAK.test(line)) {
      blocks.push({ kind: 'thematic_break' });
      index++;
      continue;
    }

    // A streaming last line that is still only a list marker ("-", "2.") is held until its item text arrives.
    const isLastLine = index === lines.length - 1;
    if (inlineOptions.isStreaming && isLastLine && BARE_LIST_MARKER.test(line)) break;

    const paragraphLines: string[] = [];
    while (index < lines.length && lines[index].trim() !== '' && !isQuoteLine(lines[index])) {
      paragraphLines.push(lines[index]);
      index++;
    }
    blocks.push({ kind: 'paragraph', children: parseInline(paragraphLines.join('\n'), optionsHere()) });
  }
  return blocks;
}

function alignmentOf(delimiterCell: string): Alignment | null {
  const isLeft = delimiterCell.startsWith(':');
  const isRight = delimiterCell.endsWith(':');
  if (isLeft && isRight) return 'center';
  if (isRight) return 'right';
  if (isLeft) return 'left';
  return null;
}

// GFM pipe table (https://github.github.com/gfm/#tables-extension-), or tab-separated rows as pasted from a doc.
// While streaming, a delimiter row still arriving is held back so "|--" never flashes as a row. null: not a table.
export function tableBlockOf(text: string, inlineOptions: InlineOptions): Block | null {
  const lines = text
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.trim() !== '');
  if (lines.length === 0) return null;
  const isStreaming = inlineOptions.isStreaming;
  const lastIndex = lines.length - 1;
  // A backslash ending a streaming row may be escaping a pipe that has not arrived; it is held like any other.
  if (isStreaming) lines[lastIndex] = lines[lastIndex].replace(/(?<!\\)(\\\\)*\\$/, '$1');
  const isPipeTable = lines[0].includes('|');
  if (!isPipeTable && !lines[0].includes('\t')) return null;

  const cellsOf = (line: string): string[] => {
    if (isPipeTable) return splitTableRow(line);
    return line.split('\t').map((cell) => cell.trim());
  };
  // Only the last cell of the last line can still be growing, and only if no separator has closed it yet.
  const rowOf = (line: string, lineIndex: number): InlineNode[][] => {
    const cells = cellsOf(line);
    const isLastLine = lineIndex === lastIndex;
    const isLineClosed = isPipeTable ? /(?<!\\)\|\s*$/.test(line) : line.endsWith('\t');
    return cells.map((cell, column) => {
      const isGrowing = isLastLine && !isLineClosed && column === cells.length - 1;
      return parseInline(cell, optionsAt(inlineOptions, isGrowing));
    });
  };

  let bodyStart = 1;
  let alignments: (Alignment | null)[] = [];
  if (isPipeTable) {
    const hasDelimiterRow = lines.length > 1
      && TABLE_DELIMITER_ROW.test(lines[1])
      && lines[1].includes('-')
      && splitTableRow(lines[1]).length === splitTableRow(lines[0]).length;
    const isDelimiterArriving = isStreaming
      && (lines.length === 1 || (lines.length === 2 && TABLE_DELIMITER_PREFIX.test(lines[1])));
    if (!hasDelimiterRow && !isDelimiterArriving) return null;
    if (hasDelimiterRow) {
      alignments = splitTableRow(lines[1]).map(alignmentOf);
      bodyStart = 2;
    } else {
      bodyStart = lines.length;
    }
  }

  const headerCells = rowOf(lines[0], 0);
  const bodyRows = lines.slice(bodyStart).map((line, offset) => rowOf(line, bodyStart + offset));
  // A pipe table has the header's columns; a pasted tab table has as many as its widest row.
  let columnCount = headerCells.length;
  if (!isPipeTable) columnCount = Math.max(headerCells.length, ...bodyRows.map((cells) => cells.length));
  // Pads or cuts a row to columnCount cells.
  const fit = <Cell>(cells: Cell[], empty: Cell): Cell[] => Array.from({ length: columnCount }, (_, column) => cells[column] ?? empty);
  return {
    kind: 'table',
    alignments: fit(alignments, null),
    headerCells: fit(headerCells, []),
    bodyRows: bodyRows.map((cells) => fit(cells, [])),
  };
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}
