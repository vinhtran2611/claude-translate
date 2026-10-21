// The DOM: the only writer.
import type { Block } from './blocks.ts';
import { parseDocumentBlocks } from './document.ts';
import { type DocumentIndex, documentIndexOf } from './document-index.ts';
import type { InlineNode } from './inline.ts';
import { ANCHOR_ID_PREFIX, type LinkTarget, linkTargetOf } from './links.ts';

export interface RenderContext {
  side: 'source' | 'translation';
  pair_index: number;
  document_index: DocumentIndex;
  is_streaming: boolean;
  is_document_complete: boolean;
}

// context: { side: 'source' | 'translation', pair_index, document_index, is_streaming, is_document_complete }.
// Ids go on the source side only, so they stay unique; a translation-side link to "#x" scrolls to the same row.
// A streaming cell ends in a caret. "#x" links are checked only once the document is complete: until then the
// heading a table of contents points to may simply not have arrived.
export function renderCellContent(content_element: HTMLElement, blocks: Block[], context: RenderContext): void {
  const anchor_ids = context.is_document_complete ? context.document_index.anchor_ids : null;
  const render_context: ElementContext = { ...context, anchor_ids, used_ids: new Set() };
  content_element.replaceChildren(...blocks.map((block) => blockElementOf(block, render_context)));
  if (context.is_streaming) caretContainerOf(content_element)?.append(element('span', 'md-caret'));
}

// Draws a whole document (see parseDocumentBlocks) into content_element: the same elements and classes as a translated cell.
// is_streaming: the text is still arriving, so its end is provisional and a caret follows it.
export function renderDocument(content_element: HTMLElement, text: string, is_streaming = false): void {
  const blocks = parseDocumentBlocks(text, is_streaming);
  const context: RenderContext = {
    side: 'translation',
    pair_index: -1,
    document_index: documentIndexOf([]),
    is_streaming,
    is_document_complete: true,
  };
  renderCellContent(content_element, blocks, context);
}

// The innermost last element that holds text, so the caret sits after the last character, not on a line of its own.
// null when the cell holds blocks but none with text (a rule): a caret after them would add a line that vanishes later.
function caretContainerOf(content_element: Element): Element | null {
  let container = content_element;
  while (true) {
    const last = [...container.children].filter((child) => child.textContent.trim() !== '').at(-1);
    if (!last && container === content_element && content_element.children.length > 0) return null;
    if (!last || last.matches(INLINE_ELEMENTS)) return container;
    if (last.matches('.md-code-block')) return last.querySelector('code');
    container = last;
  }
}

// anchor_ids: null while "#x" links cannot be checked yet. used_ids: footnote ids this cell already carries.
interface ElementContext extends RenderContext {
  anchor_ids: Set<string> | null;
  used_ids: Set<string>;
}

const HEADING_TAGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const;
// Elements that hold text inline; the caret goes inside the last of them, not after it.
const INLINE_ELEMENTS = 'a, span, strong, em, del, code, sup, sub, kbd, mark, s, ins, u, small';

function element<Tag extends keyof HTMLElementTagNameMap>(
  tag_name: Tag, class_name: string | null, children: (Node | string)[] = [],
): HTMLElementTagNameMap[Tag] {
  const node = document.createElement(tag_name);
  if (class_name) node.className = class_name;
  node.append(...children);
  return node;
}

type BlockOf<Kind extends Block['kind']> = Extract<Block, { kind: Kind }>;

function blockElementOf(block: Block, context: ElementContext): HTMLElement {
  switch (block.kind) {
    case 'paragraph':
      return element('p', 'md-p', inlineNodesOf(block.children, context));
    case 'heading':
      return headingElementOf(block, context);
    case 'thematic_break':
      return element('hr', 'md-hr');
    case 'code_block':
      return codeBlockElementOf(block);
    case 'quote':
      return element('blockquote', 'md-quote', blockElementsOf(block.blocks, context));
    case 'list':
      return listElementOf(block, context);
    case 'list_item':
      return listItemElementOf(block, context);
    case 'table':
      return tableElementOf(block, context);
    case 'footnote_definition':
      return footnoteElementOf(block, context);
    case 'link_definition':
      return linkDefinitionElementOf(block, context);
  }
  throw new Error(`unknown block kind ${(block as { kind: string }).kind}`);
}

function blockElementsOf(blocks: Block[], context: ElementContext): HTMLElement[] {
  return blocks.map((inner) => blockElementOf(inner, context));
}

function headingElementOf(block: BlockOf<'heading'>, context: ElementContext): HTMLElement {
  const tag_name = HEADING_TAGS[block.level - 1];
  const heading = element(tag_name, `md-heading md-h${block.level}`, inlineNodesOf(block.children, context));
  const slug = context.document_index.heading_slugs.get(context.pair_index);
  if (context.side === 'source' && slug !== undefined) heading.id = `${ANCHOR_ID_PREFIX}${slug}`;
  return heading;
}

function codeBlockElementOf(block: BlockOf<'code_block'>): HTMLElement {
  const code_block = element('div', 'md-code-block');
  if (block.language) code_block.append(element('div', 'md-code-language', [block.language]));
  code_block.append(element('pre', null, [element('code', null, [block.text])]));
  return code_block;
}

function listElementOf(block: BlockOf<'list'>, context: ElementContext): HTMLElement {
  const items = block.items.map((item_blocks) => element('li', null, blockElementsOf(item_blocks, context)));
  if (!block.is_ordered) return element('ul', 'md-list', items);
  const list = element('ol', 'md-list', items);
  if (block.start !== null && block.start !== 1) list.start = block.start;
  return list;
}

