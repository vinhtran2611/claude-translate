// The side-by-side pairs: one row per <pair> the model returned, a source cell and a translation cell, each rendered
// as Markdown as its text arrives.
import type { TranslatedBlock } from '../../../shared/api-types.ts';
import { documentIndexOf, parseCellBlocks, renderCellContent } from '../../../shared/web/markdown.ts';
import { ICONS, requiredElement } from '../../../shared/web/ui.ts';
import type { StreamEvent } from '../api-types.ts';
import { errorText, showAlert } from './alert.ts';
import { type PairSide, translationTextOf } from './pairs-markdown.ts';

// A pair on screen: what the model returned, plus the cells it renders into.
export interface ShownBlock extends TranslatedBlock {
  blockIndex: number;
  source_content: HTMLElement;
  translation_content: HTMLElement;
}

export type BlockEvent = Extract<StreamEvent, ['block_start' | 'source_delta' | 'translation_delta', unknown]>;
interface StreamingCell {
  pair: ShownBlock;
  side: PairSide;
}

export const pairs_view = requiredElement('#pairs-view', HTMLDivElement);

// One entry per <pair> the model returned, in order; written only by applyPairEvent.
let translation_pairs: ShownBlock[] = [];
// { pair, side } of the cell text is arriving in, or null. Written only by setStreamingCell.
let streaming_cell: StreamingCell | null = null;
// The cross-pair facts of the pairs on screen. Written only by refreshDocumentIndex.
let document_index = documentIndexOf([]);

// The pairs on screen, in order.
export function shownBlocks(): ShownBlock[] {
  return translation_pairs;
}

function refreshDocumentIndex() {
  document_index = documentIndexOf(translation_pairs);
}

// side: 'source' | 'translation'. Only the cell being streamed into renders provisionally; every other cell is final.
function renderPairCell(pair: ShownBlock, side: PairSide): void {
  const is_streaming = streaming_cell !== null && streaming_cell.pair === pair && streaming_cell.side === side;
  const text = side === 'source' ? pair.sourceText : translationTextOf(pair);
  const inline_options = { isStreaming: is_streaming, linkDefinitions: document_index.linkDefinitions };
  const blocks = parseCellBlocks(pair.blockType, pair.marker, pair.level, text, inline_options);
  const content_element = side === 'source' ? pair.source_content : pair.translation_content;
  const is_document_complete = streaming_cell === null;
  renderCellContent(content_element, blocks, { side, blockIndex: pair.blockIndex, documentIndex: document_index, isStreaming: is_streaming, isDocumentComplete: is_document_complete });
}

function renderPairCells(pair: ShownBlock): void {
  renderPairCell(pair, 'source');
  renderPairCell(pair, 'translation');
}

// The final render: every cell, strict, against the whole document's index (later definitions and headings resolve).
function renderAllPairCells(): void {
  refreshDocumentIndex();
  translation_pairs.forEach(renderPairCells);
}

const copy_reset_timers = new WeakMap();

// button: holds one copy icon <svg>, plus a .copy-label span if it shows text.
export async function copyWithFeedback(button: HTMLElement, text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch (error) {
    showAlert({ severity: 'error', title: 'Could not copy', detail: errorText(error) });
    return;
  }
  const label = button.querySelector('.copy-label');
  requiredElement('svg', SVGSVGElement, button).outerHTML = ICONS.check;
  if (label) label.textContent = 'Copied';
  button.classList.add('is-done');
  // One pending reset per button: a second click restarts it instead of being cut short by the first.
  clearTimeout(copy_reset_timers.get(button));
  copy_reset_timers.set(button, setTimeout(() => {
    requiredElement('svg', SVGSVGElement, button).outerHTML = ICONS.copy;
    if (label) label.textContent = 'Copy';
    button.classList.remove('is-done');
  }, 1400));
}

