// The page: the text box, the translation run and the keyboard. Loaded by translate.html; the server strips its types
// as it serves it. The pairs live in pairs-view.ts, the history in history-sidebar.ts, the alert in alert.ts and the
// settings menus in settings-menus.ts.
import type { GenerationDetail, GenerationRequest, ModelRun, TranslatedBlock } from '../../../shared/api-types.ts';
import { ApiError, fetchJson } from '../../../shared/web/fetch-json.ts';
import { documentIndexOf, parseCellBlocks, renderCellContent } from '../../../shared/web/markdown.ts';
import { formatElapsed, readStored, requiredElement, writeStored } from '../../../shared/web/ui.ts';
import type {
  Language, Outcome, RunNotice, SourceFormat, StreamEvent, StreamEvents, TranslateRequest, Translation,
} from '../api-types.ts';
import { errorText, hideAlert, isAlertShown, showAlert } from './alert.ts';
import { alertForError, type PageErrorKind } from './alert-text.ts';
import { detectSourceLanguage } from './detect-language.ts';
import {
  closeSidebar, focusHistorySearch, historyTitleOf, initHistorySidebar, isDockedOnStart, isSidebarModal, isSidebarOpen,
  loadHistory, openSidebar, servedModelOf, setShownHistoryId, shownHistoryId, toggleSidebar,
} from './history-sidebar.ts';
import { composePairsMarkdown } from './pairs-markdown.ts';
import {
  applyBlockEvent, copyWithFeedback, isBlockEvent, pairsView, renderStoredBlocks, replayBlocks, resetPairs, setStreamingCell, shownBlocks,
} from './pairs-view.ts';
import {
  choiceLabelOf, closeSettingsMenus, loadTranslationOptions, sourceFormatNoteOf, modelLabelOf, openSettingsMenu,
  refreshQuotaWarning, toggleModelMenu, translationSettings,
} from './settings-menus.ts';
import { findSourceDivergence, type SourceDivergence } from './source-check.ts';
import { readStreamEvents } from './stream-events.ts';

type TargetState = 'empty' | 'waiting' | 'streaming' | 'done' | 'error';
// 'edit' shows the textarea and a plain translation; 'pairs' shows the side-by-side pairs.
type ViewMode = 'edit' | 'pairs';

// Everything Undo needs to put the workspace back.
interface WorkspaceSnapshot {
  sourceText: string;
  blocks: TranslatedBlock[];
  plainTargetText: string;
  targetState: TargetState;
  runInfo: string;
  viewMode: ViewMode;
  resultSourceFormat: SourceFormat | null;
  thinkingText: string;
  thinkingDurationMs: number | null;
}

// The facts the end-of-run status line is worded from; a failed or cancelled run has only the first two.
interface RunInfo {
  outcome: Outcome;
  hasOutput: boolean;
  durationMs?: number;
  servedModelId?: string;
  effort?: string;
  sourceFormat?: SourceFormat;
  isFallback?: boolean;
  isFromHistory?: boolean;
}

// The run the page is watching. The job is the server's: aborting the stream only stops watching.
interface FollowedRun {
  // The run's row; null only until the first event (the snapshot) of a new run names it.
  translationId: number | null;
  stream: AbortController;
  // Date.now() when the run started on the server, worked out from the snapshot's elapsedMs.
  startedAt: number;
  // The model asked for, which the "sent nothing back" alert names.
  requestedModelId: string;
  // Text outside pairs: the model ignored the format, so it is shown the old way.
  unpairedText: string;
  // "API busy (…), retry 1/3…" or "… is slow, switched to …" until more text arrives; '' otherwise.
  retryNote: string;
}

const LANGUAGE_LABELS: Record<Language, string> = { en: 'English', vi: 'Vietnamese' };
const MAX_TEXT_CHARS = 100_000;
const CHAR_COUNT_VISIBLE_FROM = 16000;
// One placeholder bar per ~70 source chars, roughly one rendered line at 16px in a 1280px layout.
const CHARS_PER_SKELETON_BAR = 70;

const sourceText = requiredElement('#source-text', HTMLTextAreaElement);
const targetText = requiredElement('#target-text', HTMLDivElement);
const targetPane = requiredElement('#target-pane', HTMLElement);
const skeleton = requiredElement('#skeleton', HTMLDivElement);
const sourceLanguageName = requiredElement('#source-language-name', HTMLSpanElement);
const targetLanguageName = requiredElement('#target-language-name', HTMLSpanElement);
const detectedHint = requiredElement('#detected-hint', HTMLSpanElement);
const swapButton = requiredElement('#swap-button', HTMLButtonElement);
const clearButton = requiredElement('#clear-button', HTMLButtonElement);
const translateButton = requiredElement('#translate-button', HTMLButtonElement);
const cancelButton = requiredElement('#cancel-button', HTMLButtonElement);
const copyButton = requiredElement('#copy-button', HTMLButtonElement);
const practiceButton = requiredElement('#practice-button', HTMLButtonElement);
const copySourceButton = requiredElement('#copy-source-button', HTMLButtonElement);
const charCount = requiredElement('#char-count', HTMLSpanElement);
const runInfo = requiredElement('#run-info', HTMLSpanElement);
const runActivity = requiredElement('#run-activity', SVGSVGElement);
const directionBar = requiredElement('#direction-bar', HTMLDivElement);
const panes = requiredElement('.panes', HTMLDivElement);
const editButton = requiredElement('#edit-button', HTMLButtonElement);
const undoClearButton = requiredElement('#undo-clear-button', HTMLButtonElement);
const hasEscapeKey = !matchMedia('(pointer: coarse)').matches;

