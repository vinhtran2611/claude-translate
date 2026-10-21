// Whole documents: text that no model split into pairs (Practice's evaluation), blocks found by line syntax.
import { type Block, TABLE_DELIMITER_ROW, tableBlockOf, THEMATIC_BREAK } from './blocks.ts';
import { parseInline } from './inline.ts';

const ATX_HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const LIST_LINE = /^( {0,3})([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const CODE_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)/;
const QUOTE_LINE = /^ {0,3}>/;

const indentOf = (line: string): number => line.length - line.trimStart().length;
const isOrderedMarker = (marker: string): boolean => /\d/.test(marker);
const startsBlock = (line: string): boolean => [ATX_HEADING, LIST_LINE, CODE_FENCE, QUOTE_LINE, THEMATIC_BREAK].some((pattern) => pattern.test(line));

// The list that starts at lines[start], and the index of the line after it. Items hold blocks, so a nested list or a
// second paragraph is just more lines indented under the item; a line that is not indented continues the item's text.
function listAt(lines: string[], start: number, is_streaming: boolean): [Block, number] {
  const first = LIST_LINE.exec(lines[start])!;
  const is_ordered = isOrderedMarker(first[2]);
  const items: Block[][] = [];
  let index = start;
  while (index < lines.length) {
    const match = LIST_LINE.exec(lines[index]);
    if (match === null || isOrderedMarker(match[2]) !== is_ordered || THEMATIC_BREAK.test(lines[index])) break;
    const content_column = match[1].length + match[2].length + 1;
    const body = [match[3]];
    index++;
    while (index < lines.length) {
      const next = lines[index];
      if (next.trim() === '') {
        let ahead = index;
        while (ahead < lines.length && lines[ahead].trim() === '') ahead++;
        // Blank lines stay in the item only when more of the item follows them.
        if (ahead === lines.length || indentOf(lines[ahead]) < 2) break;
        body.push(...Array<string>(ahead - index).fill(''));
        index = ahead;
      } else if (indentOf(next) >= 2 || !startsBlock(next)) {
        body.push(next.slice(Math.min(indentOf(next), content_column)));
        index++;
      } else {
        break;
      }
    }
    items.push(parseDocumentBlocks(body.join('\n'), is_streaming && index >= lines.length));
    let ahead = index;
    while (ahead < lines.length && lines[ahead].trim() === '') ahead++;
    if (ahead < lines.length && LIST_LINE.test(lines[ahead])) index = ahead;
  }
  return [{ kind: 'list', is_ordered, start: is_ordered ? parseInt(first[2], 10) : null, items }, index];
}

// A last line that is only the start of a block ("-", "2.", "##", ">"): while text is still arriving it is held back, so the
// bare mark never flashes before the words that belong to it.
const PARTIAL_BLOCK_START = /^\s*(?:[-*+_]{1,2}|\d{1,9}[.)]?|#{1,6}|>)\s*$/;

// Headings, paragraphs, bullet and numbered lists (nested, numbered from the number they start at), block quotes, fenced code,
// tables and rules, as CommonMark reads them. Setext headings, indented code and raw HTML are not recognised: they stay text.
// is_streaming: the text may still grow, so its end is read provisionally (see parseInline).
export function parseDocumentBlocks(text: string, is_streaming = false): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (is_streaming && PARTIAL_BLOCK_START.test(lines.at(-1)!)) lines.pop();
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const endParagraph = (is_last = false): void => {
    if (paragraph.length > 0) blocks.push({ kind: 'paragraph', children: parseInline(paragraph.join('\n'), { is_streaming: is_streaming && is_last }) });
    paragraph = [];
  };
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const fence = CODE_FENCE.exec(line);
    const heading = ATX_HEADING.exec(line);
    const item = LIST_LINE.exec(line);
    if (line.trim() === '') {
      endParagraph();
      index++;
    } else if (fence !== null) {
      endParagraph();
      const code: string[] = [];
      for (index++; index < lines.length && !lines[index].trim().startsWith(fence[1]); index++) code.push(lines[index]);
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
      for (; index < lines.length && QUOTE_LINE.test(lines[index]); index++) quoted.push(lines[index].replace(/^ {0,3}>[ \t]?/, ''));
      blocks.push({ kind: 'quote', blocks: parseDocumentBlocks(quoted.join('\n'), is_streaming && index >= lines.length) });
    } else if (item !== null && (paragraph.length === 0 || !isOrderedMarker(item[2]) || parseInt(item[2], 10) === 1)) {
      endParagraph();
      const [list, next] = listAt(lines, index, is_streaming);
      blocks.push(list);
      index = next;
    } else if (paragraph.length === 0 && line.includes('|') && index + 1 < lines.length && TABLE_DELIMITER_ROW.test(lines[index + 1]) && lines[index + 1].includes('-')) {
      const rows: string[] = [];
      for (; index < lines.length && lines[index].trim() !== '' && lines[index].includes('|'); index++) rows.push(lines[index]);
      const table = tableBlockOf(rows.join('\n'), { is_streaming: is_streaming && index >= lines.length });
      blocks.push(table ?? { kind: 'paragraph', children: parseInline(rows.join('\n')) });
    } else {
      paragraph.push(line.trim());
      index++;
    }
  }
  endParagraph(true);
  return blocks;
}
