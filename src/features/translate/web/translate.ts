// The page: the text box, the translation run and the keyboard. Loaded by translate.html; the server strips its types
// as it serves it. The pairs live in pairs-view.ts, the history in history-sidebar.ts, the alert in alert.ts and the
// settings menus in settings-menus.ts.
import type { ModelRun, TranslatedBlock } from '../../../shared/api-types.ts';
import { documentIndexOf, parseCellBlocks, renderCellContent } from '../../../shared/web/markdown.ts';
import { readStored, requiredElement, writeStored } from '../../../shared/web/ui.ts';
import type { Language, Outcome, SourceFormat, StreamEvent, TranslateRequest, Translation } from '../api-types.ts';
import { errorText, hideAlert, isAlertShown, showAlert } from './alert.ts';
import { alertForError, type PageErrorKind } from './alert-text.ts';
import { detectSourceLanguage } from './detect-language.ts';
import {
  closeSidebar, focusHistorySearch, historyTitleOf, initHistorySidebar, isDockedOnStart, isSidebarModal, isSidebarOpen,
  loadHistory, openSidebar, servedModelOf, setShownHistoryId, shownHistoryId, toggleSidebar,
} from './history-sidebar.ts';
import { composePairsMarkdown } from './pairs-markdown.ts';
import {
  applyBlockEvent, copyWithFeedback, isBlockEvent, pairsView, renderStoredBlocks, resetPairs, setStreamingCell, shownBlocks,
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
const copyButton = requiredElement('#copy-button', HTMLButtonElement);
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
let activeRequest: AbortController | null = null;
let currentTargetState: TargetState = 'empty';
// What the last Clear removed; null once the user types something else or translates again.
let clearedSnapshot: WorkspaceSnapshot | null = null;
const thinkingBlock = requiredElement('#thinking', HTMLDetailsElement);
const thinkingLabel = requiredElement('#thinking-label', HTMLSpanElement);
const thinkingBody = requiredElement('#thinking-text', HTMLDivElement);
// The mode the result on screen ran in; null when there is none. Written by translate, showHistoryEntry and
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
  showAlert({ severity: 'error', title, body, detail: message, action: { label: 'Try again', run: translate } });
}

// "Neither Sonnet 5.5 nor Haiku 5.5 sent anything back." after a fallback, else "Haiku 5.5 sent nothing back."
function silenceTextOf(requestedModelId: string, servedModelId: string, isFallback: boolean): string {
  return isFallback
    ? `Neither ${modelLabelOf(requestedModelId)} nor ${modelLabelOf(servedModelId)} sent anything back.`
    : `${modelLabelOf(servedModelId)} sent nothing back.`;
}

// How a stored run ended, in the words of a live run's outcome. A run still going (another tab's) reads as stopped.
function outcomeOf(run: Pick<ModelRun, 'status'>): Outcome {
  if (run.status === 'succeeded') return 'done';
  if (run.status === 'cancelled') return 'cancelled';
  return 'error';
}

// Shows a stored translation without calling Claude. Text typed but never translated is kept for Undo,
// the same way Clear keeps it. Assigning .value fires no input event, so detection keeps the stored direction.
function showHistoryEntry(translation: Translation): void {
  if (activeRequest) activeRequest.abort();
  hideAlert();
  const hasUnsavedInput = sourceText.value.trim() !== '' && shownHistoryId() === null && currentTargetState !== 'done';
  if (hasUnsavedInput) {
    clearedSnapshot = snapshotWorkspace();
    undoClearButton.hidden = false;
  } else {
    forgetClearedSnapshot();
  }
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
  setShownHistoryId(translation.id);
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
function runInfoTextOf({ outcome, hasOutput, durationMs: durationMs = 0, servedModelId: servedModelId = '', effort = '', sourceFormat: mode, isFallback, isFromHistory }: RunInfo): string {
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
  translateButton.disabled = text.trim() === '' || isOverLimit;
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
}

function cancelTranslation(): void {
  if (!activeRequest) return;
  activeRequest.abort();
  activeRequest = null;
  setStreamingCell(null);
  const hasOutput = currentTargetState === 'streaming';
  renderTarget(hasOutput ? 'done' : 'empty', hasOutput ? targetText.textContent : '');
  setRunInfo(runInfoTextOf({ outcome: 'cancelled', hasOutput }));
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
    action: { label: 'Translate again', run: translate },
  });
}

