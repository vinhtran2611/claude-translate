// The page: the text box, the side-by-side pairs and the history sidebar. Loaded by translate.html; the server strips
// its types as it serves it. The settings menus live in settings-menus.ts.
import { documentIndexOf, parseCellBlocks, parseInline, plainTextOf, renderCellContent } from '../../../shared/web/markdown.ts';
import { foldForSearch, historyGroupOf, ICONS, readStored, requiredElement, writeStored } from '../../../shared/web/ui.ts';
import type { HistoryEntry, HistorySummary, Language, Mode, Outcome, Pair, StreamEvent } from '../../../shared/api.ts';
import { alertForError, type PageErrorKind } from './alert-text.ts';
import { detectSourceLanguage } from './detect-language.ts';
import { fetchJson } from './fetch-json.ts';
import { composePairsMarkdown, type PairSide, translationTextOf } from './pairs-markdown.ts';
import {
  arrowTargetOf, choiceLabelOf, closeSettingsMenus, loadTranslationOptions, modeNoteOf, modelLabelOf, openSettingsMenu,
  refreshQuotaWarning, toggleModelMenu, translationSettings,
} from './settings-menus.ts';
import { findSourceDivergence, type SourceDivergence } from './source-check.ts';
import { readStreamEvents } from './stream-events.ts';

// A pair on screen: what the model returned, plus the cells it renders into.
interface ShownPair extends Pair {
  pair_index: number;
  source_content: HTMLElement;
  translation_content: HTMLElement;
}

type PairEvent = Extract<StreamEvent, ['pair_start' | 'source_delta' | 'translation_delta', unknown]>;
type TargetState = 'empty' | 'waiting' | 'streaming' | 'done' | 'error';
// 'edit' shows the textarea and a plain translation; 'pairs' shows the side-by-side pairs.
type ViewMode = 'edit' | 'pairs';
interface StreamingCell {
  pair: ShownPair;
  side: PairSide;
}

interface AlertAction {
  label: string;
  run: () => void;
}

// Everything Undo needs to put the workspace back.
interface WorkspaceSnapshot {
  source_text: string;
  pairs: Pair[];
  plain_target_text: string;
  target_state: TargetState;
  run_info: string;
  view_mode: ViewMode;
  result_mode: Mode | null;
  thinking_text: string;
  thinking_duration_ms: number | null;
}

// The facts the end-of-run status line is worded from; a failed or cancelled run has only the first two.
interface RunInfo {
  outcome: Outcome;
  has_output: boolean;
  duration_ms?: number;
  served_model_id?: string;
  effort?: string;
  mode?: Mode;
  is_fallback?: boolean;
  is_from_history?: boolean;
}

const LANGUAGE_LABELS: Record<Language, string> = { en: 'English', vi: 'Vietnamese' };
const MAX_TEXT_CHARS = 100_000;
const CHAR_COUNT_VISIBLE_FROM = 16000;
// One placeholder bar per ~70 source chars, roughly one rendered line at 16px in a 1280px layout.
const CHARS_PER_SKELETON_BAR = 70;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const source_text = requiredElement('#source-text', HTMLTextAreaElement);
const target_text = requiredElement('#target-text', HTMLDivElement);
const target_pane = requiredElement('#target-pane', HTMLElement);
const skeleton = requiredElement('#skeleton', HTMLDivElement);
const source_language_name = requiredElement('#source-language-name', HTMLSpanElement);
const target_language_name = requiredElement('#target-language-name', HTMLSpanElement);
const detected_hint = requiredElement('#detected-hint', HTMLSpanElement);
const swap_button = requiredElement('#swap-button', HTMLButtonElement);
const clear_button = requiredElement('#clear-button', HTMLButtonElement);
const translate_button = requiredElement('#translate-button', HTMLButtonElement);
const copy_button = requiredElement('#copy-button', HTMLButtonElement);
const copy_source_button = requiredElement('#copy-source-button', HTMLButtonElement);
const char_count = requiredElement('#char-count', HTMLSpanElement);
const run_info = requiredElement('#run-info', HTMLSpanElement);
const run_activity = requiredElement('#run-activity', SVGSVGElement);
const direction_bar = requiredElement('#direction-bar', HTMLDivElement);
const panes = requiredElement('.panes', HTMLDivElement);
const pairs_view = requiredElement('#pairs-view', HTMLDivElement);
const edit_button = requiredElement('#edit-button', HTMLButtonElement);
const undo_clear_button = requiredElement('#undo-clear-button', HTMLButtonElement);
const has_escape_key = !matchMedia('(pointer: coarse)').matches;

let source_language: Language = readStored('source_language') === 'vi' ? 'vi' : 'en';
let is_direction_auto = true;
let active_request: AbortController | null = null;
let current_target_state: TargetState = 'empty';
// One entry per <pair> the model returned, in order; written only by applyPairEvent.
let translation_pairs: ShownPair[] = [];
// { pair, side } of the cell text is arriving in, or null. Written only by setStreamingCell.
let streaming_cell: StreamingCell | null = null;
// What the last Clear removed; null once the user types something else or translates again.
let cleared_snapshot: WorkspaceSnapshot | null = null;
const thinking_block = requiredElement('#thinking', HTMLDetailsElement);
const thinking_label = requiredElement('#thinking-label', HTMLSpanElement);
const thinking_body = requiredElement('#thinking-text', HTMLDivElement);
// The mode the result on screen ran in; null when there is none. Written by translate, showHistoryEntry and
// restoreClearedTranslation.
let shown_result_mode: Mode | null = null;
// The thinking summary of the result on screen; '' when there is none. Written only by setThinking.
let thinking_text = '';
// null while the summary is still arriving. Written only by setThinking.
let thinking_duration_ms: number | null = null;