let sourceLanguage: Language = readStored('source_language') === 'vi' ? 'vi' : 'en';
let isDirectionAuto = true;
// The one run the page is watching; null when the page shows no live run. `followedRun !== null` is the page's one rule
// for "the shown run is live": Esc, Cancel, the read-only box and the disabled Translate all read it. Written only by
// followRun and stopFollowing.
let followedRun: FollowedRun | null = null;
let currentTargetState: TargetState = 'empty';
// What the last Clear removed; null once the user types something else or translates again.
let clearedSnapshot: WorkspaceSnapshot | null = null;
const thinkingBlock = requiredElement('#thinking', HTMLDetailsElement);
const thinkingLabel = requiredElement('#thinking-label', HTMLSpanElement);
const thinkingBody = requiredElement('#thinking-text', HTMLDivElement);
// The mode the result on screen ran in; null when there is none. Written by showRunStarting, showHistoryEntry and
// restoreClearedTranslation.
let shownResultMode: SourceFormat | null = null;
// The thinking summary of the result on screen; '' when there is none. Written only by setThinking.
let thinkingText = '';
// null while the summary is still arriving. Written only by setThinking.
let thinkingDurationMs: number | null = null;

// text '' hides the block; durationMs null shows it as still thinking.
function setThinking(text: string, durationMs: number | null, isOpen: boolean): void {
  thinkingText = text;
  thinkingDurationMs = durationMs;
  const isLive = text !== '' && durationMs === null;
  thinkingBlock.hidden = text === '';
  thinkingBlock.open = isOpen;
  thinkingBlock.classList.toggle('is-live', isLive);
  thinkingLabel.textContent = thinkingLabelOf(text, durationMs);
  const blocks = parseCellBlocks('paragraph', '', 0, text.trim(), { isStreaming: false, linkDefinitions: new Map() });
  renderCellContent(thinkingBody, blocks, {
    side: 'translation',
    blockIndex: -1,
    documentIndex: documentIndexOf([]),
    isStreaming: false,
    isDocumentComplete: true,
  });
}

// "Thinking…" while the summary arrives, then "Thought for 12s".
function thinkingLabelOf(text: string, durationMs: number | null): string {
  if (text === '') return '';
  if (durationMs === null) return 'Thinking…';
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  return `Thought for ${seconds}s`;
}

function isTranslating(): boolean {
  return currentTargetState === 'waiting' || currentTargetState === 'streaming';
}

function setViewMode(viewMode: ViewMode): void {
  // resetPairs empties pairsView, so every view change re-places the block atop the column showing the translation.
  (viewMode === 'pairs' ? pairsView : targetPane).prepend(thinkingBlock);
  panes.hidden = viewMode === 'pairs';
  pairsView.hidden = viewMode !== 'pairs';
  editButton.hidden = viewMode !== 'pairs';
  if (viewMode === 'edit' && shownBlocks().length > 0 && currentTargetState === 'done') {
    targetText.textContent = composePairsMarkdown(shownBlocks(), 'translation');
    targetText.classList.remove('is-empty');
  }
}

// Only a Markdown-mode left column differs from the textarea; elsewhere the text as typed is the source. A column that
// lost words (a cut-off run, or the model dropped some) never stands in for the input.
function isReformattedSourceShown(): boolean {
  if (pairsView.hidden || shownResultMode !== 'markdown' || shownBlocks().length === 0) return false;
  return findSourceDivergence(sourceText.value, shownBlocks()) === null;
}

function showErrorAlert(errorKind: PageErrorKind, message: string, hasPartialTranslation: boolean, silenceText: string): void {
  const { title, body } = alertForError(errorKind, message, hasPartialTranslation, silenceText);
  showAlert({ severity: 'error', title, body, detail: message, action: { label: 'Try again', run: startTranslation } });
}

// "Neither Sonnet 5.5 nor Haiku 5.5 sent anything back." after a fallback, else "Haiku 5.5 sent nothing back."
function silenceTextOf(requestedModelId: string, servedModelId: string, isFallback: boolean): string {
  return isFallback
    ? `Neither ${modelLabelOf(requestedModelId)} nor ${modelLabelOf(servedModelId)} sent anything back.`
    : `${modelLabelOf(servedModelId)} sent nothing back.`;
}