// Placeholder bars while the first words are on their way: one per CHARS_PER_SKELETON_BAR source chars, 1 to 6.
function showSkeleton(text: string): void {
  const barCount = Math.min(6, Math.max(1, Math.ceil(text.length / CHARS_PER_SKELETON_BAR)));
  skeleton.innerHTML = '<span></span>'.repeat(barCount);
}

async function translate(): Promise<void> {
  const text = sourceText.value;
  const requestSettings = translationSettings();
  if (text.trim() === '' || text.length > MAX_TEXT_CHARS || requestSettings === null) return;
  closeSettingsMenus();
  if (activeRequest) activeRequest.abort();
  const request = new AbortController();
  activeRequest = request;

  showSkeleton(text);
  hideAlert();
  forgetClearedSnapshot();
  setShownHistoryId(null);
  resetPairs();
  shownResultMode = requestSettings.sourceFormat;
  setViewMode('edit');
  renderTarget('waiting');

  // Text outside pairs: the model ignored the format, so it is shown the old way.
  let unpairedText = '';
  // "API busy (…), retry 1/3…" or "… is slow, switched to …" until more text arrives; '' otherwise.
  let retryNote = '';
  const startedAt = Date.now();

  // The status line while the run goes on; refreshed every second and on every event that changes it.
  const renderProgress = (): void => {
    if (activeRequest !== request || currentTargetState === 'done') return;
    const waitedSeconds = Math.floor((Date.now() - startedAt) / 1000);
    let waitedNote = '';
    if (waitedSeconds >= 5) waitedNote = hasEscapeKey ? ` ${waitedSeconds}s · Esc to cancel` : ` ${waitedSeconds}s`;
    const isThinking = thinkingText !== '' && thinkingDurationMs === null;
    const activityLabel = isThinking ? 'Thinking…' : 'Translating…';
    setRunInfo(`${retryNote || activityLabel}${waitedNote}`);
  };

  // Keeps what arrived, and returns whether anything did.
  const endFailedRun = (): boolean => {
    setStreamingCell(null);
    const hasOutput = shownBlocks().length > 0 || unpairedText.trim() !== '';
    renderTarget(hasOutput ? 'done' : 'empty', plainTextAfterRun(unpairedText));
    setRunInfo(runInfoTextOf({ outcome: 'error', hasOutput }));
    return hasOutput;
  };

  const handleStreamEvent = (streamEvent: StreamEvent): void => {
    if (isBlockEvent(streamEvent)) {
      const [eventName, data] = streamEvent;
      if (eventName === 'block_start' && data.blockIndex === 0) setViewMode('pairs');
      retryNote = '';
      applyBlockEvent(streamEvent);
      if (currentTargetState !== 'streaming') renderTarget('streaming');
      return;
    }
    const [eventName, data] = streamEvent;
    if (eventName === 'outside_text_delta') {
      unpairedText += data.text;
      retryNote = '';
      // Once pairs exist, text outside them is a stray note and is not shown.
      if (shownBlocks().length === 0) renderTarget('streaming', unpairedText);
    } else if (eventName === 'thinking_delta') {
      // Opens as the summary starts arriving; a click to close it while thinking is kept.
      const isOpen = thinkingText === '' || thinkingBlock.open;
      setThinking(thinkingText + data.text, null, isOpen);
      renderProgress();
    } else if (eventName === 'thinking_done') {
      setThinking(thinkingText, data.durationMs, false);
      renderProgress();
    } else if (eventName === 'retry') {
      retryNote = `API busy (${data.error}), retry ${data.attempt}/${data.maxRetries}…`;
      renderProgress();
    } else if (eventName === 'fallback') {
      retryNote = `${modelLabelOf(data.fromModelId)} is slow, switched to ${modelLabelOf(data.toModelId)}…`;
      renderProgress();
    } else if (eventName === 'done') {
      setStreamingCell(null);
      renderTarget('done', plainTextAfterRun(unpairedText));
      setShownHistoryId(data.translationId);
      if (isSidebarOpen()) loadHistory();
      setRunInfo(runInfoTextOf({ outcome: 'done', hasOutput: true, ...data }));
      refreshQuotaWarning();
      if (shownBlocks().length > 0) {
        const sourceDivergence = findSourceDivergence(text, shownBlocks());
        if (sourceDivergence !== null) showSourceDivergenceAlert(sourceDivergence);
      }
    } else if (eventName === 'error') {
      const hasOutput = endFailedRun();
      const silenceText = silenceTextOf(requestSettings.modelId, data.servedModelId, data.isFallback);
      showErrorAlert(data.errorCode, data.message, hasOutput, silenceText);
      refreshQuotaWarning();
      setShownHistoryId(data.translationId);
      if (isSidebarOpen()) loadHistory();
    }
  };

  renderProgress();
  const progressTimer = setInterval(renderProgress, 1000);
  try {
    const requestBody: TranslateRequest = {
      sourceLanguage,
      targetLanguage: targetLanguageOf(sourceLanguage),
      sourceText: text,
      modelId: requestSettings.modelId,
      effort: requestSettings.effort,
      sourceFormat: requestSettings.sourceFormat,
    };
    const response = await fetch('/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: request.signal,
    });
    if (!response.ok) throw new Error(await response.text());
    if (response.body === null) throw new Error('The server sent an empty reply.');
    await readStreamEvents(response.body, handleStreamEvent);
  } catch (error) {
    // An abort comes from Esc, Clear or a newer run, which have already updated the page.
    const isAbort = error instanceof Error && error.name === 'AbortError';
    if (!isAbort) {
      const hasOutput = endFailedRun();
      // fetch rejects with a TypeError only when the server cannot be reached at all.
      const errorKind = error instanceof TypeError ? 'server_unreachable' : 'request_rejected';
      showErrorAlert(errorKind, errorText(error), hasOutput, '');
    }
  } finally {
    clearInterval(progressTimer);
    if (activeRequest === request) activeRequest = null;
  }
}