function listItemElementOf(block: BlockOf<'list_item'>, context: ElementContext): HTMLElement {
  const is_task = block.marker.kind === 'task';
  // A task's box is drawn by CSS, so its marker holds no text.
  const marker = element('span', `md-marker is-${block.marker.kind}`, is_task ? [] : [block.marker.text]);
  marker.setAttribute('aria-hidden', 'true');
  if (is_task) marker.classList.toggle('is-checked', block.marker.is_checked);
  const body = element('div', 'md-list-body', blockElementsOf(block.blocks, context));
  return element('div', 'md-list-item', [marker, body]);
}

function tableElementOf(block: BlockOf<'table'>, context: ElementContext): HTMLElement {
  const cellElementOf = (tag_name: 'th' | 'td', cell: InlineNode[], column: number): HTMLTableCellElement => {
    const cell_element = element(tag_name, null, inlineNodesOf(cell, context));
    const alignment = block.alignments[column];
    if (alignment) cell_element.style.textAlign = alignment;
    return cell_element;
  };
  const header_row = element('tr', null, block.header_cells.map((cell, column) => cellElementOf('th', cell, column)));
  const body_rows = block.body_rows.map((row) => element('tr', null, row.map((cell, column) => cellElementOf('td', cell, column))));
  const table = element('table', 'md-table', [element('thead', null, [header_row]), element('tbody', null, body_rows)]);
  return element('div', 'md-table-scroll', [table]);
}

function footnoteElementOf(block: BlockOf<'footnote_definition'>, context: ElementContext): HTMLElement {
  const number = context.document_index.footnote_numbers.get(block.label) ?? block.label;
  const label = element('a', 'md-footnote-label', [String(number)]);
  label.href = `#${ANCHOR_ID_PREFIX}fnref-${block.label}`;
  label.title = 'Back to the reference';
  const body = element('div', 'md-footnote-body', inlineNodesOf(block.children, context));
  const footnote = element('div', 'md-footnote', [label, body]);
  if (context.side === 'source') footnote.id = `${ANCHOR_ID_PREFIX}fn-${block.label}`;
  return footnote;
}

function linkDefinitionElementOf(block: BlockOf<'link_definition'>, context: ElementContext): HTMLElement {
  const target = linkTargetOf(block.destination, context.anchor_ids);
  let destination: Node = document.createTextNode(block.destination);
  if (target) destination = linkElementOf(target, block.title, [block.destination]);
  const label = element('span', 'md-link-definition-label', [block.label]);
  return element('div', 'md-link-definition', [label, destination]);
}

function linkElementOf(target: LinkTarget, title: string | null, children: (Node | string)[]): HTMLAnchorElement {
  const link = element('a', 'md-link', children);
  link.href = target.href;
  if (title) link.title = title;
  if (target.is_external) {
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  }
  return link;
}

type InlineOf<Kind extends InlineNode['kind']> = Extract<InlineNode, { kind: Kind }>;

function inlineNodesOf(nodes: InlineNode[], context: ElementContext): Node[] {
  return nodes.map((node) => inlineNodeOf(node, context));
}

function inlineNodeOf(node: InlineNode, context: ElementContext): Node {
  switch (node.kind) {
    case 'text':
      return document.createTextNode(node.text);
    case 'line_break':
      return document.createElement('br');
    case 'code':
      return element('code', 'md-code', [node.text]);
    case 'strong':
    case 'em':
    case 'del':
      return element(node.kind, null, inlineNodesOf(node.children, context));
    case 'footnote_ref':
      return footnoteRefElementOf(node, context);
    case 'image':
      return imageElementOf(node, context);
    case 'link':
    case 'autolink':
      return linkNodeOf(node, context);
  }
  throw new Error(`unknown inline kind ${(node as { kind: string }).kind}`);
}

function footnoteRefElementOf(node: InlineOf<'footnote_ref'>, context: ElementContext): HTMLElement {
  const number = context.document_index.footnote_numbers.get(node.label) ?? node.label;
  const link = element('a', null, [String(number)]);
  link.href = `#${ANCHOR_ID_PREFIX}fn-${node.label}`;
  // Only the first reference to a footnote carries the id its back link points to.
  const is_first_pair = context.document_index.footnote_first_pair.get(node.label) === context.pair_index;
  const is_first_reference = is_first_pair && !context.used_ids.has(node.label);
  if (context.side === 'source' && is_first_reference) link.id = `${ANCHOR_ID_PREFIX}fnref-${node.label}`;
  context.used_ids.add(node.label);
  return element('sup', 'md-footnote-ref', [link]);
}

// Remote images are never fetched: the URL is model output, and loading it would also reflow the row later. An
// image shows as a chip with its alt text, a link when its destination is allowed.
function imageElementOf(node: InlineOf<'image'>, context: ElementContext): HTMLElement {
  const target = linkTargetOf(node.destination, context.anchor_ids);
  const chip = [element('span', 'md-image-icon'), node.alt || 'image'];
  if (!target) return element('span', 'md-image', chip);
  const link = linkElementOf(target, node.title, chip);
  link.className = 'md-link md-image';
  return link;
}

function linkNodeOf(node: InlineOf<'link' | 'autolink'>, context: ElementContext): HTMLElement {
  const children = node.kind === 'autolink' ? [node.text] : inlineNodesOf(node.children, context);
  // A destination still arriving.
  if (node.destination === null) return element('span', 'md-link is-pending', children);
  const target = linkTargetOf(node.destination, context.anchor_ids);
  if (!target) {
    // Not clickable: the destination shows in a tooltip.
    const inert = element('span', 'md-link-inert', children);
    inert.title = node.destination;
    return inert;
  }
  const title = node.kind === 'link' ? node.title : null;
  return linkElementOf(target, title, children);
}