// How a stored run ended, in the words of a live run's outcome. A row still running whose job is gone (its final save
// failed) reads as stopped.
function outcomeOf(run: Pick<ModelRun, 'status'>): Outcome {
  if (run.status === 'succeeded') return 'done';
  if (run.status === 'cancelled') return 'cancelled';
  return 'error';
}

// Text typed but never translated is kept for Undo when an entry replaces it, the same way Clear keeps it.
function keepUnsavedInputForUndo(): void {
  const hasUnsavedInput = sourceText.value.trim() !== '' && shownHistoryId() === null && currentTargetState !== 'done';
  if (hasUnsavedInput) {
    clearedSnapshot = snapshotWorkspace();
    undoClearButton.hidden = false;
  } else {
    forgetClearedSnapshot();
  }
}

// An entry the sidebar opened: a run still going is followed live, any other is shown as stored.
function openEntry(translation: Translation): void {
  if (translation.run.status === 'running') void openLiveRun(translation);
  else showHistoryEntry(translation);
}

// Shows a stored translation without calling Claude. Assigning .value fires no input event, so detection keeps the
// stored direction.
function showHistoryEntry(translation: Translation): void {
  stopFollowing();
  hideAlert();
  keepUnsavedInputForUndo();
  const { run } = translation;
  const pairs = translation.blocks;
  const textOutsideBlocks = translation.textOutsideBlocks ?? '';
  const mode = translation.sourceFormat;
  sourceText.value = translation.sourceText;
  sourceLanguage = translation.sourceLanguage;
  isDirectionAuto = false;
  renderLanguages();
  renderSource();
  renderStoredBlocks(pairs);
  renderTarget('done', pairs.length > 0 ? '' : textOutsideBlocks);
  shownResultMode = mode;
  setThinking(run.thinkingText ?? '', run.thinkingMs, false);
  // The run's duration is worked out, never stored: finishedAt - startedAt.
  const finishedAt = run.finishedAt ?? run.startedAt;
  const runInfo: RunInfo = {
    outcome: outcomeOf(run),
    hasOutput: pairs.length > 0 || textOutsideBlocks !== '',
    durationMs: Date.parse(finishedAt) - Date.parse(run.startedAt),
    servedModelId: servedModelOf(run),
    effort: run.effort ?? '',
    sourceFormat: mode,
    isFallback: run.servedModelId !== null && run.servedModelId !== run.requestedModelId,
    isFromHistory: true,
  };
  setRunInfo(`From history · ${runInfoTextOf(runInfo)}`);
  setViewMode(pairs.length > 0 ? 'pairs' : 'edit');
  setShownEntry(translation.id);
}

function snapshotWorkspace(): WorkspaceSnapshot {
  const translationPairs = shownBlocks();
  return {
    sourceText: sourceText.value,
    // Only the block's own fields, not the cells it is drawn in.
    blocks: translationPairs.map(({ blockType, level, marker, sourceText, translatedText }) => ({ blockType, level, marker, sourceText, translatedText })),
    plainTargetText: translationPairs.length > 0 ? '' : targetText.textContent,
    targetState: currentTargetState === 'done' ? 'done' : 'empty',
    runInfo: currentTargetState === 'done' ? runInfo.textContent : '',
    viewMode: pairsView.hidden ? 'edit' : 'pairs',
    resultSourceFormat: shownResultMode,
    thinkingText: currentTargetState === 'done' ? thinkingText : '',
    thinkingDurationMs: currentTargetState === 'done' ? thinkingDurationMs : null,
  };
}

function forgetClearedSnapshot(): void {
  clearedSnapshot = null;
  undoClearButton.hidden = true;
}

// The one place the end-of-run status line is worded. A live run names the model only after a fallback, since the
// picker already shows the choice; a history entry always names its choice.
function runInfoTextOf({ outcome, hasOutput, durationMs = 0, servedModelId = '', effort = '', sourceFormat: mode, isFallback, isFromHistory }: RunInfo): string {
  if (outcome === 'cancelled') return hasOutput ? 'Cancelled · partial' : 'Cancelled';
  if (outcome === 'error') return hasOutput ? 'Stopped · partial' : 'Failed';
  const seconds = `${(durationMs / 1000).toFixed(1)}s`;
  // The mode leads: the chip shows the next run's mode, and the end of this line is cut at 1280 with the sidebar docked.
  if (isFromHistory) return `${sourceFormatNoteOf(mode)}${seconds} · ${choiceLabelOf({ modelId: servedModelId, effort })}`;
  return isFallback ? `${seconds} · ${modelLabelOf(servedModelId)}` : seconds;
}

function restoreClearedTranslation(): void {
  const snapshot = clearedSnapshot;
  if (snapshot === null) return;
  forgetClearedSnapshot();
  renderStoredBlocks(snapshot.blocks);
  renderTarget(snapshot.targetState, snapshot.plainTargetText);
  shownResultMode = snapshot.resultSourceFormat;
  setThinking(snapshot.thinkingText, snapshot.thinkingDurationMs, false);
  setRunInfo(snapshot.runInfo);
  setViewMode(snapshot.viewMode);
}

