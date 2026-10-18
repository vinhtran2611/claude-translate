// The page: the text box, the side-by-side pairs, the history sidebar and the settings menus. Loaded by index.html;
// the server strips its types as it serves it.
import { documentIndexOf, parseCellBlocks, parseInline, plainTextOf, quoteContentOf, renderCellContent } from '../shared/web/markdown.ts';
import { findSourceDivergence } from './source-check.ts';
import { foldForSearch, historyGroupOf } from '../shared/web/ui.ts';
import type {
  Effort, EffortOption, ErrorKind, HistoryEntry, HistorySummary, Language, Mode, Outcome, Pair, QuotaWarning, StreamEvent,
  TranslationOptions,
} from '../shared/api.ts';

// A pair on screen: what the model returned, plus the cells it renders into.
interface ShownPair extends Pair {
  pair_index: number;
  source_content: HTMLElement;
  translation_content: HTMLElement;
}

type PairSide = 'source' | 'translation';
type PairEvent = Extract<StreamEvent, ['pair_start' | 'source_delta' | 'translation_delta', unknown]>;
type TargetState = 'empty' | 'waiting' | 'streaming' | 'done' | 'error';
// 'edit' shows the textarea and a plain translation; 'pairs' shows the side-by-side pairs.
type ViewMode = 'edit' | 'pairs';
// The server's error kinds, plus the two the page detects itself.
type PageErrorKind = ErrorKind | 'server_unreachable' | 'request_rejected';

interface StreamingCell {
  pair: ShownPair;
  side: PairSide;
}

interface AlertAction {
  label: string;
  run: () => void;
}

// What the next translation runs with.
interface TranslationSettings {
  model_id: string;
  effort: Effort;
  mode: Mode;
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

const VIETNAMESE_LETTER = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;
const ENGLISH_FUNCTION_WORDS = new Set(['the', 'a', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'from', 'by', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been', 'have', 'has', 'had', 'will', 'would', 'can', 'could', 'should', 'it', 'its', 'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'we', 'they', 'my', 'your', 'our', 'their', 'me', 'us', 'them', 'what', 'which', 'who', 'when', 'where', 'why', 'how', 'not', 'if', 'so', 'as', 'just', 'about', 'into', 'than', 'then', 'there', 'here', 'some', 'any', 'all', 'let']);

function wordsOf(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}']+/u).filter((word) => /\p{L}/u.test(word));
}