// getCellText is read at click time, so the button copies the cell's text as it is then, not when it was built.
function createPairCell(cell_classes: string[], copy_label: string, getCellText: () => string): { cell: HTMLDivElement; content: HTMLDivElement } {
  const cell = document.createElement('div');
  cell.className = cell_classes.join(' ');
  const content = document.createElement('div');
  content.className = 'pair-content';
  const copy_button = document.createElement('button');
  copy_button.className = 'cell-copy-button';
  copy_button.title = copy_label;
  copy_button.setAttribute('aria-label', copy_label);
  copy_button.innerHTML = ICONS.copy;
  copy_button.addEventListener('click', () => copyWithFeedback(copy_button, getCellText()));
  cell.append(content, copy_button);
  return { cell, content };
}

// next: { pair, side } | null. The cell it replaces is rendered again as final; null means the stream ended, so
// every cell gets its final render.
export function setStreamingCell(next: StreamingCell | null): void {
  const released = streaming_cell;
  streaming_cell = next;
  if (next === null) {
    renderAllPairCells();
  } else if (released !== null && released.pair !== next.pair) {
    // Refreshed when a pair completes, not per delta: a refresh walks every pair.
    refreshDocumentIndex();
    renderPairCells(released.pair);
  } else if (released !== null && released.side !== next.side) {
    renderPairCell(released.pair, released.side);
  }
}

export function resetPairs(): void {
  translation_pairs = [];
  setStreamingCell(null);
  pairs_view.innerHTML = '';
}

export function isBlockEvent(stream_event: StreamEvent): stream_event is BlockEvent {
  return stream_event[0] === 'block_start' || stream_event[0] === 'source_delta' || stream_event[0] === 'translation_delta';
}

export function applyBlockEvent([event_name, data]: BlockEvent): void {
  if (event_name === 'block_start') {
    const cell_classes = [`type-${data.blockType}`, `level-${data.level}`];
    if (data.blockIndex === 0) cell_classes.push('is-first');
    const pair = { ...data, sourceText: '', translatedText: '' };
    const source = createPairCell(['pair-cell', 'source', ...cell_classes], 'Copy source', () => pair.sourceText);
    const translation = createPairCell(['pair-cell', 'translation', ...cell_classes], 'Copy translation', () => translationTextOf(pair));
    const indent_level = String(Math.max(1, data.level));
    source.cell.style.setProperty('--level', indent_level);
    translation.cell.style.setProperty('--level', indent_level);
    // display: contents on screen; print turns each row into one unbreakable block.
    const row = document.createElement('div');
    row.className = 'pair-row';
    row.append(source.cell, translation.cell);
    pairs_view.append(row);
    translation_pairs[data.blockIndex] = Object.assign(pair, { source_content: source.content, translation_content: translation.content });
    return;
  }
  const pair = translation_pairs[data.blockIndex];
  if (!pair) return;
  const side = event_name === 'source_delta' ? 'source' : 'translation';
  if (side === 'source') pair.sourceText += data.text;
  else pair.translatedText += data.text;
  setStreamingCell({ pair, side });
  // Only the cell whose text changed: rebuilding the other side's DOM per delta loses its selection and clicks.
  renderPairCell(pair, side);
}

// Replays stored blocks ({ blockType, level, marker, sourceText, translatedText }) through applyBlockEvent,
// the same path a live translation takes. Used by Undo after Clear and by opening a history entry.
export function renderStoredBlocks(pairs: TranslatedBlock[]): void {
  resetPairs();
  pairs.forEach((pair, pair_index) => {
    applyBlockEvent(['block_start', { blockIndex: pair_index, blockType: pair.blockType, level: pair.level, marker: pair.marker }]);
    applyBlockEvent(['source_delta', { blockIndex: pair_index, text: pair.sourceText }]);
    applyBlockEvent(['translation_delta', { blockIndex: pair_index, text: pair.translatedText }]);
  });
  setStreamingCell(null);
}