function composeCopyText(): string {
  return shownBlocks().length > 0 ? composePairsMarkdown(shownBlocks(), 'translation') : targetText.textContent;
}

function composeSourceCopyText(): string {
  return isReformattedSourceShown() ? composePairsMarkdown(shownBlocks(), 'source') : sourceText.value;
}

function setRunInfo(text: string): void {
  runInfo.textContent = text;
  runInfo.title = text;
}

function targetLanguageOf(language: Language): Language { return language === 'en' ? 'vi' : 'en'; }

function renderLanguages(): void {
  sourceLanguageName.textContent = LANGUAGE_LABELS[sourceLanguage];
  targetLanguageName.textContent = LANGUAGE_LABELS[targetLanguageOf(sourceLanguage)];
  detectedHint.hidden = !isDirectionAuto || sourceText.value.trim() === '';
  writeStored('source_language', sourceLanguage);
}

function renderSource(): void {
  const text = sourceText.value;
  const isOverLimit = text.length > MAX_TEXT_CHARS;
  charCount.textContent = text.length >= CHAR_COUNT_VISIBLE_FROM
    ? `${text.length.toLocaleString('en-US')} / ${MAX_TEXT_CHARS.toLocaleString('en-US')} characters`
    : '';
  charCount.classList.toggle('is-over-limit', isOverLimit);
  clearButton.hidden = text === '';
  copySourceButton.hidden = text === '';
  translateButton.disabled = text.trim() === '' || isOverLimit || followedRun !== null;
}

function renderTarget(targetState: TargetState, text = ''): void {
  currentTargetState = targetState;
  // Every path that drops the result passes here (new run, Esc or error before output, Clear, swap).
  if (targetState === 'empty' || targetState === 'waiting') setThinking('', null, false);
  // The edit view shows only a finished translation, so mid-translation its pane would be empty.
  editButton.disabled = isTranslating();
  // An SVG element has no .hidden property; assigning one would only add a JS field and leave the attribute.
  runActivity.toggleAttribute('hidden', !isTranslating());
  targetPane.classList.toggle('is-waiting', targetState === 'waiting');
  targetText.textContent = text;
  targetText.classList.toggle('is-empty', targetState === 'empty');
  targetText.classList.toggle('is-streaming', targetState === 'streaming');
  targetText.classList.toggle('is-error', targetState === 'error');
  // While translating, Copy keeps its space (invisible) so the status beside it does not jump when it appears.
  copyButton.hidden = targetState === 'empty' || targetState === 'error';
  copyButton.style.visibility = targetState === 'done' ? 'visible' : 'hidden';
  if (targetState === 'empty' || targetState === 'error') setRunInfo('');
  updatePracticeButton();
}

// Every change of the entry on screen goes through here, so the Practice button follows it.
function setShownEntry(historyId: number | null): void {
  setShownHistoryId(historyId);
  updatePracticeButton();
}

// Practice is offered for a finished English post that is saved in the history (docs/practice-from-translation-design.md §7).
function updatePracticeButton(): void {
  const isPractisable = currentTargetState === 'done' && shownHistoryId() !== null && sourceLanguage === 'en' && shownBlocks().length > 0;
  practiceButton.hidden = !isPractisable;
}

// The post's title: its first heading, or else the start of its text.
function postTitleOf(blocks: TranslatedBlock[]): string {
  const heading = blocks.find((block) => block.blockType === 'heading');
  if (heading !== undefined) return heading.sourceText;
  return sourceText.value.trim().slice(0, 80);
}

