// The page: the text box, the translation run and the keyboard. Loaded by translate.html; the server strips its types
// as it serves it. The pairs live in pairs-view.ts, the history in history-sidebar.ts, the alert in alert.ts and the
// settings menus in settings-menus.ts.
import type { ModelRun, Pair } from '../../../shared/api-types.ts';
import { documentIndexOf, parseCellBlocks, renderCellContent } from '../../../shared/web/markdown.ts';
import { readStored, requiredElement, writeStored } from '../../../shared/web/ui.ts';
import type { Language, Mode, Outcome, StreamEvent, TranslatedBlock, Translation } from '../api-types.ts';
import { errorText, hideAlert, isAlertShown, showAlert } from './alert.ts';
import { alertForError, type PageErrorKind } from './alert-text.ts';
import { detectSourceLanguage } from './detect-language.ts';
import {
  closeSidebar, focusHistorySearch, historyTitleOf, initHistorySidebar, isDockedOnStart, isSidebarModal, isSidebarOpen,
  loadHistory, MODE_OF_SOURCE_FORMAT, openSidebar, servedModelOf, setShownHistoryId, shownHistoryId, toggleSidebar,
} from './history-sidebar.ts';
import { composePairsMarkdown } from './pairs-markdown.ts';
import {
  applyPairEvent, copyWithFeedback, isPairEvent, pairs_view, renderStoredPairs, resetPairs, setStreamingCell, shownPairs,
} from './pairs-view.ts';
import {
  choiceLabelOf, closeSettingsMenus, loadTranslationOptions, modeNoteOf, modelLabelOf, openSettingsMenu,
  refreshQuotaWarning, toggleModelMenu, translationSettings,
} from './settings-menus.ts';
import { findSourceDivergence, type SourceDivergence } from './source-check.ts';
import { readStreamEvents } from './stream-events.ts';

type TargetState = 'empty' | 'waiting' | 'streaming' | 'done' | 'error';
// 'edit' shows the textarea and a plain translation; 'pairs' shows the side-by-side pairs.
type ViewMode = 'edit' | 'pairs';

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
const edit_button = requiredElement('#edit-button', HTMLButtonElement);
const undo_clear_button = requiredElement('#undo-clear-button', HTMLButtonElement);
const has_escape_key = !matchMedia('(pointer: coarse)').matches;

let source_language: Language = readStored('source_language') === 'vi' ? 'vi' : 'en';
let is_direction_auto = true;
let active_request: AbortController | null = null;
let current_target_state: TargetState = 'empty';
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
  if (view_mode === 'edit' && shownPairs().length > 0 && current_target_state === 'done') {
    target_text.textContent = composePairsMarkdown(shownPairs(), 'translation');
    target_text.classList.remove('is-empty');
  }
}

