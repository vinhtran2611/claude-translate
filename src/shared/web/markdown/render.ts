// The DOM: the only writer.
import type { Block } from './blocks.ts';
import { parseDocumentBlocks } from './document.ts';
import { type DocumentIndex, documentIndexOf } from './document-index.ts';
import type { InlineNode } from './inline.ts';
import { ANCHOR_ID_PREFIX, type LinkTarget, linkTargetOf } from './links.ts';

export interface RenderContext {
  side: 'source' | 'translation';
  blockIndex: number;
  documentIndex: DocumentIndex;
  isStreaming: boolean;
  isDocumentComplete: boolean;
}

// context: { side: 'source' | 'translation', blockIndex, documentIndex, isStreaming, isDocumentComplete }.
// Ids go on the source side only, so they stay unique; a translation-side link to "#x" scrolls to the same row.
// A streaming cell ends in a caret. "#x" links are checked only once the document is complete: until then the
// heading a table of contents points to may simply not have arrived.
export function renderCellContent(contentElement: HTMLElement, blocks: Block[], context: RenderContext): void {
  const anchorIds = context.isDocumentComplete ? context.documentIndex.anchorIds : null;
  const renderContext: ElementContext = { ...context, anchorIds, usedIds: new Set() };
  contentElement.replaceChildren(...blocks.map((block) => blockElementOf(block, renderContext)));
  if (context.isStreaming) caretContainerOf(contentElement)?.append(element('span', 'md-caret'));
}

// Draws a whole document (see parseDocumentBlocks) into contentElement: the same elements and classes as a translated cell.
// isStreaming: the text is still arriving, so its end is provisional and a caret follows it.
export function renderDocument(contentElement: HTMLElement, text: string, isStreaming = false): void {
  const blocks = parseDocumentBlocks(text, isStreaming);
  const context: RenderContext = {
    side: 'translation',
    blockIndex: -1,
    documentIndex: documentIndexOf([]),
    isStreaming,
    isDocumentComplete: true,
  };
  renderCellContent(contentElement, blocks, context);
}

// The innermost last element that holds text, so the caret sits after the last character, not on a line of its own.
// null when the cell holds blocks but none with text (a rule): a caret after them would add a line that vanishes later.
function caretContainerOf(contentElement: Element): Element | null {
  let container = contentElement;
  while (true) {
    const last = [...container.children].filter((child) => child.textContent.trim() !== '').at(-1);
    if (!last && container === contentElement && contentElement.children.length > 0) return null;
    if (!last || last.matches(INLINE_ELEMENTS)) return container;
    if (last.matches('.md-code-block')) return last.querySelector('code');
    container = last;
  }
}

// anchorIds: null while "#x" links cannot be checked yet. usedIds: footnote ids this cell already carries.
interface ElementContext extends RenderContext {
  anchorIds: Set<string> | null;
  usedIds: Set<string>;
}

const HEADING_TAGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const;
// Elements that hold text inline; the caret goes inside the last of them, not after it.
const INLINE_ELEMENTS = 'a, span, strong, em, del, code, sup, sub, kbd, mark, s, ins, u, small';

function element<Tag extends keyof HTMLElementTagNameMap>(
  tagName: Tag, className: string | null, children: (Node | string)[] = [],
): HTMLElementTagNameMap[Tag] {
  const node = document.createElement(tagName);
  if (className) node.className = className;
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
  const tagName = HEADING_TAGS[block.level - 1];
  const heading = element(tagName, `md-heading md-h${block.level}`, inlineNodesOf(block.children, context));
  const slug = context.documentIndex.headingSlugs.get(context.blockIndex);
  if (context.side === 'source' && slug !== undefined) heading.id = `${ANCHOR_ID_PREFIX}${slug}`;
  return heading;
}

function codeBlockElementOf(block: BlockOf<'code_block'>): HTMLElement {
  const codeBlock = element('div', 'md-code-block');
  if (block.language) codeBlock.append(element('div', 'md-code-language', [block.language]));
  codeBlock.append(element('pre', null, [element('code', null, [block.text])]));
  return codeBlock;
}

function listElementOf(block: BlockOf<'list'>, context: ElementContext): HTMLElement {
  const items = block.items.map((itemBlocks) => element('li', null, blockElementsOf(itemBlocks, context)));
  if (!block.isOrdered) return element('ul', 'md-list', items);
  const list = element('ol', 'md-list', items);
  if (block.start !== null && block.start !== 1) list.start = block.start;
  return list;
}

