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
  const render_context: ElementContext = {
    ...context, anchor_ids: context.is_document_complete ? context.document_index.anchor_ids : null, used_ids: new Set(),
  };
  content_element.replaceChildren(...blocks.map((block) => blockElementOf(block, render_context)));
  if (context.is_streaming) caretContainerOf(content_element)?.append(element('span', 'md-caret'));
}

// Draws a whole document (see parseDocumentBlocks) into content_element: the same elements and classes as a translated cell.
// is_streaming: the text is still arriving, so its end is provisional and a caret follows it.
export function renderDocument(content_element: HTMLElement, text: string, is_streaming = false): void {
  renderCellContent(content_element, parseDocumentBlocks(text, is_streaming),
    { side: 'translation', pair_index: -1, document_index: documentIndexOf([]), is_streaming, is_document_complete: true });
}

// The innermost last element that holds text, so the caret sits after the last character, not on a line of its own.
// null when the cell holds blocks but none with text (a rule): a caret after them would add a line that vanishes later.
function caretContainerOf(content_element: Element): Element | null {
  let container = content_element;
  while (true) {
    const last = [...container.children].filter((child) => child.textContent.trim() !== '').at(-1);
    if (!last && container === content_element && content_element.children.length > 0) return null;
    if (!last || last.matches('a, span, strong, em, del, code, sup, sub, kbd, mark, s, ins, u, small')) return container;
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

function element<Tag extends keyof HTMLElementTagNameMap>(
  tag_name: Tag, class_name: string | null, children: (Node | string)[] = [],
): HTMLElementTagNameMap[Tag] {
  const node = document.createElement(tag_name);
  if (class_name) node.className = class_name;
  node.append(...children);
  return node;
}

function blockElementOf(block: Block, context: ElementContext): HTMLElement {
  if (block.kind === 'paragraph') return element('p', 'md-p', inlineNodesOf(block.children, context));
  if (block.kind === 'heading') {
    const heading = element(HEADING_TAGS[block.level - 1], `md-heading md-h${block.level}`, inlineNodesOf(block.children, context));
    const slug = context.document_index.heading_slugs.get(context.pair_index);
    if (context.side === 'source' && slug !== undefined) heading.id = `${ANCHOR_ID_PREFIX}${slug}`;
    return heading;
  }
  if (block.kind === 'thematic_break') return element('hr', 'md-hr');
  if (block.kind === 'code_block') {
    const code_block = element('div', 'md-code-block');
    if (block.language) code_block.append(element('div', 'md-code-language', [block.language]));
    code_block.append(element('pre', null, [element('code', null, [block.text])]));
    return code_block;
  }
  if (block.kind === 'quote') return element('blockquote', 'md-quote', block.blocks.map((inner) => blockElementOf(inner, context)));
  if (block.kind === 'list') {
    const items = block.items.map((item_blocks) => element('li', null, item_blocks.map((inner) => blockElementOf(inner, context))));
    if (!block.is_ordered) return element('ul', 'md-list', items);
    const list = element('ol', 'md-list', items);
    if (block.start !== null && block.start !== 1) list.start = block.start;
    return list;
  }
  if (block.kind === 'list_item') {
    const marker = element('span', `md-marker is-${block.marker.kind}`, block.marker.kind === 'task' ? [] : [block.marker.text]);
    marker.setAttribute('aria-hidden', 'true');
    if (block.marker.kind === 'task') marker.classList.toggle('is-checked', block.marker.is_checked);
    const item = element('div', 'md-list-item', [marker, element('div', 'md-list-body', block.blocks.map((inner) => blockElementOf(inner, context)))]);
    return item;
  }
  if (block.kind === 'table') {
    const alignOf = (cell_element: HTMLTableCellElement, column: number): HTMLTableCellElement => { if (block.alignments[column]) cell_element.style.textAlign = block.alignments[column]; return cell_element; };
    const head = element('thead', null, [element('tr', null, block.header_cells.map((cell, column) => alignOf(element('th', null, inlineNodesOf(cell, context)), column)))]);
    const body = element('tbody', null, block.body_rows.map((row) => element('tr', null, row.map((cell, column) => alignOf(element('td', null, inlineNodesOf(cell, context)), column)))));
    return element('div', 'md-table-scroll', [element('table', 'md-table', [head, body])]);
  }
  if (block.kind === 'footnote_definition') {
    const number = context.document_index.footnote_numbers.get(block.label) ?? block.label;
    const label = element('a', 'md-footnote-label', [String(number)]);
    label.href = `#${ANCHOR_ID_PREFIX}fnref-${block.label}`;
    label.title = 'Back to the reference';
    const footnote = element('div', 'md-footnote', [label, element('div', 'md-footnote-body', inlineNodesOf(block.children, context))]);
    if (context.side === 'source') footnote.id = `${ANCHOR_ID_PREFIX}fn-${block.label}`;
    return footnote;
  }
  if (block.kind === 'link_definition') {
    const target = linkTargetOf(block.destination, context.anchor_ids);
    const destination = target ? linkElementOf(target, block.title, [block.destination]) : document.createTextNode(block.destination);
    return element('div', 'md-link-definition', [element('span', 'md-link-definition-label', [block.label]), destination]);
  }
  throw new Error(`unknown block kind ${(block as { kind: string }).kind}`);
}

function linkElementOf(target: LinkTarget, title: string | null, children: (Node | string)[]): HTMLAnchorElement {
  const link = element('a', 'md-link', children);
  link.href = target.href;
  if (title) link.title = title;
  if (target.is_external) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
  return link;
}

function inlineNodesOf(nodes: InlineNode[], context: ElementContext): Node[] {
  return nodes.map((node): Node => {
    if (node.kind === 'text') return document.createTextNode(node.text);
    if (node.kind === 'line_break') return document.createElement('br');
    if (node.kind === 'code') return element('code', 'md-code', [node.text]);
    if (node.kind === 'strong' || node.kind === 'em' || node.kind === 'del') return element(node.kind, null, inlineNodesOf(node.children, context));
    if (node.kind === 'footnote_ref') {
      const number = context.document_index.footnote_numbers.get(node.label) ?? node.label;
      const link = element('a', null, [String(number)]);
      link.href = `#${ANCHOR_ID_PREFIX}fn-${node.label}`;
      const is_first_reference = context.document_index.footnote_first_pair.get(node.label) === context.pair_index && !context.used_ids.has(node.label);
      if (context.side === 'source' && is_first_reference) link.id = `${ANCHOR_ID_PREFIX}fnref-${node.label}`;
      context.used_ids.add(node.label);
      return element('sup', 'md-footnote-ref', [link]);
    }
    if (node.kind === 'image') {
      // Remote images are never fetched: the URL is model output, and loading it would also reflow the row later.
      const target = linkTargetOf(node.destination, context.anchor_ids);
      const chip = [element('span', 'md-image-icon'), node.alt || 'image'];
      return target ? Object.assign(linkElementOf(target, node.title, chip), { className: 'md-link md-image' }) : element('span', 'md-image', chip);
    }
    if (node.kind === 'link' || node.kind === 'autolink') {
      const children = node.kind === 'autolink' ? [node.text] : inlineNodesOf(node.children, context);
      if (node.destination === null) return element('span', 'md-link is-pending', children);
      const target = linkTargetOf(node.destination, context.anchor_ids);
      if (!target) {
        const inert = element('span', 'md-link-inert', children);
        inert.title = node.destination;
        return inert;
      }
      return linkElementOf(target, node.kind === 'link' ? node.title : null, children);
    }
    throw new Error(`unknown inline kind ${(node as { kind: string }).kind}`);
  });
}