// Only a Markdown-mode left column differs from the textarea; elsewhere the text as typed is the source. A column that
// lost words (a cut-off run, or the model dropped some) never stands in for the input.
function isReformattedSourceShown(): boolean {
  if (pairs_view.hidden || shown_result_mode !== 'translate_markdown' || shownPairs().length === 0) return false;
  return findSourceDivergence(source_text.value, shownPairs()) === null;
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

// How a stored run ended, in the words of a live run's outcome. A run still going (another tab's) reads as stopped.
function outcomeOf(run: Pick<ModelRun, 'status'>): Outcome {
  if (run.status === 'succeeded') return 'done';
  if (run.status === 'cancelled') return 'cancelled';
  return 'error';
}

// A stored block as the live stream's pair, so it is drawn by the same path.
function pairOf(block: TranslatedBlock): Pair {
  return {
    pair_type: block.blockType,
    level: block.level,
    marker: block.marker ?? '',
    source_text: block.sourceText,
    translation_text: block.translatedText,
  };
}

// Shows a stored translation without calling Claude. Text typed but never translated is kept for Undo,
// the same way Clear keeps it. Assigning .value fires no input event, so detection keeps the stored direction.
function showHistoryEntry(translation: Translation): void {
  if (active_request) active_request.abort();
  hideAlert();
  const has_unsaved_input = source_text.value.trim() !== '' && shownHistoryId() === null && current_target_state !== 'done';
  if (has_unsaved_input) {
    cleared_snapshot = snapshotWorkspace();
    undo_clear_button.hidden = false;
  } else {
    forgetClearedSnapshot();
  }
  const { run } = translation;
  const pairs = translation.blocks.map(pairOf);
  const text_outside_blocks = translation.textOutsideBlocks ?? '';
  const mode = MODE_OF_SOURCE_FORMAT[translation.sourceFormat];
  source_text.value = translation.sourceText;
  source_language = translation.sourceLanguage;
  is_direction_auto = false;
  renderLanguages();
  renderSource();
  renderStoredPairs(pairs);
  renderTarget('done', pairs.length > 0 ? '' : text_outside_blocks);
  shown_result_mode = mode;
  setThinking(run.thinkingText ?? '', run.thinkingMs, false);
  // The run's duration is worked out, never stored: finishedAt - startedAt.
  const finished_at = run.finishedAt ?? run.startedAt;
  const run_info: RunInfo = {
    outcome: outcomeOf(run),
    has_output: pairs.length > 0 || text_outside_blocks !== '',
    duration_ms: Date.parse(finished_at) - Date.parse(run.startedAt),
    served_model_id: servedModelOf(run),
    effort: run.effort ?? '',
    mode,
    is_fallback: run.servedModelId !== null && run.servedModelId !== run.requestedModelId,
    is_from_history: true,
  };
  setRunInfo(`From history · ${runInfoTextOf(run_info)}`);
  setViewMode(pairs.length > 0 ? 'pairs' : 'edit');
  setShownHistoryId(translation.id);
}

function snapshotWorkspace(): WorkspaceSnapshot {
  const translation_pairs = shownPairs();
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
  return shownPairs().length > 0 ? composePairsMarkdown(shownPairs(), 'translation') : target_text.textContent;
}

function composeSourceCopyText(): string {
  return isReformattedSourceShown() ? composePairsMarkdown(shownPairs(), 'source') : source_text.value;
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
  return shownPairs().length > 0 ? '' : unpaired_text;
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
    const has_output = shownPairs().length > 0 || unpaired_text.trim() !== '';
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
      if (shownPairs().length === 0) renderTarget('streaming', unpaired_text);
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
      if (isSidebarOpen()) loadHistory();
      setRunInfo(runInfoTextOf({ outcome: 'done', has_output: true, ...data }));
      refreshQuotaWarning();
      if (shownPairs().length > 0) {
        const source_divergence = findSourceDivergence(text, shownPairs());
        if (source_divergence !== null) showSourceDivergenceAlert(source_divergence);
      }
    } else if (event_name === 'error') {
      const has_output = endFailedRun();
      const silence_text = silenceTextOf(request_settings.model_id, data.served_model_id, data.is_fallback);
      showErrorAlert(data.error_kind, data.message, has_output, silence_text);
      refreshQuotaWarning();
      setShownHistoryId(data.history_id);
      if (isSidebarOpen()) loadHistory();
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
// A reformatted left column is what gets edited, so a second Markdown run starts from it; insertText keeps the
// pasted text one ⌘Z away. Its input event treats the insert as typing, so the entry and direction are put back.
edit_button.addEventListener('click', () => {
  const reformatted_source_text = isReformattedSourceShown() ? composePairsMarkdown(shownPairs(), 'source') : null;
  setViewMode('edit');
  source_text.focus();
  if (reformatted_source_text !== null && reformatted_source_text !== source_text.value) {
    const shown_entry_id = shownHistoryId();
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

function startNewTranslation(): void {
  if (source_text.value !== '') clearWorkspace();
  if (isSidebarModal()) closeSidebar();
  source_text.focus();
}
requiredElement('#new-translation-button', HTMLButtonElement).addEventListener('click', startNewTranslation);
requiredElement('#masthead-new-translation-button', HTMLButtonElement).addEventListener('click', startNewTranslation);
initHistorySidebar({
  showEntry: showHistoryEntry,
  focusSourceText: () => source_text.focus(),
});

document.addEventListener('keydown', (event) => {
  // A modal drawer owns the keyboard: Esc closes it natively, and page shortcuts must not act behind it.
  // The docked sidebar is part of the page, so shortcuts keep working while it is open.
  if (isSidebarModal()) return;
  const has_modifier = event.metaKey || event.ctrlKey;
  const open_menu = openSettingsMenu();
  if (has_modifier && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    focusHistorySearch();
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
if (isDockedOnStart()) {
  openSidebar();
  // show() moves focus into the dialog; the textarea is where typing should start.
  source_text.focus();
}
try {
  await translation_options_load;
} catch (error) {
  showErrorAlert('server_unreachable', errorText(error), false, '');
}