// Asks Practice to make exercises from the post on screen, and opens the run (or the project it already made) in a new
// tab. The tab is opened at the click, so the browser does not block it as a pop-up.
async function makePractice(): Promise<void> {
  const translationId = shownHistoryId();
  if (translationId === null) return;
  const blocks = shownBlocks();
  const practiceTab = window.open('about:blank', '_blank');
  practiceButton.disabled = true;
  const request: GenerationRequest = {
    translationId,
    title: postTitleOf(blocks),
    sourceLanguage: 'en',
    // Practice wants both texts of each block; an empty one (a code block left as it is, say) teaches nothing.
    blocks: blocks
      .filter((block) => block.sourceText.trim() !== '' && block.translatedText.trim() !== '')
      .map((block) => ({ sourceText: block.sourceText, translatedText: block.translatedText })),
  };
  let practiceUrl: string | null = null;
  try {
    const { generation } = await fetchJson<{ generation: GenerationDetail }>('/api/practice/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    practiceUrl = `/practice#/g/${generation.id}`;
  } catch (error) {
    const isConflict = error instanceof ApiError && error.status === 409;
    if (isConflict && error.code === 'generating') practiceUrl = `/practice#/g/${error.fields.generationId}`;
    else if (isConflict && error.code === 'already_made') practiceUrl = `/practice#/p/${error.fields.projectKey}`;
    else showAlert({ severity: 'error', title: 'Practice could not start', body: 'The exercises were not made.', detail: errorText(error) });
  }
  practiceButton.disabled = false;
  if (practiceUrl === null) {
    practiceTab?.close();
    return;
  }
  if (practiceTab === null) window.open(practiceUrl, '_blank');
  else practiceTab.location.href = practiceUrl;
}

// What the edit view shows after a run: the text that came outside pairs, when no pairs came at all.
function plainTextAfterRun(unpairedText: string): string {
  return shownBlocks().length > 0 ? '' : unpairedText;
}

function showSourceDivergenceAlert(sourceDivergence: SourceDivergence): void {
  const { inputExcerpt, sourceExcerpt } = sourceDivergence;
  const leftColumnText = sourceExcerpt === '' ? 'ends here' : `“${sourceExcerpt}”`;
  showAlert({
    severity: 'warning',
    title: 'The left column differs from your input',
    body: 'Claude changed or skipped some of your words in the left column. Check that spot, or translate again.',
    detail: `Yours: “${inputExcerpt}” · Left column: ${leftColumnText}`,
    action: { label: 'Translate again', run: startTranslation },
  });
}

// Placeholder bars while the first words are on their way: one per CHARS_PER_SKELETON_BAR source chars, 1 to 6.
function showSkeleton(text: string): void {
  const barCount = Math.min(6, Math.max(1, Math.ceil(text.length / CHARS_PER_SKELETON_BAR)));
  skeleton.innerHTML = '<span></span>'.repeat(barCount);
}

// The target pane while a run's first output is on its way.
function showRunStarting(text: string, sourceFormat: SourceFormat): void {
  showSkeleton(text);
  hideAlert();
  resetPairs();
  shownResultMode = sourceFormat;
  setViewMode('edit');
  renderTarget('waiting');
}

// The words of a retry or fallback in the status line.
function noticeTextOf(notice: RunNotice): string {
  if (notice.kind === 'retry') return `API busy (${notice.error}), retry ${notice.attempt}/${notice.maxRetries}…`;
  return `${modelLabelOf(notice.fromModelId)} is slow, switched to ${modelLabelOf(notice.toModelId)}…`;
}

// The status line while the followed run goes on; refreshed every second and on every event that changes it.
function renderProgress(): void {
  if (followedRun === null || currentTargetState === 'done') return;
  const waitedMs = Date.now() - followedRun.startedAt;
  let waitedNote = '';
  if (waitedMs >= 5000) waitedNote = hasEscapeKey ? ` ${formatElapsed(waitedMs)} · Esc to cancel` : ` ${formatElapsed(waitedMs)}`;
  const isThinking = thinkingText !== '' && thinkingDurationMs === null;
  const activityLabel = isThinking ? 'Thinking…' : 'Translating…';
  setRunInfo(`${followedRun.retryNote || activityLabel}${waitedNote}`);
}

// While the page follows a live run the box is read-only and Translate disabled: Translate no longer replaces a run, so a
// second click or ⌘↵ would start a duplicate job of the same text. Cancel stops it (a touch screen has no Esc).
function renderFollowing(): void {
  const isFollowing = followedRun !== null;
  sourceText.readOnly = isFollowing;
  cancelButton.hidden = !isFollowing;
  renderSource();
}

// Stops watching the shown run; the server keeps the job, and the sidebar still shows it as running.
function stopFollowing(): void {
  if (followedRun === null) return;
  followedRun.stream.abort();
  followedRun = null;
  renderFollowing();
}

// Esc and Cancel: asks the server to stop the run on screen. Its `cancelled` event, sent to every page watching, then
// updates this one.
async function cancelShownRun(): Promise<void> {
  const translationId = followedRun?.translationId ?? null;
  if (translationId === null) return;
  try {
    await fetchJson<null>(`/history/${translationId}/cancel`, { method: 'POST' });
  } catch (error) {
    // 409: the run ended meanwhile, and its closing event is on its way.
    const isAlreadyEnded = error instanceof ApiError && error.status === 409;
    if (!isAlreadyEnded) showAlert({ severity: 'error', title: 'Could not cancel', detail: errorText(error) });
  }
}

// Keeps what arrived of a run that failed or was cancelled, and returns whether anything did.
function endStoppedRun(run: FollowedRun, outcome: Outcome): boolean {
  setStreamingCell(null);
  const hasOutput = shownBlocks().length > 0 || run.unpairedText.trim() !== '';
  renderTarget(hasOutput ? 'done' : 'empty', plainTextAfterRun(run.unpairedText));
  setRunInfo(runInfoTextOf({ outcome, hasOutput }));
  return hasOutput;
}

// Draws what the run produced before this page started watching: the blocks replayed as a live run draws them, the last
// cell still streaming, then the thinking and the latest notice.
function showSnapshot(run: FollowedRun, { translation, notice, elapsedMs }: StreamEvents['snapshot']): void {
  run.translationId = translation.id;
  run.startedAt = Date.now() - elapsedMs;
  run.requestedModelId = translation.run.requestedModelId ?? '';
  run.unpairedText = translation.textOutsideBlocks ?? '';
  run.retryNote = notice === null ? '' : noticeTextOf(notice);
  setShownEntry(translation.id);
  // A new run is listed at once, as running, so the sidebar can bring it back after the page leaves it.
  if (isSidebarOpen()) loadHistory();
  const { thinkingText: snapshotThinkingText, thinkingMs } = translation.run;
  const isThinking = snapshotThinkingText !== null && thinkingMs === null;
  setThinking(snapshotThinkingText ?? '', thinkingMs, isThinking);
  if (translation.blocks.length > 0) {
    replayBlocks(translation.blocks);
    setViewMode('pairs');
    renderTarget('streaming');
  } else if (run.unpairedText.trim() !== '') {
    renderTarget('streaming', run.unpairedText);
  }
  renderProgress();
}

// Shows the run as its saved row says, once its stream can tell no more: the run was not live (`finished`), or the stream
// ended without a closing event, which only a stopped server does. The server cannot resume a run, so nothing is retried.
async function showSavedRun(run: FollowedRun): Promise<void> {
  stopFollowing();
  try {
    if (run.translationId === null) throw new Error('The server closed the stream before naming the run.');
    showHistoryEntry(await fetchJson<Translation>(`/history/${run.translationId}`));
  } catch (error) {
    const hasOutput = endStoppedRun(run, 'error');
    showErrorAlert('server_unreachable', errorText(error), hasOutput, '');
  }
}

function handleRunEvent(run: FollowedRun, streamEvent: StreamEvent): void {
  // Events still in the chunk that carried a closing event, or that arrived as the page left the run.
  if (followedRun !== run) return;
  if (isBlockEvent(streamEvent)) {
    const [eventName, data] = streamEvent;
    if (eventName === 'block_start' && data.blockIndex === 0) setViewMode('pairs');
    run.retryNote = '';
    applyBlockEvent(streamEvent);
    if (currentTargetState !== 'streaming') renderTarget('streaming');
    return;
  }
  const [eventName, data] = streamEvent;
  if (eventName === 'snapshot') {
    showSnapshot(run, data);
  } else if (eventName === 'outside_text_delta') {
    run.unpairedText += data.text;
    run.retryNote = '';
    // Once pairs exist, text outside them is a stray note and is not shown.
    if (shownBlocks().length === 0) renderTarget('streaming', run.unpairedText);
  } else if (eventName === 'thinking_delta') {
    // Opens as the summary starts arriving; a click to close it while thinking is kept.
    const isOpen = thinkingText === '' || thinkingBlock.open;
    setThinking(thinkingText + data.text, null, isOpen);
    renderProgress();
  } else if (eventName === 'thinking_done') {
    setThinking(thinkingText, data.durationMs, false);
    renderProgress();
  } else if (eventName === 'retry') {
    run.retryNote = noticeTextOf({ kind: 'retry', ...data });
    renderProgress();
  } else if (eventName === 'fallback') {
    run.retryNote = noticeTextOf({ kind: 'fallback', ...data });
    renderProgress();
  } else if (eventName === 'done') {
    stopFollowing();
    setStreamingCell(null);
    renderTarget('done', plainTextAfterRun(run.unpairedText));
    setShownEntry(data.translationId);
    if (isSidebarOpen()) loadHistory();
    setRunInfo(runInfoTextOf({ outcome: 'done', hasOutput: true, ...data }));
    refreshQuotaWarning();
    if (shownBlocks().length > 0) {
      // The box is read-only while the run is followed, so it still holds the run's text.
      const sourceDivergence = findSourceDivergence(sourceText.value, shownBlocks());
      if (sourceDivergence !== null) showSourceDivergenceAlert(sourceDivergence);
    }
  } else if (eventName === 'error') {
    stopFollowing();
    const hasOutput = endStoppedRun(run, 'error');
    const silenceText = silenceTextOf(run.requestedModelId, data.servedModelId, data.isFallback);
    showErrorAlert(data.errorCode, data.message, hasOutput, silenceText);
    refreshQuotaWarning();
    setShownEntry(data.translationId);
    if (isSidebarOpen()) loadHistory();
  } else if (eventName === 'cancelled') {
    stopFollowing();
    endStoppedRun(run, 'cancelled');
    setShownEntry(data.translationId);
    if (isSidebarOpen()) loadHistory();
  } else if (eventName === 'finished') {
    void showSavedRun(run);
  }
}

// Watches one run until its stream ends. openStream sends the request: POST /translate for a new run, GET .../events to
// re-attach. Both streams start with a snapshot, so a new run and an old one take the same path.
async function followRun(translationId: number | null, openStream: (signal: AbortSignal) => Promise<Response>): Promise<void> {
  const run: FollowedRun = {
    translationId, stream: new AbortController(), startedAt: Date.now(), requestedModelId: '', unpairedText: '', retryNote: '',
  };
  followedRun = run;
  renderFollowing();
  renderProgress();
  const progressTimer = setInterval(renderProgress, 1000);
  try {
    const response = await openStream(run.stream.signal);
    if (response.status === 429) {
      const reason = await response.text();
      stopFollowing();
      renderTarget('empty');
      showAlert({ severity: 'warning', title: 'Too many translations at once', body: reason });
      return;
    }
    if (!response.ok) throw new Error(await response.text());
    if (response.body === null) throw new Error('The server sent an empty reply.');
    await readStreamEvents(response.body, (streamEvent) => handleRunEvent(run, streamEvent));
    if (followedRun === run) await showSavedRun(run);
  } catch (error) {
    // An abort is the page leaving the run (another entry, Clear, ⇄) or its closing event; both have updated the page.
    const isAbort = error instanceof Error && error.name === 'AbortError';
    if (!isAbort) {
      stopFollowing();
      const hasOutput = endStoppedRun(run, 'error');
      // fetch rejects with a TypeError only when the server cannot be reached at all.
      const errorKind = error instanceof TypeError ? 'server_unreachable' : 'request_rejected';
      showErrorAlert(errorKind, errorText(error), hasOutput, '');
    }
  } finally {
    clearInterval(progressTimer);
  }
}

// Translate: a new job on the server. The page follows it; leaving it later does not stop it.
async function startTranslation(): Promise<void> {
  const text = sourceText.value;
  const requestSettings = translationSettings();
  if (followedRun !== null || text.trim() === '' || text.length > MAX_TEXT_CHARS || requestSettings === null) return;
  closeSettingsMenus();
  forgetClearedSnapshot();
  setShownEntry(null);
  showRunStarting(text, requestSettings.sourceFormat);
  const requestBody: TranslateRequest = {
    sourceLanguage,
    targetLanguage: targetLanguageOf(sourceLanguage),
    sourceText: text,
    modelId: requestSettings.modelId,
    effort: requestSettings.effort,
    sourceFormat: requestSettings.sourceFormat,
  };
  await followRun(null, (signal) => fetch('/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
    signal,
  }));
}