function swapLanguages(): void {
  if (activeRequest) activeRequest.abort();
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
  if (!activeRequest && runInfo.textContent.startsWith('Cancelled')) setRunInfo('');
  if (clearedSnapshot && sourceText.value === clearedSnapshot.sourceText) {
    restoreClearedTranslation();
  } else {
    if (clearedSnapshot && sourceText.value !== '') forgetClearedSnapshot();
    setShownHistoryId(null);
  }
  renderLanguages();
  renderSource();
});
translateButton.addEventListener('click', translate);
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
    setShownHistoryId(shownEntryId);
    sourceLanguage = shownSourceLanguage;
    isDirectionAuto = wasDirectionAuto;
    renderLanguages();
  }
});
// Clears the source and the translation, keeping both for Undo. Used by Clear and by New translation.
function clearWorkspace(): void {
  if (activeRequest) activeRequest.abort();
  hideAlert();
  clearedSnapshot = snapshotWorkspace();
  resetPairs();
  setViewMode('edit');
  // insertText instead of assigning .value keeps the deletion on the undo stack, so ⌘Z restores the text.
  sourceText.focus();
  sourceText.select();
  document.execCommand('insertText', false, '');
  renderTarget('empty');
  setShownHistoryId(null);
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
copySourceButton.addEventListener('click', () => copyWithFeedback(copySourceButton, composeSourceCopyText()));

function startNewTranslation(): void {
  if (sourceText.value !== '') clearWorkspace();
  if (isSidebarModal()) closeSidebar();
  sourceText.focus();
}
requiredElement('#new-translation-button', HTMLButtonElement).addEventListener('click', startNewTranslation);
requiredElement('#masthead-new-translation-button', HTMLButtonElement).addEventListener('click', startNewTranslation);
initHistorySidebar({
  showEntry: showHistoryEntry,
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
  } else if (event.key === 'Escape' && activeRequest) {
    event.preventDefault();
    cancelTranslation();
  } else if (event.key === 'Escape' && isAlertShown()) {
    hideAlert();
  } else if (hasModifier && event.key === 'Enter') {
    event.preventDefault();
    translate();
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