// The cross-pair facts of the pairs on screen. Written only by refreshDocumentIndex.
let document_index = documentIndexOf([]);

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
async function copyWithFeedback(button: HTMLElement, text: string): Promise<void> {
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
function setStreamingCell(next: StreamingCell | null): void {
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

// text '' hides the block; duration_ms null shows it as still thinking.
function setThinking(text: string, duration_ms: number | null, is_open: boolean): void {
  thinking_text = text;
  thinking_duration_ms = duration_ms;
  const is_live = text !== '' && duration_ms === null;
  thinking_block.hidden = text === '';
  thinking_block.open = is_open;
  thinking_block.classList.toggle('is-live', is_live);
  thinking_label.textContent = thinkingLabelOf(text, duration_ms);
  const blocks = parseCellBlocks('paragraph', '', 0, text.trim(), { is_streaming: false, link_definitions: new Map() });
  renderCellContent(thinking_body, blocks, {
    side: 'translation',
    pair_index: -1,
    document_index: documentIndexOf([]),
    is_streaming: false,
    is_document_complete: true,
  });
}

// "Thinking…" while the summary arrives, then "Thought for 12s".
function thinkingLabelOf(text: string, duration_ms: number | null): string {
  if (text === '') return '';
  if (duration_ms === null) return 'Thinking…';
  const seconds = Math.max(1, Math.round(duration_ms / 1000));
  return `Thought for ${seconds}s`;
}

function isTranslating(): boolean {
  return current_target_state === 'waiting' || current_target_state === 'streaming';
}

function setViewMode(view_mode: ViewMode): void {
  // resetPairs empties pairs_view, so every view change re-places the block atop the column showing the translation.
  (view_mode === 'pairs' ? pairs_view : target_pane).prepend(thinking_block);
  panes.hidden = view_mode === 'pairs';
  pairs_view.hidden = view_mode !== 'pairs';
  edit_button.hidden = view_mode !== 'pairs';
  if (view_mode === 'edit' && translation_pairs.length > 0 && current_target_state === 'done') {
    target_text.textContent = composePairsMarkdown(translation_pairs, 'translation');
    target_text.classList.remove('is-empty');
  }
}

function resetPairs(): void {
  translation_pairs = [];
  setStreamingCell(null);
  pairs_view.innerHTML = '';
}

function isPairEvent(stream_event: StreamEvent): stream_event is PairEvent {
  return stream_event[0] === 'pair_start' || stream_event[0] === 'source_delta' || stream_event[0] === 'translation_delta';
}

function applyPairEvent([event_name, data]: PairEvent): void {
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

// Only a Markdown-mode left column differs from the textarea; elsewhere the text as typed is the source. A column that
// lost words (a cut-off run, or the model dropped some) never stands in for the input.
function isReformattedSourceShown(): boolean {
  if (pairs_view.hidden || shown_result_mode !== 'translate_markdown' || translation_pairs.length === 0) return false;
  return findSourceDivergence(source_text.value, translation_pairs) === null;
}

const alert_box = requiredElement('#alert', HTMLDivElement);
const alert_title = requiredElement('#alert-title', HTMLDivElement);
const alert_body = requiredElement('#alert-body', HTMLDivElement);
const alert_detail = requiredElement('#alert-detail', HTMLDivElement);
const alert_action_button = requiredElement('#alert-action-button', HTMLButtonElement);
// What the alert's button does while this alert is shown; written only by showAlert.
let alert_action: AlertAction | null = null;

// detail is the raw message, shown small so the cause is never hidden. action: null for no button.
function showAlert({ severity, title, body = '', detail = '', action = null }: {
  severity: 'error' | 'warning' | 'info'; title: string; body?: string; detail?: string; action?: AlertAction | null;
}): void {
  alert_box.className = `alert is-${severity}`;
  alert_title.textContent = title;
  alert_body.textContent = body;
  alert_body.hidden = body === '';
  alert_detail.textContent = detail;
  alert_action = action;
  alert_action_button.hidden = action === null;
  alert_action_button.textContent = action?.label ?? '';
  // Hiding first re-inserts it at the top of the top layer, above a drawer opened since it was last shown.
  if (alert_box.matches(':popover-open')) alert_box.hidePopover();
  alert_box.showPopover();
}

function hideAlert(): void {
  if (alert_box.matches(':popover-open')) alert_box.hidePopover();
  alert_action = null;
}

function isAlertShown(): boolean {
  return alert_box.matches(':popover-open');
}

function showErrorAlert(error_kind: PageErrorKind, message: string, has_partial_translation: boolean, silence_text: string): void {
  const { title, body } = alertForError(error_kind, message, has_partial_translation, silence_text);
  showAlert({ severity: 'error', title, body, detail: message, action: { label: 'Try again', run: translate } });
}

// "Neither Sonnet 5.5 nor Haiku 5.5 sent anything back." after a fallback, else "Haiku 5.5 sent nothing back."
function silenceTextOf(requested_model_id: string, served_model_id: string, is_fallback: boolean): string {
  return is_fallback
    ? `Neither ${modelLabelOf(requested_model_id)} nor ${modelLabelOf(served_model_id)} sent anything back.`
    : `${modelLabelOf(served_model_id)} sent nothing back.`;
}


const history_sidebar = requiredElement('#history-sidebar', HTMLDialogElement);
const sidebar_open_button = requiredElement('#sidebar-open-button', HTMLButtonElement);
const history_search = requiredElement('#history-search', HTMLInputElement);
const history_list = requiredElement('#history-list', HTMLOListElement);
const history_status = requiredElement('#history-status', HTMLParagraphElement);
const wide_screen_query = matchMedia('(min-width: 1280px)');
const HISTORY_LIST_LIMIT = 200;
// Long enough to reach Undo after a misclick, short enough that the row does not linger.
const DELETE_UNDO_MS = 5000;
const TRASH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5"/></svg>';

// Summaries from the last GET /history, newest first; written only by loadHistory.
let history_summaries: HistorySummary[] = [];
// The entry on screen, marked in the list; null when the workspace holds anything else. Written only by setShownHistoryId.
let shown_history_id: number | null = null;
// Deletes waiting out their Undo window: entry id -> timer. The row stays hidden while its id is here.
const pending_deletes = new Map<number, ReturnType<typeof setTimeout>>();

function setShownHistoryId(history_id: number | null): void {
  shown_history_id = history_id;
  for (const open_button of history_list.querySelectorAll<HTMLButtonElement>('.history-open-button')) {
    const is_current = Number(open_button.dataset.entryId) === history_id;
    if (is_current) open_button.setAttribute('aria-current', 'true');
    else open_button.removeAttribute('aria-current');
  }
}

// The first non-blank line of input_preview, without the Markdown that would otherwise show as raw marks.
function historyTitleOf(input_preview: string): string {
  const first_line = input_preview.split('\n').find((line) => line.trim() !== '') ?? '';
  return plainTextOf(parseInline(first_line.replace(/^\s*(#{1,6}\s+|[-*+]\s+|>\s+|\d+[.)]\s+)/, '')))
    .replace(/\s+/g, ' ')
    .trim();
}

function describeHistoryTooltip(summary: HistorySummary): string {
  const created = new Date(summary.created_at);
  const time = created.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const day = historyGroupOf(summary.created_at);
  let day_label = day;
  if (day !== 'Today' && day !== 'Yesterday') day_label = created.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const partial_note = summary.outcome === 'done' ? '' : ' · partial';
  const choice_label = `${modeNoteOf(summary.mode)}${choiceLabelOf({ model_id: summary.served_model_id, effort: summary.effort })}`;
  const direction = `${summary.source_language.toUpperCase()} → ${summary.target_language.toUpperCase()}`;
  return `${direction} · ${day_label} ${time} · ${choice_label}${partial_note}`;
}

function matchesHistorySearch(summary: HistorySummary, folded_query_words: string[]): boolean {
  const haystack = foldForSearch(`${summary.input_preview} ${summary.output_preview}`);
  return folded_query_words.every((word) => haystack.includes(word));
}

// '' hides it. Used for the empty state, no search matches, and load or delete errors.
function showHistoryStatus(text: string): void {
  history_status.textContent = text;
  history_status.hidden = text === '';
}

function createHistoryItem(summary: HistorySummary): HTMLLIElement {
  const item = document.createElement('li');
  item.className = 'history-item';
  const open_button = document.createElement('button');
  open_button.className = 'history-open-button';
  open_button.dataset.entryId = String(summary.id);
  open_button.tabIndex = -1;
  const title = historyTitleOf(summary.input_preview);
  open_button.title = describeHistoryTooltip(summary);
  open_button.setAttribute('aria-label', summary.outcome === 'done' ? title : `${title} (partial)`);
  if (summary.id === shown_history_id) open_button.setAttribute('aria-current', 'true');
  const title_element = document.createElement('span');
  title_element.className = 'history-item-title';
  title_element.textContent = title;
  open_button.append(title_element);
  if (summary.outcome !== 'done') {
    const partial_mark = document.createElement('span');
    partial_mark.className = 'history-partial-mark';
    partial_mark.setAttribute('aria-hidden', 'true');
    open_button.append(partial_mark);
  }
  open_button.addEventListener('click', () => openHistoryEntry(summary.id));

  const delete_button = document.createElement('button');
  delete_button.className = 'history-delete-button';
  delete_button.tabIndex = -1;
  delete_button.title = 'Delete (⌫)';
  delete_button.setAttribute('aria-label', 'Delete');
  delete_button.innerHTML = TRASH_ICON;
  delete_button.addEventListener('click', () => deleteHistoryEntry(summary.id));

  item.append(open_button, delete_button);
  return item;
}

// The one renderer of the list: grouped, filtered by the search field, minus rows waiting to be deleted.
// Exactly one row is in the Tab order (roving tabindex): the open entry if listed, else the first.
function renderHistoryList(): void {
  const folded_query_words = foldForSearch(history_search.value).split(/\s+/).filter(Boolean);
  const visible_summaries = history_summaries.filter((summary) =>
    !pending_deletes.has(summary.id) && matchesHistorySearch(summary, folded_query_words));
  const list_children: HTMLLIElement[] = [];
  let previous_group = null;
  for (const summary of visible_summaries) {
    const group = historyGroupOf(summary.created_at);
    if (group !== previous_group) {
      const group_label = document.createElement('li');
      group_label.className = 'history-group-label';
      group_label.textContent = group;
      list_children.push(group_label);
      previous_group = group;
    }
    list_children.push(createHistoryItem(summary));
  }
  if (history_summaries.length >= HISTORY_LIST_LIMIT && folded_query_words.length === 0) {
    const limit_note = document.createElement('li');
    limit_note.className = 'history-list-limit';
    limit_note.textContent = `Showing the latest ${HISTORY_LIST_LIMIT}`;
    list_children.push(limit_note);
  }
  history_list.replaceChildren(...list_children);
  if (history_summaries.length === pending_deletes.size) showHistoryStatus('Your translations will appear here.');
  else if (visible_summaries.length === 0) showHistoryStatus(`No matches for “${history_search.value.trim()}”`);
  else showHistoryStatus('');
  const current_button = history_list.querySelector<HTMLButtonElement>('.history-open-button[aria-current="true"]');
  const tab_stop = current_button ?? history_list.querySelector<HTMLButtonElement>('.history-open-button');
  if (tab_stop) tab_stop.tabIndex = 0;
  current_button?.scrollIntoView({ block: 'nearest' });
}

async function loadHistory(): Promise<void> {
  try {
    history_summaries = await fetchJson<HistorySummary[]>('/history');
    renderHistoryList();
  } catch (error) {
    history_list.replaceChildren();
    showHistoryStatus(`Could not load history: ${errorText(error)}`);
  }
}

function readIsSidebarOpen(): boolean {
  return readStored('is_sidebar_open') !== '0';
}

function writeIsSidebarOpen(is_open: boolean): void {
  writeStored('is_sidebar_open', is_open ? '1' : '0');
}

// Wide screens dock it as a column (non-modal, remembered); narrow screens show it as a modal drawer.
function openSidebar(): void {
  if (wide_screen_query.matches) {
    // A docked sidebar is not modal: typing should continue where it was. focus() is a no-op on the
    // open button (hidden once the sidebar is open), so a click keeps the dialog's own focus.
    const previous_focus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    history_sidebar.show();
    previous_focus?.focus();
    writeIsSidebarOpen(true);
  } else {
    history_sidebar.showModal();
  }
  sidebar_open_button.setAttribute('aria-expanded', 'true');
  loadHistory();
}

function closeSidebar(): void {
  history_sidebar.close();
  if (wide_screen_query.matches) writeIsSidebarOpen(false);
}

function toggleSidebar(): void {
  if (history_sidebar.open) closeSidebar();
  else openSidebar();
}

function isSidebarModal(): boolean {
  return history_sidebar.matches(':modal');
}

async function openHistoryEntry(entry_id: number): Promise<void> {
  try {
    showHistoryEntry(await fetchJson<HistoryEntry>(`/history/${entry_id}`));
    if (isSidebarModal()) closeSidebar();
  } catch (error) {
    showHistoryStatus(`Could not open it: ${errorText(error)}`);
    loadHistory();
  }
}

function flushPendingDelete(entry_id: number): void {
  clearTimeout(pending_deletes.get(entry_id));
  pending_deletes.delete(entry_id);
  fetch(`/history/${entry_id}`, { method: 'DELETE', keepalive: true }).catch(() => {});
}

// Hides the row at once and deletes on the server only after DELETE_UNDO_MS, so Undo needs no server call.
function deleteHistoryEntry(entry_id: number): void {
  const open_buttons = [...history_list.querySelectorAll<HTMLButtonElement>('.history-open-button')];
  const visible_ids = open_buttons.map((button) => Number(button.dataset.entryId));
  const deleted_index = visible_ids.indexOf(entry_id);
  const focus_id = visible_ids[deleted_index + 1] ?? visible_ids[deleted_index - 1] ?? null;
  const had_focus = history_list.contains(document.activeElement);
  pending_deletes.set(entry_id, setTimeout(() => {
    pending_deletes.delete(entry_id);
    fetchJson<null>(`/history/${entry_id}`, { method: 'DELETE' })
      .then(() => { history_summaries = history_summaries.filter((summary) => summary.id !== entry_id); })
      .catch((error: unknown) => showHistoryStatus(`Could not delete: ${errorText(error)}`));
  }, DELETE_UNDO_MS));
  if (entry_id === shown_history_id) setShownHistoryId(null);
  renderHistoryList();
  if (had_focus && focus_id !== null) history_list.querySelector<HTMLButtonElement>(`[data-entry-id="${focus_id}"]`)?.focus();
  showAlert({
    severity: 'info',
    title: 'Translation deleted',
    action: {
      label: 'Undo',
      run: () => {
        clearTimeout(pending_deletes.get(entry_id));
        pending_deletes.delete(entry_id);
        renderHistoryList();
        if (history_sidebar.open) history_list.querySelector<HTMLButtonElement>(`[data-entry-id="${entry_id}"]`)?.focus();
      },
    },
  });
}

// Shows a stored translation without calling Claude. Text typed but never translated is kept for Undo,
// the same way Clear keeps it. Assigning .value fires no input event, so detection keeps the stored direction.
function showHistoryEntry(entry: HistoryEntry): void {
  if (active_request) active_request.abort();
  hideAlert();
  const has_unsaved_input = source_text.value.trim() !== '' && shown_history_id === null && current_target_state !== 'done';
  if (has_unsaved_input) {
    cleared_snapshot = snapshotWorkspace();
    undo_clear_button.hidden = false;
  } else {
    forgetClearedSnapshot();
  }
  source_text.value = entry.input_text;
  source_language = entry.source_language;
  is_direction_auto = false;
  renderLanguages();
  renderSource();
  renderStoredPairs(entry.pairs);
  renderTarget('done', entry.pairs.length > 0 ? '' : entry.unpaired_text);
  shown_result_mode = entry.mode;
  setThinking(entry.thinking_text, entry.thinking_duration_ms, false);
  setRunInfo(`From history · ${runInfoTextOf({ has_output: true, ...entry, is_from_history: true })}`);
  setViewMode(entry.pairs.length > 0 ? 'pairs' : 'edit');
  setShownHistoryId(entry.id);
}

function snapshotWorkspace(): WorkspaceSnapshot {
  return {
    source_text: source_text.value,
    pairs: translation_pairs.map(({ pair_type, level, marker, source_text: pair_source_text, translation_text }) =>
      ({ pair_type, level, marker, source_text: pair_source_text, translation_text })),
    plain_target_text: translation_pairs.length > 0 ? '' : target_text.textContent,
    target_state: current_target_state === 'done' ? 'done' : 'empty',
    run_info: current_target_state === 'done' ? run_info.textContent : '',
    view_mode: pairs_view.hidden ? 'edit' : 'pairs',
    result_mode: shown_result_mode,
    thinking_text: current_target_state === 'done' ? thinking_text : '',
    thinking_duration_ms: current_target_state === 'done' ? thinking_duration_ms : null,
  };
}

function forgetClearedSnapshot(): void {
  cleared_snapshot = null;
  undo_clear_button.hidden = true;
}

// Replays stored pairs ({ pair_type, level, marker, source_text, translation_text }) through applyPairEvent,
// the same path a live translation takes. Used by Undo after Clear and by opening a history entry.
function renderStoredPairs(pairs: Pair[]): void {
  resetPairs();
  pairs.forEach((pair, pair_index) => {
    applyPairEvent(['pair_start', { pair_index, pair_type: pair.pair_type, level: pair.level, marker: pair.marker }]);
    applyPairEvent(['source_delta', { pair_index, text: pair.source_text }]);
    applyPairEvent(['translation_delta', { pair_index, text: pair.translation_text }]);
  });
  setStreamingCell(null);
}

// The one place the end-of-run status line is worded. A live run names the model only after a fallback, since the
// picker already shows the choice; a history entry always names its choice.
function runInfoTextOf({ outcome, has_output, duration_ms = 0, served_model_id = '', effort = '', mode, is_fallback, is_from_history }: RunInfo): string {
  if (outcome === 'cancelled') return has_output ? 'Cancelled · partial' : 'Cancelled';
  if (outcome === 'error') return has_output ? 'Stopped · partial' : 'Failed';
  const seconds = `${(duration_ms / 1000).toFixed(1)}s`;
  // The mode leads: the chip shows the next run's mode, and the end of this line is cut at 1280 with the sidebar docked.
  if (is_from_history) return `${modeNoteOf(mode)}${seconds} · ${choiceLabelOf({ model_id: served_model_id, effort })}`;
  return is_fallback ? `${seconds} · ${modelLabelOf(served_model_id)}` : seconds;
}

function restoreClearedTranslation(): void {
  const snapshot = cleared_snapshot;
  if (snapshot === null) return;
  forgetClearedSnapshot();
  renderStoredPairs(snapshot.pairs);
  renderTarget(snapshot.target_state, snapshot.plain_target_text);
  shown_result_mode = snapshot.result_mode;
  setThinking(snapshot.thinking_text, snapshot.thinking_duration_ms, false);
  setRunInfo(snapshot.run_info);
  setViewMode(snapshot.view_mode);
}

function composeCopyText(): string {
  return translation_pairs.length > 0 ? composePairsMarkdown(translation_pairs, 'translation') : target_text.textContent;
}

function composeSourceCopyText(): string {
  return isReformattedSourceShown() ? composePairsMarkdown(translation_pairs, 'source') : source_text.value;
}

function setRunInfo(text: string): void {
  run_info.textContent = text;
  run_info.title = text;
}

function targetLanguageOf(language: Language): Language { return language === 'en' ? 'vi' : 'en'; }

function renderLanguages(): void {
  source_language_name.textContent = LANGUAGE_LABELS[source_language];
  target_language_name.textContent = LANGUAGE_LABELS[targetLanguageOf(source_language)];
  detected_hint.hidden = !is_direction_auto || source_text.value.trim() === '';
  writeStored('source_language', source_language);
}

function renderSource(): void {
  const text = source_text.value;
  const is_over_limit = text.length > MAX_TEXT_CHARS;
  char_count.textContent = text.length >= CHAR_COUNT_VISIBLE_FROM
    ? `${text.length.toLocaleString('en-US')} / ${MAX_TEXT_CHARS.toLocaleString('en-US')} characters`
    : '';
  char_count.classList.toggle('is-over-limit', is_over_limit);
  clear_button.hidden = text === '';
  copy_source_button.hidden = text === '';
  translate_button.disabled = text.trim() === '' || is_over_limit;
}

function renderTarget(target_state: TargetState, text = ''): void {
  current_target_state = target_state;
  // Every path that drops the result passes here (new run, Esc or error before output, Clear, swap).
  if (target_state === 'empty' || target_state === 'waiting') setThinking('', null, false);
  // The edit view shows only a finished translation, so mid-translation its pane would be empty.
  edit_button.disabled = isTranslating();
  // An SVG element has no .hidden property; assigning one would only add a JS field and leave the attribute.
  run_activity.toggleAttribute('hidden', !isTranslating());
  target_pane.classList.toggle('is-waiting', target_state === 'waiting');
  target_text.textContent = text;
  target_text.classList.toggle('is-empty', target_state === 'empty');
  target_text.classList.toggle('is-streaming', target_state === 'streaming');
  target_text.classList.toggle('is-error', target_state === 'error');
  // While translating, Copy keeps its space (invisible) so the status beside it does not jump when it appears.
  copy_button.hidden = target_state === 'empty' || target_state === 'error';
  copy_button.style.visibility = target_state === 'done' ? 'visible' : 'hidden';
  if (target_state === 'empty' || target_state === 'error') setRunInfo('');
}

function cancelTranslation(): void {
  if (!active_request) return;
  active_request.abort();
  active_request = null;
  setStreamingCell(null);
  const has_output = current_target_state === 'streaming';
  renderTarget(has_output ? 'done' : 'empty', has_output ? target_text.textContent : '');
  setRunInfo(runInfoTextOf({ outcome: 'cancelled', has_output }));
}

// What the edit view shows after a run: the text that came outside pairs, when no pairs came at all.
function plainTextAfterRun(unpaired_text: string): string {
  return translation_pairs.length > 0 ? '' : unpaired_text;
}

function showSourceDivergenceAlert(source_divergence: SourceDivergence): void {
  const { input_excerpt, source_excerpt } = source_divergence;
  const left_column_text = source_excerpt === '' ? 'ends here' : `“${source_excerpt}”`;
  showAlert({
    severity: 'warning',
    title: 'The left column differs from your input',
    body: 'Claude changed or skipped some of your words in the left column. Check that spot, or translate again.',
    detail: `Yours: “${input_excerpt}” · Left column: ${left_column_text}`,
    action: { label: 'Translate again', run: translate },
  });
}

// Placeholder bars while the first words are on their way: one per CHARS_PER_SKELETON_BAR source chars, 1 to 6.
function showSkeleton(text: string): void {
  const bar_count = Math.min(6, Math.max(1, Math.ceil(text.length / CHARS_PER_SKELETON_BAR)));
  skeleton.innerHTML = '<span></span>'.repeat(bar_count);
}

async function translate(): Promise<void> {
  const text = source_text.value;
  const request_settings = translationSettings();
  if (text.trim() === '' || text.length > MAX_TEXT_CHARS || request_settings === null) return;
  closeSettingsMenus();
  if (active_request) active_request.abort();
  const request = new AbortController();
  active_request = request;

  showSkeleton(text);
  hideAlert();
  forgetClearedSnapshot();
  setShownHistoryId(null);
  resetPairs();
  shown_result_mode = request_settings.mode;
  setViewMode('edit');
  renderTarget('waiting');

  // Text outside pairs: the model ignored the format, so it is shown the old way.
  let unpaired_text = '';
  // "API busy (…), retry 1/3…" or "… is slow, switched to …" until more text arrives; '' otherwise.
  let retry_note = '';
  const started_at = Date.now();

  // The status line while the run goes on; refreshed every second and on every event that changes it.
  const renderProgress = (): void => {
    if (active_request !== request || current_target_state === 'done') return;
    const waited_seconds = Math.floor((Date.now() - started_at) / 1000);
    let waited_note = '';
    if (waited_seconds >= 5) waited_note = has_escape_key ? ` ${waited_seconds}s · Esc to cancel` : ` ${waited_seconds}s`;
    const is_thinking = thinking_text !== '' && thinking_duration_ms === null;
    const activity_label = is_thinking ? 'Thinking…' : 'Translating…';
    setRunInfo(`${retry_note || activity_label}${waited_note}`);
  };

  // Keeps what arrived, and returns whether anything did.
  const endFailedRun = (): boolean => {
    setStreamingCell(null);
    const has_output = translation_pairs.length > 0 || unpaired_text.trim() !== '';
    renderTarget(has_output ? 'done' : 'empty', plainTextAfterRun(unpaired_text));
    setRunInfo(runInfoTextOf({ outcome: 'error', has_output }));
    return has_output;
  };

  const handleStreamEvent = (stream_event: StreamEvent): void => {
    if (isPairEvent(stream_event)) {
      const [event_name, data] = stream_event;
      if (event_name === 'pair_start' && data.pair_index === 0) setViewMode('pairs');
      retry_note = '';
      applyPairEvent(stream_event);
      if (current_target_state !== 'streaming') renderTarget('streaming');
      return;
    }
    const [event_name, data] = stream_event;
    if (event_name === 'unpaired_delta') {
      unpaired_text += data.text;
      retry_note = '';
      // Once pairs exist, text outside them is a stray note and is not shown.
      if (translation_pairs.length === 0) renderTarget('streaming', unpaired_text);
    } else if (event_name === 'thinking_delta') {
      // Opens as the summary starts arriving; a click to close it while thinking is kept.
      const is_open = thinking_text === '' || thinking_block.open;
      setThinking(thinking_text + data.text, null, is_open);
      renderProgress();
    } else if (event_name === 'thinking_done') {
      setThinking(thinking_text, data.duration_ms, false);
      renderProgress();
    } else if (event_name === 'retry') {
      retry_note = `API busy (${data.error}), retry ${data.attempt}/${data.max_retries}…`;
      renderProgress();
    } else if (event_name === 'fallback') {
      retry_note = `${modelLabelOf(data.from_model_id)} is slow, switched to ${modelLabelOf(data.to_model_id)}…`;
      renderProgress();
    } else if (event_name === 'done') {
      setStreamingCell(null);
      renderTarget('done', plainTextAfterRun(unpaired_text));
      setShownHistoryId(data.history_id);
      if (history_sidebar.open) loadHistory();
      setRunInfo(runInfoTextOf({ outcome: 'done', has_output: true, ...data }));
      refreshQuotaWarning();
      if (translation_pairs.length > 0) {
        const source_divergence = findSourceDivergence(text, translation_pairs);
        if (source_divergence !== null) showSourceDivergenceAlert(source_divergence);
      }
    } else if (event_name === 'error') {
      const has_output = endFailedRun();
      const silence_text = silenceTextOf(request_settings.model_id, data.served_model_id, data.is_fallback);
      showErrorAlert(data.error_kind, data.message, has_output, silence_text);
      refreshQuotaWarning();
      setShownHistoryId(data.history_id);
      if (history_sidebar.open) loadHistory();
    }
  };

  renderProgress();
  const progress_timer = setInterval(renderProgress, 1000);
  try {
    const response = await fetch('/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source_language,
        target_language: targetLanguageOf(source_language),
        text,
        model_id: request_settings.model_id,
        effort: request_settings.effort,
        mode: request_settings.mode,
      }),
      signal: request.signal,
    });
    if (!response.ok) throw new Error(await response.text());
    if (response.body === null) throw new Error('The server sent an empty reply.');
    await readStreamEvents(response.body, handleStreamEvent);
  } catch (error) {
    // An abort comes from Esc, Clear or a newer run, which have already updated the page.
    const is_abort = error instanceof Error && error.name === 'AbortError';
    if (!is_abort) {
      const has_output = endFailedRun();
      // fetch rejects with a TypeError only when the server cannot be reached at all.
      const error_kind = error instanceof TypeError ? 'server_unreachable' : 'request_rejected';
      showErrorAlert(error_kind, errorText(error), has_output, '');
    }
  } finally {
    clearInterval(progress_timer);
    if (active_request === request) active_request = null;
  }
}

function swapLanguages(): void {
  if (active_request) active_request.abort();
  hideAlert();
  if (current_target_state === 'done') source_text.value = composeCopyText();
  resetPairs();
  setViewMode('edit');
  source_language = targetLanguageOf(source_language);
  is_direction_auto = false;
  swap_button.classList.toggle('is-turned');
  renderLanguages();
  renderTarget('empty');
  renderSource();
  source_text.focus();
}

source_text.addEventListener('input', () => {
  if (source_text.value.trim() !== '') {
    source_language = detectSourceLanguage(source_text.value);
    is_direction_auto = true;
  }
  if (!active_request && run_info.textContent.startsWith('Cancelled')) setRunInfo('');
  if (cleared_snapshot && source_text.value === cleared_snapshot.source_text) {
    restoreClearedTranslation();
  } else {
    if (cleared_snapshot && source_text.value !== '') forgetClearedSnapshot();
    setShownHistoryId(null);
  }
  renderLanguages();
  renderSource();
});
translate_button.addEventListener('click', translate);
swap_button.addEventListener('click', swapLanguages);
alert_action_button.addEventListener('click', () => {
  const action = alert_action;
  hideAlert();
  action?.run();
});
requiredElement('#alert-close-button', HTMLButtonElement).addEventListener('click', hideAlert);
// A reformatted left column is what gets edited, so a second Markdown run starts from it; insertText keeps the
// pasted text one ⌘Z away. Its input event treats the insert as typing, so the entry and direction are put back.
edit_button.addEventListener('click', () => {
  const reformatted_source_text = isReformattedSourceShown() ? composePairsMarkdown(translation_pairs, 'source') : null;
  setViewMode('edit');
  source_text.focus();
  if (reformatted_source_text !== null && reformatted_source_text !== source_text.value) {
    const shown_entry_id = shown_history_id;
    const shown_source_language = source_language;
    const was_direction_auto = is_direction_auto;
    source_text.select();
    document.execCommand('insertText', false, reformatted_source_text);
    source_text.setSelectionRange(0, 0);
    setShownHistoryId(shown_entry_id);
    source_language = shown_source_language;
    is_direction_auto = was_direction_auto;
    renderLanguages();
  }
});
// Clears the source and the translation, keeping both for Undo. Used by Clear and by New translation.
function clearWorkspace(): void {
  if (active_request) active_request.abort();
  hideAlert();
  cleared_snapshot = snapshotWorkspace();
  resetPairs();
  setViewMode('edit');
  // insertText instead of assigning .value keeps the deletion on the undo stack, so ⌘Z restores the text.
  source_text.focus();
  source_text.select();
  document.execCommand('insertText', false, '');
  renderTarget('empty');
  setShownHistoryId(null);
  if (cleared_snapshot.source_text !== '') undo_clear_button.hidden = false;
}

clear_button.addEventListener('click', clearWorkspace);
undo_clear_button.addEventListener('click', () => {
  if (!cleared_snapshot) return;
  source_text.focus();
  source_text.select();
  // Same path as ⌘Z: refilling the cleared text makes the input handler restore the translation.
  document.execCommand('insertText', false, cleared_snapshot.source_text);
});
// One footer line (75% of the text width at 7pt) holds about 110 characters; margin boxes cannot clip a longer title.
const PRINT_TITLE_MAX_CHARS = 90;
const APP_TITLE = document.title;

// JSON.stringify would not do: CSS reads its \n escape as the letter n.
function cssStringOf(text: string): string {
  return `"${text.replace(/\s+/g, ' ').replace(/["\\]/g, '\\$&')}"`;
}

function truncateAtWord(text: string, max_chars: number): string {
  if (text.length <= max_chars) return text;
  const cut = text.slice(0, max_chars - 1);
  const last_space = cut.lastIndexOf(' ');
  return `${last_space > 0 ? cut.slice(0, last_space) : cut}…`;
}

// Page-margin boxes cannot read the DOM, so the running header reads custom properties set here.
// Chrome offers document.title as the Save as PDF file name.
window.addEventListener('beforeprint', () => {
  const print_title = truncateAtWord(historyTitleOf(source_text.value), PRINT_TITLE_MAX_CHARS);
  const root_style = document.documentElement.style;
  root_style.setProperty('--print-title', cssStringOf(print_title));
  root_style.setProperty('--print-source-language', cssStringOf(LANGUAGE_LABELS[source_language]));
  root_style.setProperty('--print-target-language', cssStringOf(LANGUAGE_LABELS[targetLanguageOf(source_language)]));
  if (print_title !== '') document.title = `${print_title} · ${APP_TITLE}`;
});
window.addEventListener('afterprint', () => { document.title = APP_TITLE; });
window.addEventListener('scroll', () => {
  direction_bar.classList.toggle('is-stuck', direction_bar.getBoundingClientRect().top <= 0 && window.scrollY > 0);
}, { passive: true });
copy_button.addEventListener('click', () => copyWithFeedback(copy_button, composeCopyText()));
copy_source_button.addEventListener('click', () => copyWithFeedback(copy_source_button, composeSourceCopyText()));

sidebar_open_button.addEventListener('click', () => {
  openSidebar();
  history_search.focus();
});
requiredElement('#sidebar-close-button', HTMLButtonElement).addEventListener('click', closeSidebar);
function startNewTranslation(): void {
  if (source_text.value !== '') clearWorkspace();
  if (isSidebarModal()) closeSidebar();
  source_text.focus();
}
requiredElement('#new-translation-button', HTMLButtonElement).addEventListener('click', startNewTranslation);
requiredElement('#masthead-new-translation-button', HTMLButtonElement).addEventListener('click', startNewTranslation);
// Only a modal drawer has a backdrop; a click on the dialog itself (not the content) is a click on it.
history_sidebar.addEventListener('click', (event) => {
  if (event.target === history_sidebar && isSidebarModal()) closeSidebar();
});
history_sidebar.addEventListener('close', () => sidebar_open_button.setAttribute('aria-expanded', 'false'));
wide_screen_query.addEventListener('change', () => {
  history_sidebar.close();
  if (wide_screen_query.matches && readIsSidebarOpen()) openSidebar();
});
history_search.addEventListener('input', renderHistoryList);
history_search.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    history_list.querySelector<HTMLButtonElement>('.history-open-button')?.focus();
  } else if (event.key === 'Escape') {
    // stopPropagation keeps this Esc from also cancelling a running translation in the page handler.
    event.stopPropagation();
    if (history_search.value !== '') {
      event.preventDefault();
      history_search.value = '';
      renderHistoryList();
    } else if (!isSidebarModal()) {
      source_text.focus();
    }
  }
});
history_list.addEventListener('keydown', (event) => {
  const open_buttons = [...history_list.querySelectorAll<HTMLButtonElement>('.history-open-button')];
  const focused_index = open_buttons.findIndex((button) => button === document.activeElement);
  if (focused_index === -1) return;
  const target_index = arrowTargetOf(event.key, focused_index, open_buttons.length);
  if (target_index !== undefined) {
    event.preventDefault();
    const target_button = open_buttons[Math.max(0, Math.min(open_buttons.length - 1, target_index))];
    open_buttons.forEach((button) => { button.tabIndex = button === target_button ? 0 : -1; });
    target_button.focus();
    target_button.scrollIntoView({ block: 'nearest' });
  } else if (event.key === 'Backspace' || event.key === 'Delete') {
    event.preventDefault();
    deleteHistoryEntry(Number(open_buttons[focused_index].dataset.entryId));
  }
});
// A delete still inside its Undo window would be lost on reload; keepalive lets it finish as the page goes.
window.addEventListener('pagehide', () => {
  for (const entry_id of [...pending_deletes.keys()]) flushPendingDelete(entry_id);
});

document.addEventListener('keydown', (event) => {
  // A modal drawer owns the keyboard: Esc closes it natively, and page shortcuts must not act behind it.
  // The docked sidebar is part of the page, so shortcuts keep working while it is open.
  if (isSidebarModal()) return;
  const has_modifier = event.metaKey || event.ctrlKey;
  const open_menu = openSettingsMenu();
  if (has_modifier && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    if (!history_sidebar.open) openSidebar();
    history_search.focus();
    history_search.select();
  } else if (has_modifier && event.key === '\\') {
    event.preventDefault();
    toggleSidebar();
  } else if (has_modifier && event.key === '/') {
    event.preventDefault();
    toggleModelMenu();
  } else if (event.key === 'Escape' && open_menu !== undefined) {
    // The one place Esc is ordered: an open menu closes first, then a running translation is cancelled.
    open_menu.hidePopover();
  } else if (event.key === 'Escape' && active_request) {
    event.preventDefault();
    cancelTranslation();
  } else if (event.key === 'Escape' && isAlertShown()) {
    hideAlert();
  } else if (has_modifier && event.key === 'Enter') {
    event.preventDefault();
    translate();
  } else if (has_modifier && event.shiftKey && event.key.toLowerCase() === 's') {
    event.preventDefault();
    swapLanguages();
  }
});

renderLanguages();
renderSource();
// Started before the sidebar fetches history, whose tooltips name models, but awaited only after the sidebar has
// docked: awaiting first let a frame paint without it, and the page shifted when it docked.
const translation_options_load = loadTranslationOptions();
if (wide_screen_query.matches && readIsSidebarOpen()) {
  openSidebar();
  // show() moves focus into the dialog; the textarea is where typing should start.
  source_text.focus();
}
try {
  await translation_options_load;
} catch (error) {
  showErrorAlert('server_unreachable', errorText(error), false, '');
}