// The share of accented words alone cannot separate code-mixed Vietnamese ("anh check giúp em latency p99", 0.29)
// from English naming a person or dish ("Thanks Nguyễn Văn An for the review", 0.29); function words break the tie.
function detectSourceLanguage(text: string): Language {
  const unquoted_words = wordsOf(text.replace(/"[^"]*"|“[^”]*”|`[^`]*`/g, ' '));
  const words = unquoted_words.length > 0 ? unquoted_words : wordsOf(text);
  const vietnamese_word_count = words.filter((word) => VIETNAMESE_LETTER.test(word)).length;
  const english_function_word_count = words.filter((word) => ENGLISH_FUNCTION_WORDS.has(word)).length;
  return vietnamese_word_count > english_function_word_count ? 'vi' : 'en';
}

// The element index.html must have; throws at load when the markup and this code disagree.
function requiredElement<Type extends Element>(selector: string, type: new () => Type, root: ParentNode = document): Type {
  const found = root.querySelector(selector);
  if (!(found instanceof type)) throw new Error(`index.html has no ${type.name} matching ${selector}`);
  return found;
}

// The element an event happened on, or null for a non-element target.
function eventElement(event: Event): Element | null {
  return event.target instanceof Element ? event.target : null;
}

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

let source_language: Language = 'en';
try { if (localStorage.getItem('source_language') === 'vi') source_language = 'vi'; } catch {}
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

// Code units come back with an empty translation by contract; their source is shown on both sides.
function translationTextOf(pair: Pair): string {
  return pair.pair_type === 'code' ? pair.source_text : pair.translation_text;
}

// side: 'source' | 'translation'. Only the cell being streamed into renders provisionally; every other cell is final.
function renderPairCell(pair: ShownPair, side: PairSide): void {
  const is_streaming = streaming_cell !== null && streaming_cell.pair === pair && streaming_cell.side === side;
  const text = side === 'source' ? pair.source_text : translationTextOf(pair);
  const blocks = parseCellBlocks(pair.pair_type, pair.marker, pair.level, text, { is_streaming, link_definitions: document_index.link_definitions });
  renderCellContent(side === 'source' ? pair.source_content : pair.translation_content, blocks,
    { side, pair_index: pair.pair_index, document_index, is_streaming, is_document_complete: streaming_cell === null });
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

const COPY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8"/></svg>';
const CHECK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

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
  requiredElement('svg', SVGSVGElement, button).outerHTML = CHECK_ICON;
  if (label) label.textContent = 'Copied';
  button.classList.add('is-done');
  // One pending reset per button: a second click restarts it instead of being cut short by the first.
  clearTimeout(copy_reset_timers.get(button));
  copy_reset_timers.set(button, setTimeout(() => {
    requiredElement('svg', SVGSVGElement, button).outerHTML = COPY_ICON;
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
  copy_button.innerHTML = COPY_ICON;
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
  thinking_label.textContent = text === '' ? '' : is_live ? 'Thinking…' : `Thought for ${Math.max(1, Math.round((duration_ms ?? 0) / 1000))}s`;
  renderCellContent(thinking_body, parseCellBlocks('paragraph', '', 0, text.trim(), { is_streaming: false, link_definitions: new Map() }), { side: 'translation', pair_index: -1, document_index: documentIndexOf([]), is_streaming: false, is_document_complete: true });
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
    for (const cell of [source.cell, translation.cell]) cell.style.setProperty('--level', String(Math.max(1, data.level)));
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

// Rebuilds Markdown from the pairs: the model gave markers and levels separately from the text.
// side: 'source' | 'translation'.
function composePairsMarkdown(pairs: Pair[], side: PairSide): string {
  return pairs.map((pair, pair_index) => {
    const text = side === 'source' ? pair.source_text : translationTextOf(pair);
    let block = text;
    if (pair.pair_type === 'heading') block = `${'#'.repeat(Math.min(6, Math.max(1, pair.level)))} ${text}`;
    if (pair.pair_type === 'list_item') block = `${'   '.repeat(Math.max(0, pair.level - 1))}${pair.marker || '-'} ${text}`;
    if (pair.pair_type === 'quote') block = quoteContentOf(text).split('\n').map((line) => (line === '' ? '>' : `> ${line}`)).join('\n');
    if (pair.pair_type === 'code' && pair.marker) block = `${pair.marker}\n${text}\n${pair.marker.match(/^(`+|~+)/)?.[0] ?? '```'}`;
    const previous_pair = pairs[pair_index - 1];
    const is_same_list = previous_pair?.pair_type === 'list_item' && pair.pair_type === 'list_item';
    return (pair_index === 0 ? '' : is_same_list ? '\n' : '\n\n') + block;
  }).join('');
}

// Only a Markdown-mode left column differs from the textarea; elsewhere the text as typed is the source. A column that
// lost words (a cut-off run, or the model dropped some) never stands in for the input.
function isReformattedSourceShown(): boolean {
  return !pairs_view.hidden && shown_result_mode === 'translate_markdown' && translation_pairs.length > 0 &&
    findSourceDivergence(source_text.value, translation_pairs) === null;
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

// silence_text: who sent nothing, worded by silenceTextOf; used only by 'no_response'.
function alertForError(error_kind: PageErrorKind, message: string, has_partial_translation: boolean, silence_text: string): { title: string; body: string } {
  const kept_note = has_partial_translation ? ' What arrived so far is kept.' : '';
  if (error_kind === 'no_response') {
    return {
      title: "Claude didn't respond",
      body: `${silence_text} This is usually a short API or network hiccup; trying again a moment later normally works.`,
    };
  }
  if (error_kind === 'stalled') return { title: 'Claude stopped mid-translation', body: `The reply stopped arriving.${kept_note}` };
  if (error_kind === 'claude_error' && /authenticat|log ?in|oauth/i.test(message)) {
    return { title: 'Claude CLI is not logged in', body: 'Run `claude auth login` in a terminal, then try again.' };
  }
  if (error_kind === 'claude_error') return { title: 'Claude returned an error', body: `The translation could not finish.${kept_note}` };
  if (error_kind === 'output_limit') {
    return { title: 'The translation was cut off', body: `The text is too long for one reply.${kept_note} Translate the rest separately.` };
  }
  if (error_kind === 'server_unreachable') {
    return { title: "Can't reach the translation server", body: 'Check that `bash start.sh` is still running in its terminal, then try again.' };
  }
  if (error_kind === 'request_rejected') return { title: 'The server rejected the request', body: 'The text could not be sent for translation.' };
  return { title: "Couldn't run Claude", body: `The claude process failed.${kept_note}` };
}

function showErrorAlert(error_kind: PageErrorKind, message: string, has_partial_translation: boolean, silence_text: string): void {
  showAlert({ severity: 'error', ...alertForError(error_kind, message, has_partial_translation, silence_text), detail: message, action: { label: 'Try again', run: translate } });
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
  const day_label = day === 'Today' || day === 'Yesterday' ? day : created.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const partial_note = summary.outcome === 'done' ? '' : ' · partial';
  const choice_label = `${modeNoteOf(summary.mode)}${choiceLabelOf({ model_id: summary.served_model_id, effort: summary.effort })}`;
  return `${summary.source_language.toUpperCase()} → ${summary.target_language.toUpperCase()} · ${day_label} ${time} · ${choice_label}${partial_note}`;
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

// Body: what the endpoint answers (see shared/api.ts); null for a 204.
async function fetchJson<Body>(url: string, options: RequestInit = {}): Promise<Body> {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  return (response.status === 204 ? null : await response.json()) as Body;
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
  try { return localStorage.getItem('is_sidebar_open') !== '0'; } catch { return true; }
}

function writeIsSidebarOpen(is_open: boolean): void {
  try { localStorage.setItem('is_sidebar_open', is_open ? '1' : '0'); } catch {}
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
  const visible_ids = [...history_list.querySelectorAll<HTMLButtonElement>('.history-open-button')].map((button) => Number(button.dataset.entryId));
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
  try { localStorage.setItem('source_language', source_language); } catch {}
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

async function translate(): Promise<void> {
  const text = source_text.value;
  if (text.trim() === '' || text.length > MAX_TEXT_CHARS || translation_settings === null) return;
  const request_settings = translation_settings;
  mode_menu.hidePopover();
  model_menu.hidePopover();
  if (active_request) active_request.abort();
  const request = new AbortController();
  active_request = request;

  const skeleton_bar_count = Math.min(6, Math.max(1, Math.ceil(text.length / CHARS_PER_SKELETON_BAR)));
  skeleton.innerHTML = '<span></span>'.repeat(skeleton_bar_count);
  let unpaired_text = '';
  hideAlert();
  forgetClearedSnapshot();
  setShownHistoryId(null);
  resetPairs();
  shown_result_mode = request_settings.mode;
  setViewMode('edit');
  renderTarget('waiting');

  const started_at = Date.now();
  let retry_note = '';
  const renderProgress = (): void => {
    if (active_request !== request || current_target_state === 'done') return;
    const waited_seconds = Math.floor((Date.now() - started_at) / 1000);
    const waited_note = waited_seconds < 5 ? '' : has_escape_key ? ` ${waited_seconds}s · Esc to cancel` : ` ${waited_seconds}s`;
    const activity_label = thinking_text !== '' && thinking_duration_ms === null ? 'Thinking…' : 'Translating…';
    setRunInfo(retry_note ? `${retry_note}${waited_note}` : `${activity_label}${waited_note}`);
  };
  renderProgress();
  const progress_timer = setInterval(renderProgress, 1000);

  try {
    const response = await fetch('/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source_language, target_language: targetLanguageOf(source_language), text,
        model_id: request_settings.model_id, effort: request_settings.effort, mode: request_settings.mode,
      }),
      signal: request.signal,
    });
    if (!response.ok) throw new Error(await response.text());
    if (response.body === null) throw new Error('The server sent an empty reply.');

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';
      for (const raw_event of events) {
        const stream_event = parseStreamEvent(raw_event);
        const [event_name, data] = stream_event;
        if (isPairEvent(stream_event)) {
          if (event_name === 'pair_start' && data.pair_index === 0) setViewMode('pairs');
          retry_note = '';
          applyPairEvent(stream_event);
          if (current_target_state !== 'streaming') renderTarget('streaming');
        } else if (event_name === 'unpaired_delta') {
          // Text outside pairs: the model ignored the format, so show it the old way; once pairs exist it is a stray note.
          unpaired_text += data.text;
          retry_note = '';
          if (translation_pairs.length === 0) renderTarget('streaming', unpaired_text);
        } else if (event_name === 'thinking_delta') {
          // Opens as the summary starts arriving; a click to close it while thinking is kept.
          setThinking(thinking_text + data.text, null, thinking_text === '' || thinking_block.open);
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
          renderTarget('done', translation_pairs.length > 0 ? '' : unpaired_text);
          setShownHistoryId(data.history_id);
          if (history_sidebar.open) loadHistory();
          setRunInfo(runInfoTextOf({ outcome: 'done', has_output: true, ...data }));
          refreshQuotaWarning();
          const source_divergence = translation_pairs.length > 0
            ? findSourceDivergence(text, translation_pairs)
            : null;
          if (source_divergence !== null) {
            showAlert({
              severity: 'warning',
              title: 'The left column differs from your input',
              body: 'Claude changed or skipped some of your words in the left column. Check that spot, or translate again.',
              detail: `Yours: “${source_divergence.input_excerpt}” · Left column: ${source_divergence.source_excerpt === '' ? 'ends here' : `“${source_divergence.source_excerpt}”`}`,
              action: { label: 'Translate again', run: translate },
            });
          }
        } else if (event_name === 'error') {
          setStreamingCell(null);
          const has_output = translation_pairs.length > 0 || unpaired_text.trim() !== '';
          renderTarget(has_output ? 'done' : 'empty', translation_pairs.length > 0 ? '' : unpaired_text);
          setRunInfo(runInfoTextOf({ outcome: 'error', has_output }));
          showErrorAlert(data.error_kind, data.message, has_output, silenceTextOf(request_settings.model_id, data.served_model_id, data.is_fallback));
          refreshQuotaWarning();
          setShownHistoryId(data.history_id);
          if (history_sidebar.open) loadHistory();
        }
      }
    }
  } catch (error) {
    if (!(error instanceof Error && error.name === 'AbortError')) {
      setStreamingCell(null);
      const has_output = translation_pairs.length > 0 || unpaired_text.trim() !== '';
      renderTarget(has_output ? 'done' : 'empty', translation_pairs.length > 0 ? '' : unpaired_text);
      setRunInfo(runInfoTextOf({ outcome: 'error', has_output }));
      // fetch rejects with a TypeError only when the server cannot be reached at all.
      showErrorAlert(error instanceof TypeError ? 'server_unreachable' : 'request_rejected', errorText(error), has_output, '');
    }
  } finally {
    clearInterval(progress_timer);
    if (active_request === request) active_request = null;
  }
}

// One Server-Sent Event block from POST /translate, as the server wrote it (see shared/api.ts StreamEvents).
function parseStreamEvent(raw_event: string): StreamEvent {
  const event_name = /^event: (.*)$/m.exec(raw_event)?.[1];
  const data_json = /^data: (.*)$/m.exec(raw_event)?.[1];
  if (event_name === undefined || data_json === undefined) throw new Error(`Malformed server event: ${raw_event}`);
  return [event_name, JSON.parse(data_json)] as StreamEvent;
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
const TRANSLATION_SETTINGS_STORAGE_KEY = 'translation_settings';
const MENU_CHECK_ICON = '<svg class="menu-option-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const QUOTA_WINDOW_LABELS: Record<string, string> = { seven_day: 'Weekly', five_hour: '5-hour' };
const mode_button = requiredElement('#mode-button', HTMLButtonElement);
const mode_button_label = requiredElement('#mode-button-label', HTMLSpanElement);
const mode_menu = requiredElement('#mode-menu', HTMLDivElement);
const model_picker_button = requiredElement('#model-picker-button', HTMLButtonElement);
const model_picker_label_full = requiredElement('#model-picker-label-full', HTMLSpanElement);
const model_picker_label_short = requiredElement('#model-picker-label-short', HTMLSpanElement);
const model_picker_effort_glyph = requiredElement('#model-picker-effort-glyph', SVGSVGElement);
const model_menu = requiredElement('#model-menu', HTMLDivElement);
// GET /translation-options: the models, efforts and modes the server accepts, and its latest quota warning.
// Written only by loadTranslationOptions.
let translation_options: TranslationOptions | null = null;
// { model_id, effort, mode } the next translation runs with. Written only by setTranslationSettings.
let translation_settings: TranslationSettings | null = null;

// The options once loaded; the menus and pickers are built only after that.
function loadedOptions(): TranslationOptions {
  if (translation_options === null) throw new Error('The translation options have not loaded yet.');
  return translation_options;
}

function currentSettings(): TranslationSettings {
  if (translation_settings === null) throw new Error('The translation settings have not loaded yet.');
  return translation_settings;
}

// The value a menu row's data attribute names, checked against what the server offers.
function offeredValueOf<Value extends string>(offered: Value[], value: string | undefined): Value {
  const found = offered.find((candidate) => candidate === value);
  if (found === undefined) throw new Error(`The menu offers no ${value}`);
  return found;
}

function modeOfRow(row: HTMLElement): Mode {
  return offeredValueOf(loadedOptions().modes.map((option) => option.mode), row.dataset.mode);
}

function modelIdOfRow(row: HTMLElement): string {
  return offeredValueOf(loadedOptions().models.map((option) => option.model_id), row.dataset.modelId);
}

function effortOfSegment(segment: HTMLElement): Effort {
  return offeredValueOf(loadedOptions().efforts.map((option) => option.effort), segment.dataset.effort);
}

// The row index an arrow, Home or End key moves to in a list of row_count rows; undefined for any other key.
function arrowTargetOf(key: string, focused_index: number, row_count: number): number | undefined {
  const targets: Record<string, number> = { ArrowDown: focused_index + 1, ArrowUp: focused_index - 1, Home: 0, End: row_count - 1 };
  return targets[key];
}

// Called once at load: the options do not change while the page is open.
async function loadTranslationOptions(): Promise<void> {
  translation_options = await fetchJson<TranslationOptions>('/translation-options');
  renderModeMenu();
  renderModelMenu();
  renderQuotaWarning(loadedOptions().quota_warning);
  setTranslationSettings(readTranslationSettings());
}

// After every translation, whose reply carries the current quota. Only the quota line changes, so focus inside an
// open menu is kept; if the fetch fails the line keeps its last state.
function refreshQuotaWarning(): void {
  fetchJson<TranslationOptions>('/translation-options').then((options) => renderQuotaWarning(options.quota_warning)).catch(() => {});
}

function renderQuotaWarning(quota_warning: QuotaWarning | null): void {
  const quota_line = requiredElement('.model-menu-quota', HTMLDivElement, model_menu);
  quota_line.hidden = quota_warning === null;
  requiredElement('.model-menu-quota-text', HTMLSpanElement, quota_line).innerHTML = quota_warning === null ? '' : quotaWarningHtml(quota_warning);
}

// A stored model, effort or mode the server no longer offers falls back to its default, so a removed one never sticks.
function readTranslationSettings(): TranslationSettings {
  let stored: Partial<TranslationSettings> | null = null;
  try { stored = JSON.parse(localStorage.getItem(TRANSLATION_SETTINGS_STORAGE_KEY) ?? 'null') as Partial<TranslationSettings> | null; } catch {}
  const has_model = loadedOptions().models.some((option) => option.model_id === stored?.model_id);
  const has_effort = loadedOptions().efforts.some((option) => option.effort === stored?.effort);
  const has_mode = loadedOptions().modes.some((option) => option.mode === stored?.mode);
  return {
    model_id: has_model && stored?.model_id ? stored.model_id : loadedOptions().default_model_id,
    effort: has_effort && stored?.effort ? stored.effort : loadedOptions().default_effort,
    mode: has_mode && stored?.mode ? stored.mode : loadedOptions().default_mode,
  };
}

function setTranslationSettings(next_settings: TranslationSettings): void {
  translation_settings = next_settings;
  try { localStorage.setItem(TRANSLATION_SETTINGS_STORAGE_KEY, JSON.stringify(next_settings)); } catch {}
  renderModePicker();
  renderModelPicker();
}

// The id itself for a model no longer offered (a history entry can name one), or while the options failed to load:
// history and run info must still render then.
function modelLabelOf(model_id: string): string {
  return translation_options?.models.find((option) => option.model_id === model_id)?.label ?? model_id;
}

function effortOptionOf(effort: string): EffortOption | undefined {
  return translation_options?.efforts.find((option) => option.effort === effort);
}

function modeLabelOf(mode: string): string {
  return translation_options?.modes.find((option) => option.mode === mode)?.label ?? mode;
}

// "Sonnet 5.5 · Low": the one wording of a model and effort, used by the trigger, history run info and tooltips.
function choiceLabelOf({ model_id, effort }: { model_id: string; effort: string }): string {
  return `${modelLabelOf(model_id)} · ${effortOptionOf(effort)?.label ?? effort}`;
}

// "Markdown · " for a history entry's mode; '' for the default mode, which most entries use, or none.
function modeNoteOf(mode: Mode | undefined): string {
  const is_default_mode = translation_options === null || mode === undefined || mode === loadedOptions().default_mode;
  return is_default_mode ? '' : `${modeLabelOf(mode)} · `;
}

// "Weekly limit 94% used · resets Mon 06:00"
function quotaWarningHtml({ rate_limit_type, utilization, resets_at }: QuotaWarning): string {
  const window_label = QUOTA_WINDOW_LABELS[rate_limit_type ?? ''] ?? 'Usage';
  const percent_text = typeof utilization === 'number' ? `<strong>${Math.round(utilization * 100)}%</strong> used` : 'nearly used';
  const resets_text = typeof resets_at === 'number'
    ? ` · resets ${new Date(resets_at * 1000).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`
    : '';
  return `${window_label} limit ${percent_text}${resets_text}`;
}

// Labels and descriptions come from the server's own constants, so they are trusted markup.
function menuOptionMarkup({ data_attribute, value, label, description, is_default }: {
  data_attribute: string; value: string; label: string; description: string; is_default: boolean;
}): string {
  return `
    <button class="menu-option" role="menuitemradio" ${data_attribute}="${value}" tabindex="-1">
      <span><span class="menu-option-name">${label}${is_default ? '<span class="menu-option-default">Default</span>' : ''}</span>
      <span class="menu-option-description">${description}</span></span>${MENU_CHECK_ICON}
    </button>`;
}

function renderModeMenu(): void {
  const mode_rows = loadedOptions().modes.map((option) => menuOptionMarkup({
    data_attribute: 'data-mode', value: option.mode, label: option.label, description: option.description,
    is_default: option.mode === loadedOptions().default_mode,
  })).join('');
  mode_menu.innerHTML = `
    <div class="menu-label" aria-hidden="true">Mode<span class="menu-keys">↑ ↓</span></div>
    <div role="group" aria-label="Mode">${mode_rows}</div>`;
}

function renderModelMenu(): void {
  const model_rows = loadedOptions().models.map((option) => menuOptionMarkup({
    data_attribute: 'data-model-id', value: option.model_id, label: option.label, description: option.description,
    is_default: option.model_id === loadedOptions().default_model_id,
  })).join('');
  const effort_segments = loadedOptions().efforts.map((option) =>
    `<button class="effort-option" role="menuitemradio" data-effort="${option.effort}" tabindex="-1">${option.label}</button>`).join('');
  model_menu.innerHTML = `
    <div class="menu-label" aria-hidden="true">Model<span class="menu-keys">↑ ↓</span></div>
    <div role="group" aria-label="Model">${model_rows}</div>
    <div class="model-menu-separator" role="separator"></div>
    <div class="menu-label" aria-hidden="true">Effort<span class="menu-keys">← →</span></div>
    <div class="effort-control" role="group" aria-label="Effort">
      <div class="effort-segments">${effort_segments}</div>
      <p class="effort-description" id="effort-description"></p>
    </div>
    <div class="model-menu-quota" hidden>
      <span class="quota-mark" aria-hidden="true"></span>
      <span class="model-menu-quota-text"></span>
    </div>`;
}

// Signal bars, one per effort offered, the chosen one and those below it filled.
function effortGlyphMarkup(effort: string): string {
  const efforts = loadedOptions().efforts.map((option) => option.effort);
  const filled_count = efforts.findIndex((offered_effort) => offered_effort === effort) + 1;
  const bar_step = 13 / efforts.length;
  return efforts.map((_, index) => {
    const bar_height = 4 + (8 * index) / Math.max(1, efforts.length - 1);
    return `<rect x="${index * bar_step}" y="${12 - bar_height}" width="3" height="${bar_height}" rx="1" class="${index < filled_count ? 'is-filled' : ''}"/>`;
  }).join('');
}

function renderModePicker(): void {
  const mode_label = modeLabelOf(currentSettings().mode);
  mode_button_label.textContent = mode_label;
  mode_button.title = `Mode: ${mode_label}`;
  mode_button.setAttribute('aria-label', `Mode: ${mode_label}`);
  for (const row of mode_menu.querySelectorAll<HTMLElement>('.menu-option')) row.setAttribute('aria-checked', String(row.dataset.mode === currentSettings().mode));
}

function renderModelPicker(): void {
  const model_option = loadedOptions().models.find((option) => option.model_id === currentSettings().model_id);
  const effort_option = effortOptionOf(currentSettings().effort);
  if (model_option === undefined || effort_option === undefined) throw new Error(`Unknown setting ${choiceLabelOf(currentSettings())}`);
  const short_label = model_option.short_label;
  model_picker_label_full.textContent = choiceLabelOf(currentSettings());
  model_picker_label_short.textContent = `${short_label} · ${effort_option.label}`;
  model_picker_effort_glyph.innerHTML = effortGlyphMarkup(currentSettings().effort);
  model_picker_button.title = `${choiceLabelOf(currentSettings())} (⌘/)`;
  model_picker_button.setAttribute('aria-label', `Model and effort: ${choiceLabelOf(currentSettings())}`);
  for (const row of model_menu.querySelectorAll<HTMLElement>('.menu-option')) row.setAttribute('aria-checked', String(row.dataset.modelId === currentSettings().model_id));
  for (const segment of model_menu.querySelectorAll<HTMLElement>('.effort-option')) segment.setAttribute('aria-checked', String(segment.dataset.effort === currentSettings().effort));
  requiredElement('#effort-description', HTMLParagraphElement, model_menu).textContent = effort_option.description;
}

// The model menu's stops in arrow order: every model row, then the checked effort segment as one stop.
function modelMenuStops(): HTMLElement[] {
  return [...model_menu.querySelectorAll<HTMLElement>('.menu-option'), requiredElement('.effort-option[aria-checked="true"]', HTMLButtonElement, model_menu)];
}

function stepEffort(step: number): void {
  const efforts = loadedOptions().efforts.map((option) => option.effort);
  const next_index = Math.max(0, Math.min(efforts.length - 1, efforts.indexOf(currentSettings().effort) + step));
  const was_on_effort = document.activeElement?.classList.contains('effort-option');
  setTranslationSettings({ ...currentSettings(), effort: efforts[next_index] });
  if (was_on_effort) requiredElement('.effort-option[aria-checked="true"]', HTMLButtonElement, model_menu).focus();
}

// An open menu focuses its checked row. Esc and a click outside close the popover natively; focus returns to the
// trigger only if it was in the menu.
for (const [menu, trigger] of [[mode_menu, mode_button], [model_menu, model_picker_button]]) {
  menu.addEventListener('toggle', (event) => {
    const is_open = (event as ToggleEvent).newState === 'open';
    trigger.setAttribute('aria-expanded', String(is_open));
    if (is_open) requiredElement('.menu-option[aria-checked="true"]', HTMLButtonElement, menu).focus();
  });
  menu.addEventListener('beforetoggle', (event) => {
    if ((event as ToggleEvent).newState === 'closed' && menu.contains(document.activeElement)) queueMicrotask(() => trigger.focus());
  });
}

mode_menu.addEventListener('click', (event) => {
  const mode_row = eventElement(event)?.closest<HTMLElement>('.menu-option');
  if (!mode_row) return;
  setTranslationSettings({ ...currentSettings(), mode: modeOfRow(mode_row) });
  mode_menu.hidePopover();
});
mode_menu.addEventListener('keydown', (event) => {
  const rows = [...mode_menu.querySelectorAll<HTMLElement>('.menu-option')];
  const focused_index = rows.findIndex((row) => row === document.activeElement);
  const target_index = arrowTargetOf(event.key, focused_index, rows.length);
  if (target_index !== undefined) {
    event.preventDefault();
    rows[Math.max(0, Math.min(rows.length - 1, target_index))].focus();
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    const mode_row = document.activeElement?.closest<HTMLElement>('.menu-option');
    if (mode_row) setTranslationSettings({ ...currentSettings(), mode: modeOfRow(mode_row) });
    mode_menu.hidePopover();
  } else if (event.key === 'Tab') {
    // The menu lives at the end of the DOM; Tab goes on from its chip instead.
    event.preventDefault();
    (event.shiftKey ? mode_button : model_picker_button).focus();
    mode_menu.hidePopover();
  }
});

model_menu.addEventListener('click', (event) => {
  const model_row = eventElement(event)?.closest<HTMLElement>('.menu-option');
  const effort_segment = eventElement(event)?.closest<HTMLElement>('.effort-option');
  if (model_row) {
    setTranslationSettings({ ...currentSettings(), model_id: modelIdOfRow(model_row) });
    model_menu.hidePopover();
  } else if (effort_segment) {
    // An effort is a setting, not a command: the menu stays open.
    setTranslationSettings({ ...currentSettings(), effort: effortOfSegment(effort_segment) });
  }
});
model_menu.addEventListener('keydown', (event) => {
  const stops = modelMenuStops();
  const focused_index = stops.findIndex((stop) => stop === document.activeElement);
  const target_index = arrowTargetOf(event.key, focused_index, stops.length);
  if (target_index !== undefined) {
    event.preventDefault();
    stops[Math.max(0, Math.min(stops.length - 1, target_index))].focus();
  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    stepEffort(event.key === 'ArrowRight' ? 1 : -1);
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    const model_row = document.activeElement?.closest<HTMLElement>('.menu-option');
    if (model_row) setTranslationSettings({ ...currentSettings(), model_id: modelIdOfRow(model_row) });
    model_menu.hidePopover();
  } else if (event.key === 'Tab') {
    // Focus leaves before the menu closes, so the close does not send it back to the trigger.
    event.preventDefault();
    // A disabled Translate cannot take focus; the swap button is the next stop after it.
    (event.shiftKey ? model_picker_button : translate_button.disabled ? swap_button : translate_button).focus();
    model_menu.hidePopover();
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
  const open_menu = [mode_menu, model_menu].find((menu) => menu.matches(':popover-open'));
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
    mode_menu.hidePopover();
    model_menu.togglePopover();
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
