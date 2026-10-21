// Whole documents: text that no model split into pairs (Practice's evaluation), blocks found by line syntax.
import { type Block, TABLE_DELIMITER_ROW, tableBlockOf, THEMATIC_BREAK } from './blocks.ts';
import { parseInline } from './inline.ts';

const ATX_HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const LIST_LINE = /^( {0,3})([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const CODE_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)/;
const QUOTE_LINE = /^ {0,3}>/;

// A last line that is only the start of a block ("-", "2.", "##", ">"): while text is still arriving it is held back, so the
// bare mark never flashes before the words that belong to it.
const PARTIAL_BLOCK_START = /^\s*(?:[-*+_]{1,2}|\d{1,9}[.)]?|#{1,6}|>)\s*$/;

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function isBlank(line: string): boolean {
  return line.trim() === '';
}

function isOrderedMarker(marker: string): boolean {
  return /\d/.test(marker);
}

function startsBlock(line: string): boolean {
  const block_starts = [ATX_HEADING, LIST_LINE, CODE_FENCE, QUOTE_LINE, THEMATIC_BREAK];
  return block_starts.some((pattern) => pattern.test(line));
}

// The index of the first line from index on that is not blank (lines.length when there is none).
function skipBlankLines(lines: string[], index: number): number {
  let ahead = index;
  while (ahead < lines.length && isBlank(lines[ahead])) ahead++;
  return ahead;
}

// The lines of the list item whose marker line is lines[start] (item_match is LIST_LINE's match of it), without the
// marker and the item's indent, and the index of the line after the item.
function itemBodyAt(lines: string[], start: number, item_match: RegExpExecArray): [string[], number] {
  const content_column = item_match[1].length + item_match[2].length + 1;
  const body = [item_match[3]];
  let index = start + 1;
  while (index < lines.length) {
    const line = lines[index];
    if (isBlank(line)) {
      const ahead = skipBlankLines(lines, index);
      // Blank lines stay in the item only when more of the item follows them.
      if (ahead === lines.length || indentOf(lines[ahead]) < 2) break;
      body.push(...Array<string>(ahead - index).fill(''));
      index = ahead;
    } else if (indentOf(line) >= 2 || !startsBlock(line)) {
      body.push(line.slice(Math.min(indentOf(line), content_column)));
      index++;
    } else {
      break;
    }
  }
  return [body, index];
}

// The list that starts at lines[start], and the index of the line after it. Items hold blocks, so a nested list or a
// second paragraph is just more lines indented under the item; a line that is not indented continues the item's text.
function listAt(lines: string[], start: number, is_streaming: boolean): [Block, number] {
  const first = LIST_LINE.exec(lines[start])!;
  const is_ordered = isOrderedMarker(first[2]);
  const items: Block[][] = [];
  let index = start;
  while (index < lines.length) {
    const item_match = LIST_LINE.exec(lines[index]);
    if (item_match === null) break;
    if (isOrderedMarker(item_match[2]) !== is_ordered || THEMATIC_BREAK.test(lines[index])) break;
    const [body, next_index] = itemBodyAt(lines, index, item_match);
    index = next_index;
    const is_at_text_end = index >= lines.length;
    items.push(parseDocumentBlocks(body.join('\n'), is_streaming && is_at_text_end));
    // Blank lines between two items keep the list going.
    const ahead = skipBlankLines(lines, index);
    if (ahead < lines.length && LIST_LINE.test(lines[ahead])) index = ahead;
  }
  const start_number = is_ordered ? parseInt(first[2], 10) : null;
  return [{ kind: 'list', is_ordered, start: start_number, items }, index];
}

// Headings, paragraphs, bullet and numbered lists (nested, numbered from the number they start at), block quotes, fenced code,
// tables and rules, as CommonMark reads them. Setext headings, indented code and raw HTML are not recognised: they stay text.
// is_streaming: the text may still grow, so its end is read provisionally (see parseInline).
export function parseDocumentBlocks(text: string, is_streaming = false): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (is_streaming && PARTIAL_BLOCK_START.test(lines.at(-1)!)) lines.pop();
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let index = 0;

  const endParagraph = (is_last = false): void => {
    if (paragraph.length > 0) {
      const children = parseInline(paragraph.join('\n'), { is_streaming: is_streaming && is_last });
      blocks.push({ kind: 'paragraph', children });
    }
    paragraph = [];
  };
  // A block that ends just before lines[index] is read provisionally only when it ends the text.
  const isStreamingHere = (): boolean => is_streaming && index >= lines.length;
  // CommonMark: a numbered line interrupts a paragraph only when it starts at 1, so "2024. A year" stays text.
  const canStartList = (item_match: RegExpExecArray): boolean => {
    if (paragraph.length === 0 || !isOrderedMarker(item_match[2])) return true;
    return parseInt(item_match[2], 10) === 1;
  };
  const isTableStart = (): boolean => {
    if (paragraph.length > 0 || !lines[index].includes('|')) return false;
    const next_line = lines[index + 1];
    return next_line !== undefined && TABLE_DELIMITER_ROW.test(next_line) && next_line.includes('-');
  };

  while (index < lines.length) {
    const line = lines[index];
    const fence = CODE_FENCE.exec(line);
    const heading = ATX_HEADING.exec(line);
    const item = LIST_LINE.exec(line);
    if (isBlank(line)) {
      endParagraph();
      index++;
    } else if (fence !== null) {
      endParagraph();
      const code: string[] = [];
      index++;
      while (index < lines.length && !lines[index].trim().startsWith(fence[1])) {
        code.push(lines[index]);
        index++;
      }
      // Past the closing fence.
      index++;
      blocks.push({ kind: 'code_block', language: fence[2] || null, text: code.join('\n') });
    } else if (heading !== null) {
      endParagraph();
      blocks.push({ kind: 'heading', level: heading[1].length, children: parseInline(heading[2]) });
      index++;
    } else if (THEMATIC_BREAK.test(line)) {
      endParagraph();
      blocks.push({ kind: 'thematic_break' });
      index++;
    } else if (QUOTE_LINE.test(line)) {
      endParagraph();
      const quoted: string[] = [];
      while (index < lines.length && QUOTE_LINE.test(lines[index])) {
        quoted.push(lines[index].replace(/^ {0,3}>[ \t]?/, ''));
        index++;
      }
      blocks.push({ kind: 'quote', blocks: parseDocumentBlocks(quoted.join('\n'), isStreamingHere()) });
    } else if (item !== null && canStartList(item)) {
      endParagraph();
      const [list, next_index] = listAt(lines, index, is_streaming);
      blocks.push(list);
      index = next_index;
    } else if (isTableStart()) {
      const rows: string[] = [];
      while (index < lines.length && !isBlank(lines[index]) && lines[index].includes('|')) {
        rows.push(lines[index]);
        index++;
      }
      const table = tableBlockOf(rows.join('\n'), { is_streaming: isStreamingHere() });
      blocks.push(table ?? { kind: 'paragraph', children: parseInline(rows.join('\n')) });
    } else {
      paragraph.push(line.trim());
      index++;
    }
  }
  endParagraph(true);
  return blocks;
}