// Re-attaches to a run that is still going (started in this tab earlier, or in another): the entry's text and direction
// first, then its events, whose snapshot draws everything so far.
async function openLiveRun(translation: Translation): Promise<void> {
  stopFollowing();
  keepUnsavedInputForUndo();
  sourceText.value = translation.sourceText;
  sourceLanguage = translation.sourceLanguage;
  isDirectionAuto = false;
  renderLanguages();
  setShownEntry(translation.id);
  showRunStarting(translation.sourceText, translation.sourceFormat);
  await followRun(translation.id, (signal) => fetch(`/history/${translation.id}/events`, { signal }));
}

function swapLanguages(): void {
  stopFollowing();
  hideAlert();
  if (currentTargetState === 'done') sourceText.value = composeCopyText();
  resetPairs();
  setViewMode('edit');
  sourceLanguage = targetLanguageOf(sourceLanguage);
  isDirectionAuto = false;
  swapButton.classList.toggle('is-turned');
  renderLanguages();
  renderTarget('empty');
  renderSource();
  sourceText.focus();
}

sourceText.addEventListener('input', () => {
  if (sourceText.value.trim() !== '') {
    sourceLanguage = detectSourceLanguage(sourceText.value);
    isDirectionAuto = true;
  }
  if (followedRun === null && runInfo.textContent.startsWith('Cancelled')) setRunInfo('');
  if (clearedSnapshot && sourceText.value === clearedSnapshot.sourceText) {
    restoreClearedTranslation();
  } else {
    if (clearedSnapshot && sourceText.value !== '') forgetClearedSnapshot();
    setShownEntry(null);
  }
  renderLanguages();
  renderSource();
});
translateButton.addEventListener('click', startTranslation);
cancelButton.addEventListener('click', () => void cancelShownRun());
swapButton.addEventListener('click', swapLanguages);
// A reformatted left column is what gets edited, so a second Markdown run starts from it; insertText keeps the
// pasted text one ⌘Z away. Its input event treats the insert as typing, so the entry and direction are put back.
editButton.addEventListener('click', () => {
  const reformattedSourceText = isReformattedSourceShown() ? composePairsMarkdown(shownBlocks(), 'source') : null;
  setViewMode('edit');
  sourceText.focus();
  if (reformattedSourceText !== null && reformattedSourceText !== sourceText.value) {
    const shownEntryId = shownHistoryId();
    const shownSourceLanguage = sourceLanguage;
    const wasDirectionAuto = isDirectionAuto;
    sourceText.select();
    document.execCommand('insertText', false, reformattedSourceText);
    sourceText.setSelectionRange(0, 0);
    setShownEntry(shownEntryId);
    sourceLanguage = shownSourceLanguage;
    isDirectionAuto = wasDirectionAuto;
    renderLanguages();
  }
});
// Clears the source and the translation, keeping both for Undo. Used by Clear and by New translation. A run on screen
// keeps going; this only stops watching it.
function clearWorkspace(): void {
  stopFollowing();
  hideAlert();
  clearedSnapshot = snapshotWorkspace();
  resetPairs();
  setViewMode('edit');
  // insertText instead of assigning .value keeps the deletion on the undo stack, so ⌘Z restores the text.
  sourceText.focus();
  sourceText.select();
  document.execCommand('insertText', false, '');
  renderTarget('empty');
  setShownEntry(null);
  if (clearedSnapshot.sourceText !== '') undoClearButton.hidden = false;
}