function listItemElementOf(block: BlockOf<'list_item'>, context: ElementContext): HTMLElement {
  const isTask = block.marker.kind === 'task';
  // A task's box is drawn by CSS, so its marker holds no text.
  const marker = element('span', `md-marker is-${block.marker.kind}`, isTask ? [] : [block.marker.text]);
  marker.setAttribute('aria-hidden', 'true');
  if (isTask) marker.classList.toggle('is-checked', block.marker.isChecked);
  const body = element('div', 'md-list-body', blockElementsOf(block.blocks, context));
  return element('div', 'md-list-item', [marker, body]);
}

function tableElementOf(block: BlockOf<'table'>, context: ElementContext): HTMLElement {
  const cellElementOf = (tagName: 'th' | 'td', cell: InlineNode[], column: number): HTMLTableCellElement => {
    const cellElement = element(tagName, null, inlineNodesOf(cell, context));
    const alignment = block.alignments[column];
    if (alignment) cellElement.style.textAlign = alignment;
    return cellElement;
  };
  const headerRow = element('tr', null, block.headerCells.map((cell, column) => cellElementOf('th', cell, column)));
  const bodyRows = block.bodyRows.map((row) => element('tr', null, row.map((cell, column) => cellElementOf('td', cell, column))));
  const table = element('table', 'md-table', [element('thead', null, [headerRow]), element('tbody', null, bodyRows)]);
  return element('div', 'md-table-scroll', [table]);
}

function footnoteElementOf(block: BlockOf<'footnote_definition'>, context: ElementContext): HTMLElement {
  const number = context.documentIndex.footnoteNumbers.get(block.label) ?? block.label;
  const label = element('a', 'md-footnote-label', [String(number)]);
  label.href = `#${ANCHOR_ID_PREFIX}fnref-${block.label}`;
  label.title = 'Back to the reference';
  const body = element('div', 'md-footnote-body', inlineNodesOf(block.children, context));
  const footnote = element('div', 'md-footnote', [label, body]);
  if (context.side === 'source') footnote.id = `${ANCHOR_ID_PREFIX}fn-${block.label}`;
  return footnote;
}

function linkDefinitionElementOf(block: BlockOf<'link_definition'>, context: ElementContext): HTMLElement {
  const target = linkTargetOf(block.destination, context.anchorIds);
  let destination: Node = document.createTextNode(block.destination);
  if (target) destination = linkElementOf(target, block.title, [block.destination]);
  const label = element('span', 'md-link-definition-label', [block.label]);
  return element('div', 'md-link-definition', [label, destination]);
}

function linkElementOf(target: LinkTarget, title: string | null, children: (Node | string)[]): HTMLAnchorElement {
  const link = element('a', 'md-link', children);
  link.href = target.href;
  if (title) link.title = title;
  if (target.isExternal) {
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
  const number = context.documentIndex.footnoteNumbers.get(node.label) ?? node.label;
  const link = element('a', null, [String(number)]);
  link.href = `#${ANCHOR_ID_PREFIX}fn-${node.label}`;
  // Only the first reference to a footnote carries the id its back link points to.
  const isFirstPair = context.documentIndex.footnoteFirstPair.get(node.label) === context.blockIndex;
  const isFirstReference = isFirstPair && !context.usedIds.has(node.label);
  if (context.side === 'source' && isFirstReference) link.id = `${ANCHOR_ID_PREFIX}fnref-${node.label}`;
  context.usedIds.add(node.label);
  return element('sup', 'md-footnote-ref', [link]);
}

// Remote images are never fetched: the URL is model output, and loading it would also reflow the row later. An
// image shows as a chip with its alt text, a link when its destination is allowed.
function imageElementOf(node: InlineOf<'image'>, context: ElementContext): HTMLElement {
  const target = linkTargetOf(node.destination, context.anchorIds);
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
  const target = linkTargetOf(node.destination, context.anchorIds);
  if (!target) {
    // Not clickable: the destination shows in a tooltip.
    const inert = element('span', 'md-link-inert', children);
    inert.title = node.destination;
    return inert;
  }
  const title = node.kind === 'link' ? node.title : null;
  return linkElementOf(target, title, children);
}
