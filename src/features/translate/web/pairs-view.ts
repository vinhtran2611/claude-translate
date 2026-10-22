// The side-by-side pairs: one row per <pair> the model returned, a source cell and a translation cell, each rendered
// as Markdown as its text arrives.
import type { Pair } from '../../../shared/api-types.ts';
import { documentIndexOf, parseCellBlocks, renderCellContent } from '../../../shared/web/markdown.ts';
import { ICONS, requiredElement } from '../../../shared/web/ui.ts';
import type { StreamEvent } from '../api-types.ts';
import { errorText, showAlert } from './alert.ts';
import { type PairSide, translationTextOf } from './pairs-markdown.ts';

// A pair on screen: what the model returned, plus the cells it renders into.
export interface ShownPair extends Pair {
  pair_index: number;
  source_content: HTMLElement;
  translation_content: HTMLElement;
}

export type PairEvent = Extract<StreamEvent, ['pair_start' | 'source_delta' | 'translation_delta', unknown]>;
interface StreamingCell {
  pair: ShownPair;
  side: PairSide;
}

export const pairs_view = requiredElement('#pairs-view', HTMLDivElement);

// One entry per <pair> the model returned, in order; written only by applyPairEvent.
let translation_pairs: ShownPair[] = [];
// { pair, side } of the cell text is arriving in, or null. Written only by setStreamingCell.
let streaming_cell: StreamingCell | null = null;
// The cross-pair facts of the pairs on screen. Written only by refreshDocumentIndex.
let document_index = documentIndexOf([]);

// The pairs on screen, in order.
export function shownPairs(): ShownPair[] {
  return translation_pairs;
}

function refreshDocumentIndex() {
  document_index = documentIndexOf(translation_pairs);
}

// side: 'source' | 'translation'. Only the cell being streamed into renders provisionally; every other cell is final.
function renderPairCell(pair: ShownPair, side: PairSide): void {
  const is_streaming = streaming_cell !== null && streaming_cell.pair === pair && streaming_cell.side === side;
  const text = side === 'source' ? pair.source_text : translationTextOf(pair);
  const inline_options = { is_streaming, link_definitions: document_index.link_definitions };
  const blocks = parseCellBlocks(pair.pair_type, pair.marker, pair.level, text, inline_options);
  const content_element = side === 'source' ? pair.source_content : pair.translation_content;
  const is_document_complete = streaming_cell === null;
  renderCellContent(content_element, blocks, { side, pair_index: pair.pair_index, document_index, is_streaming, is_document_complete });
}

function renderPairCells(pair: ShownPair): void {
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

export function isPairEvent(stream_event: StreamEvent): stream_event is PairEvent {
  return stream_event[0] === 'pair_start' || stream_event[0] === 'source_delta' || stream_event[0] === 'translation_delta';
}

export function applyPairEvent([event_name, data]: PairEvent): void {
  if (event_name === 'pair_start') {
    const cell_classes = [`type-${data.pair_type}`, `level-${data.level}`];
    if (data.pair_index === 0) cell_classes.push('is-first');
    const pair = { ...data, source_text: '', translation_text: '' };
    const source = createPairCell(['pair-cell', 'source', ...cell_classes], 'Copy source', () => pair.source_text);
    const translation = createPairCell(['pair-cell', 'translation', ...cell_classes], 'Copy translation', () => translationTextOf(pair));
    const indent_level = String(Math.max(1, data.level));
    source.cell.style.setProperty('--level', indent_level);
    translation.cell.style.setProperty('--level', indent_level);
    // display: contents on screen; print turns each row into one unbreakable block.
    const row = document.createElement('div');
    row.className = 'pair-row';
    row.append(source.cell, translation.cell);
    pairs_view.append(row);
    translation_pairs[data.pair_index] = Object.assign(pair, { source_content: source.content, translation_content: translation.content });
    return;
  }
  const pair = translation_pairs[data.pair_index];
  if (!pair) return;
  const side = event_name === 'source_delta' ? 'source' : 'translation';
  if (side === 'source') pair.source_text += data.text;
  else pair.translation_text += data.text;
  setStreamingCell({ pair, side });
  // Only the cell whose text changed: rebuilding the other side's DOM per delta loses its selection and clicks.
  renderPairCell(pair, side);
}

// Replays stored pairs ({ pair_type, level, marker, source_text, translation_text }) through applyPairEvent,
// the same path a live translation takes. Used by Undo after Clear and by opening a history entry.
export function renderStoredPairs(pairs: Pair[]): void {
  resetPairs();
  pairs.forEach((pair, pair_index) => {
    applyPairEvent(['pair_start', { pair_index, pair_type: pair.pair_type, level: pair.level, marker: pair.marker }]);
    applyPairEvent(['source_delta', { pair_index, text: pair.source_text }]);
    applyPairEvent(['translation_delta', { pair_index, text: pair.translation_text }]);
  });
  setStreamingCell(null);
}