clearButton.addEventListener('click', clearWorkspace);
undoClearButton.addEventListener('click', () => {
  if (!clearedSnapshot) return;
  sourceText.focus();
  sourceText.select();
  // Same path as ⌘Z: refilling the cleared text makes the input handler restore the translation.
  document.execCommand('insertText', false, clearedSnapshot.sourceText);
});
// One footer line (75% of the text width at 7pt) holds about 110 characters; margin boxes cannot clip a longer title.
const PRINT_TITLE_MAX_CHARS = 90;
const APP_TITLE = document.title;

// JSON.stringify would not do: CSS reads its \n escape as the letter n.
function cssStringOf(text: string): string {
  return `"${text.replace(/\s+/g, ' ').replace(/["\\]/g, '\\$&')}"`;
}

function truncateAtWord(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${lastSpace > 0 ? cut.slice(0, lastSpace) : cut}…`;
}

// Page-margin boxes cannot read the DOM, so the running header reads custom properties set here.
// Chrome offers document.title as the Save as PDF file name.
window.addEventListener('beforeprint', () => {
  const printTitle = truncateAtWord(historyTitleOf(sourceText.value), PRINT_TITLE_MAX_CHARS);
  const rootStyle = document.documentElement.style;
  rootStyle.setProperty('--print-title', cssStringOf(printTitle));
  rootStyle.setProperty('--print-source-language', cssStringOf(LANGUAGE_LABELS[sourceLanguage]));
  rootStyle.setProperty('--print-target-language', cssStringOf(LANGUAGE_LABELS[targetLanguageOf(sourceLanguage)]));
  if (printTitle !== '') document.title = `${printTitle} · ${APP_TITLE}`;
});
window.addEventListener('afterprint', () => { document.title = APP_TITLE; });
window.addEventListener('scroll', () => {
  directionBar.classList.toggle('is-stuck', directionBar.getBoundingClientRect().top <= 0 && window.scrollY > 0);
}, { passive: true });
copyButton.addEventListener('click', () => copyWithFeedback(copyButton, composeCopyText()));
practiceButton.addEventListener('click', () => void makePractice());
copySourceButton.addEventListener('click', () => copyWithFeedback(copySourceButton, composeSourceCopyText()));

function startNewTranslation(): void {
  if (sourceText.value !== '') clearWorkspace();
  if (isSidebarModal()) closeSidebar();
  sourceText.focus();
}
requiredElement('#new-translation-button', HTMLButtonElement).addEventListener('click', startNewTranslation);
requiredElement('#masthead-new-translation-button', HTMLButtonElement).addEventListener('click', startNewTranslation);
initHistorySidebar({
  showEntry: openEntry,
  focusSourceText: () => sourceText.focus(),
});

document.addEventListener('keydown', (event) => {
  // A modal drawer owns the keyboard: Esc closes it natively, and page shortcuts must not act behind it.
  // The docked sidebar is part of the page, so shortcuts keep working while it is open.
  if (isSidebarModal()) return;
  const hasModifier = event.metaKey || event.ctrlKey;
  const openMenu = openSettingsMenu();
  if (hasModifier && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    focusHistorySearch();
  } else if (hasModifier && event.key === '\\') {
    event.preventDefault();
    toggleSidebar();
  } else if (hasModifier && event.key === '/') {
    event.preventDefault();
    toggleModelMenu();
  } else if (event.key === 'Escape' && openMenu !== undefined) {
    // The one place Esc is ordered: an open menu closes first, then a running translation is cancelled.
    openMenu.hidePopover();
  } else if (event.key === 'Escape' && followedRun !== null) {
    event.preventDefault();
    void cancelShownRun();
  } else if (event.key === 'Escape' && isAlertShown()) {
    hideAlert();
  } else if (hasModifier && event.key === 'Enter') {
    event.preventDefault();
    startTranslation();
  } else if (hasModifier && event.shiftKey && event.key.toLowerCase() === 's') {
    event.preventDefault();
    swapLanguages();
  }
});

renderLanguages();
renderSource();
// Started before the sidebar fetches history, whose tooltips name models, but awaited only after the sidebar has
// docked: awaiting first let a frame paint without it, and the page shifted when it docked.
const translationOptionsLoad = loadTranslationOptions();
if (isDockedOnStart()) {
  openSidebar();
  // show() moves focus into the dialog; the textarea is where typing should start.
  sourceText.focus();
}
try {
  await translationOptionsLoad;
} catch (error) {
  showErrorAlert('server_unreachable', errorText(error), false, '');
}
