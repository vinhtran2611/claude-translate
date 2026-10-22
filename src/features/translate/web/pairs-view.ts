// The side-by-side pairs: one row per <pair> the model returned, a source cell and a translation cell, each rendered
// as Markdown as its text arrives.
import type { TranslatedBlock } from '../../../shared/api-types.ts';
import { documentIndexOf, parseCellBlocks, renderCellContent } from '../../../shared/web/markdown.ts';
import { ICONS, requiredElement } from '../../../shared/web/ui.ts';
import type { StreamEvent } from '../api-types.ts';
import { errorText, showAlert } from './alert.ts';
import { type PairSide, translationTextOf } from './pairs-markdown.ts';

// A pair on screen: what the model returned, plus the cells it renders into.
interface ShownBlock extends TranslatedBlock {
  blockIndex: number;
  sourceContent: HTMLElement;
  translationContent: HTMLElement;
}

type BlockEvent = Extract<StreamEvent, ['block_start' | 'source_delta' | 'translation_delta', unknown]>;
interface StreamingCell {
  pair: ShownBlock;
  side: PairSide;
}

export const pairsView = requiredElement('#pairs-view', HTMLDivElement);

// One entry per <pair> the model returned, in order; written only by applyPairEvent.
let translationPairs: ShownBlock[] = [];
// { pair, side } of the cell text is arriving in, or null. Written only by setStreamingCell.
let streamingCell: StreamingCell | null = null;
// The cross-pair facts of the pairs on screen. Written only by refreshDocumentIndex.
let documentIndex = documentIndexOf([]);

// The pairs on screen, in order.
export function shownBlocks(): ShownBlock[] {
  return translationPairs;
}

function refreshDocumentIndex() {
  documentIndex = documentIndexOf(translationPairs);
}

// side: 'source' | 'translation'. Only the cell being streamed into renders provisionally; every other cell is final.
function renderPairCell(pair: ShownBlock, side: PairSide): void {
  const isStreaming = streamingCell !== null && streamingCell.pair === pair && streamingCell.side === side;
  const text = side === 'source' ? pair.sourceText : translationTextOf(pair);
  const inlineOptions = { isStreaming, linkDefinitions: documentIndex.linkDefinitions };
  const blocks = parseCellBlocks(pair.blockType, pair.marker, pair.level, text, inlineOptions);
  const contentElement = side === 'source' ? pair.sourceContent : pair.translationContent;
  const isDocumentComplete = streamingCell === null;
  renderCellContent(contentElement, blocks, { side, blockIndex: pair.blockIndex, documentIndex, isStreaming, isDocumentComplete });
}

function renderPairCells(pair: ShownBlock): void {
  renderPairCell(pair, 'source');
  renderPairCell(pair, 'translation');
}

// The final render: every cell, strict, against the whole document's index (later definitions and headings resolve).
function renderAllPairCells(): void {
  refreshDocumentIndex();
  translationPairs.forEach(renderPairCells);
}

const copyResetTimers = new WeakMap();

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
  clearTimeout(copyResetTimers.get(button));
  copyResetTimers.set(button, setTimeout(() => {
    requiredElement('svg', SVGSVGElement, button).outerHTML = ICONS.copy;
    if (label) label.textContent = 'Copy';
    button.classList.remove('is-done');
  }, 1400));
}

// getCellText is read at click time, so the button copies the cell's text as it is then, not when it was built.
function createPairCell(cellClasses: string[], copyLabel: string, getCellText: () => string): { cell: HTMLDivElement; content: HTMLDivElement } {
  const cell = document.createElement('div');
  cell.className = cellClasses.join(' ');
  const content = document.createElement('div');
  content.className = 'pair-content';
  const copyButton = document.createElement('button');
  copyButton.className = 'cell-copy-button';
  copyButton.title = copyLabel;
  copyButton.setAttribute('aria-label', copyLabel);
  copyButton.innerHTML = ICONS.copy;
  copyButton.addEventListener('click', () => copyWithFeedback(copyButton, getCellText()));
  cell.append(content, copyButton);
  return { cell, content };
}

// next: { pair, side } | null. The cell it replaces is rendered again as final; null means the stream ended, so
// every cell gets its final render.
export function setStreamingCell(next: StreamingCell | null): void {
  const released = streamingCell;
  streamingCell = next;
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
  translationPairs = [];
  setStreamingCell(null);
  pairsView.innerHTML = '';
}

export function isBlockEvent(streamEvent: StreamEvent): streamEvent is BlockEvent {
  return streamEvent[0] === 'block_start' || streamEvent[0] === 'source_delta' || streamEvent[0] === 'translation_delta';
}

export function applyBlockEvent([eventName, data]: BlockEvent): void {
  if (eventName === 'block_start') {
    const cellClasses = [`type-${data.blockType}`, `level-${data.level}`];
    if (data.blockIndex === 0) cellClasses.push('is-first');
    const pair = { ...data, sourceText: '', translatedText: '' };
    const source = createPairCell(['pair-cell', 'source', ...cellClasses], 'Copy source', () => pair.sourceText);
    const translation = createPairCell(['pair-cell', 'translation', ...cellClasses], 'Copy translation', () => translationTextOf(pair));
    const indentLevel = String(Math.max(1, data.level));
    source.cell.style.setProperty('--level', indentLevel);
    translation.cell.style.setProperty('--level', indentLevel);
    // display: contents on screen; print turns each row into one unbreakable block.
    const row = document.createElement('div');
    row.className = 'pair-row';
    row.append(source.cell, translation.cell);
    pairsView.append(row);
    translationPairs[data.blockIndex] = Object.assign(pair, { sourceContent: source.content, translationContent: translation.content });
    return;
  }
  const pair = translationPairs[data.blockIndex];
  if (!pair) return;
  const side = eventName === 'source_delta' ? 'source' : 'translation';
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
  pairs.forEach((pair, pairIndex) => {
    applyBlockEvent(['block_start', { blockIndex: pairIndex, blockType: pair.blockType, level: pair.level, marker: pair.marker }]);
    applyBlockEvent(['source_delta', { blockIndex: pairIndex, text: pair.sourceText }]);
    applyBlockEvent(['translation_delta', { blockIndex: pairIndex, text: pair.translatedText }]);
  });
  setStreamingCell(null);
}
