// The history sidebar: the list of saved translations, grouped by day, with search, keyboard moves and delete with
// Undo. Docked as a column on wide screens, a modal drawer on narrow ones.
import { fetchJson } from '../../../shared/web/fetch-json.ts';
import { parseInline, plainTextOf } from '../../../shared/web/markdown.ts';
import { foldForSearch, formatElapsed, historyGroupOf, readStored, requiredElement, writeStored } from '../../../shared/web/ui.ts';
import type { ModelRun } from '../../../shared/api-types.ts';
import type { Translation, TranslationSummary } from '../api-types.ts';
import { errorText, showAlert } from './alert.ts';
import { arrowTargetOf, choiceLabelOf, sourceFormatNoteOf } from './settings-menus.ts';

// The model that answered; the requested one while that is not known yet.
export function servedModelOf(run: Pick<ModelRun, 'servedModelId' | 'requestedModelId'>): string {
  return run.servedModelId ?? run.requestedModelId ?? '';
}

// What the sidebar asks the page to do. Set once by initHistorySidebar.
interface SidebarHandlers {
  // Shows a translation the user opened.
  showEntry: (translation: Translation) => void;
  // Esc in an empty search field of the docked sidebar goes back to the text box.
  focusSourceText: () => void;
}

const historySidebar = requiredElement('#history-sidebar', HTMLDialogElement);
const sidebarOpenButton = requiredElement('#sidebar-open-button', HTMLButtonElement);
const historySearch = requiredElement('#history-search', HTMLInputElement);
const historyList = requiredElement('#history-list', HTMLOListElement);
const historyStatus = requiredElement('#history-status', HTMLParagraphElement);
const wideScreenQuery = matchMedia('(min-width: 1280px)');
const HISTORY_LIST_LIMIT = 200;
// Long enough to reach Undo after a misclick, short enough that the row does not linger.
const DELETE_UNDO_MS = 5000;
// While a listed row is running, the list is read again this often, so its mark and preview lag by at most this. One read
// is one query on a local file.
const HISTORY_POLL_MS = 3000;
const TRASH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5"/></svg>';

let handlers: SidebarHandlers | null = null;
// Summaries from the last GET /history, newest first; written only by loadHistory.
let historySummaries: TranslationSummary[] = [];
// The entry on screen, marked in the list; null when the workspace holds anything else. Written only by setShownHistoryId.
let shownEntryId: number | null = null;
// Deletes waiting out their Undo window: entry id -> timer. The row stays hidden while its id is here.
const pendingDeletes = new Map<number, ReturnType<typeof setTimeout>>();
// The next poll of the list; written only by schedulePoll.
let pollTimer: ReturnType<typeof setTimeout> | undefined;

// The one mark a row shows. A row has at most one, picked by markOf.
interface RowMark {
  className: string;
  labelSuffix: string;
  tooltipNote: string;
}

export function shownHistoryId(): number | null {
  return shownEntryId;
}

export function setShownHistoryId(historyId: number | null): void {
  shownEntryId = historyId;
  for (const openButton of historyList.querySelectorAll<HTMLButtonElement>('.history-open-button')) {
    const isCurrent = Number(openButton.dataset.entryId) === historyId;
    if (isCurrent) openButton.setAttribute('aria-current', 'true');
    else openButton.removeAttribute('aria-current');
  }
}

// The first non-blank line of inputPreview, without the Markdown that would otherwise show as raw marks.
export function historyTitleOf(inputPreview: string): string {
  const firstLine = inputPreview.split('\n').find((line) => line.trim() !== '') ?? '';
  return plainTextOf(parseInline(firstLine.replace(/^\s*(#{1,6}\s+|[-*+]\s+|>\s+|\d+[.)]\s+)/, '')))
    .replace(/\s+/g, ' ')
    .trim();
}

// The row's mark, in this order: still translating; finished while no page watched it and not opened since (an unread
// failed run shows this first, and the partial mark once opened); a run that did not succeed is partial. null: no mark.
function markOf(summary: TranslationSummary): RowMark | null {
  const { run } = summary;
  if (run.status === 'running') {
    const elapsed = formatElapsed(Date.now() - Date.parse(run.startedAt));
    return { className: 'history-running-mark', labelSuffix: ' (translating)', tooltipNote: ` · Translating · ${elapsed}` };
  }
  if (summary.isUnread) return { className: 'history-unread-mark', labelSuffix: ' (new)', tooltipNote: ' · Finished while you were away' };
  if (run.status !== 'succeeded') return { className: 'history-partial-mark', labelSuffix: ' (partial)', tooltipNote: ' · partial' };
  return null;
}

function describeHistoryTooltip(summary: TranslationSummary, mark: RowMark | null): string {
  const created = new Date(summary.createdAt);
  const time = created.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const day = historyGroupOf(summary.createdAt);
  let dayLabel = day;
  if (day !== 'Today' && day !== 'Yesterday') dayLabel = created.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const markNote = mark?.tooltipNote ?? '';
  const choice = { modelId: servedModelOf(summary.run), effort: summary.run.effort ?? '' };
  const choiceLabel = `${sourceFormatNoteOf(summary.sourceFormat)}${choiceLabelOf(choice)}`;
  const direction = `${summary.sourceLanguage.toUpperCase()} → ${summary.targetLanguage.toUpperCase()}`;
  return `${direction} · ${dayLabel} ${time} · ${choiceLabel}${markNote}`;
}

function matchesHistorySearch(summary: TranslationSummary, foldedQueryWords: string[]): boolean {
  const haystack = foldForSearch(`${summary.sourcePreview} ${summary.outputPreview}`);
  return foldedQueryWords.every((word) => haystack.includes(word));
}

// '' hides it. Used for the empty state, no search matches, and load or delete errors.
function showHistoryStatus(text: string): void {
  historyStatus.textContent = text;
  historyStatus.hidden = text === '';
}

function createHistoryItem(summary: TranslationSummary): HTMLLIElement {
  const item = document.createElement('li');
  item.className = 'history-item';
  const openButton = document.createElement('button');
  openButton.className = 'history-open-button';
  openButton.dataset.entryId = String(summary.id);
  openButton.tabIndex = -1;
  const title = historyTitleOf(summary.sourcePreview);
  const mark = markOf(summary);
  openButton.title = describeHistoryTooltip(summary, mark);
  openButton.setAttribute('aria-label', `${title}${mark?.labelSuffix ?? ''}`);
  if (summary.id === shownEntryId) openButton.setAttribute('aria-current', 'true');
  const titleElement = document.createElement('span');
  titleElement.className = 'history-item-title';
  titleElement.textContent = title;
  openButton.append(titleElement);
  if (mark !== null) {
    const markElement = document.createElement('span');
    markElement.className = `history-mark ${mark.className}`;
    markElement.setAttribute('aria-hidden', 'true');
    openButton.append(markElement);
  }
  openButton.addEventListener('click', () => openHistoryEntry(summary.id));

  const deleteButton = document.createElement('button');
  deleteButton.className = 'history-delete-button';
  deleteButton.tabIndex = -1;
  deleteButton.title = 'Delete (⌫)';
  deleteButton.setAttribute('aria-label', 'Delete');
  deleteButton.innerHTML = TRASH_ICON;
  deleteButton.addEventListener('click', () => deleteHistoryEntry(summary.id));

  item.append(openButton, deleteButton);
  return item;
}

// The one renderer of the list: grouped, filtered by the search field, minus rows waiting to be deleted.
// Exactly one row is in the Tab order (roving tabindex): the open entry if listed, else the first.
function renderHistoryList(): void {
  const foldedQueryWords = foldForSearch(historySearch.value).split(/\s+/).filter(Boolean);
  const visibleSummaries = historySummaries.filter((summary) =>
    !pendingDeletes.has(summary.id) && matchesHistorySearch(summary, foldedQueryWords));
  const listChildren: HTMLLIElement[] = [];
  let previousGroup = null;
  for (const summary of visibleSummaries) {
    const group = historyGroupOf(summary.createdAt);
    if (group !== previousGroup) {
      const groupLabel = document.createElement('li');
      groupLabel.className = 'history-group-label';
      groupLabel.textContent = group;
      listChildren.push(groupLabel);
      previousGroup = group;
    }
    listChildren.push(createHistoryItem(summary));
  }
  if (historySummaries.length >= HISTORY_LIST_LIMIT && foldedQueryWords.length === 0) {
    const limitNote = document.createElement('li');
    limitNote.className = 'history-list-limit';
    limitNote.textContent = `Showing the latest ${HISTORY_LIST_LIMIT}`;
    listChildren.push(limitNote);
  }
  historyList.replaceChildren(...listChildren);
  if (historySummaries.length === pendingDeletes.size) showHistoryStatus('Your translations will appear here.');
  else if (visibleSummaries.length === 0) showHistoryStatus(`No matches for “${historySearch.value.trim()}”`);
  else showHistoryStatus('');
  const currentButton = historyList.querySelector<HTMLButtonElement>('.history-open-button[aria-current="true"]');
  const tabStop = currentButton ?? historyList.querySelector<HTMLButtonElement>('.history-open-button');
  if (tabStop) tabStop.tabIndex = 0;
  currentButton?.scrollIntoView({ block: 'nearest' });
}

export async function loadHistory(): Promise<void> {
  try {
    historySummaries = await fetchJson<TranslationSummary[]>('/history');
    renderHistoryList();
    schedulePoll();
  } catch (error) {
    historyList.replaceChildren();
    showHistoryStatus(`Could not load history: ${errorText(error)}`);
  }
}

// Reads the list again in HISTORY_POLL_MS while the sidebar is open and a listed row is running, so runs that finish here
// or in another tab lose their running mark. A failed read stops polling until the next load.
function schedulePoll(): void {
  clearTimeout(pollTimer);
  const hasRunningRow = historySummaries.some((summary) => summary.run.status === 'running');
  if (historySidebar.open && hasRunningRow) pollTimer = setTimeout(loadHistory, HISTORY_POLL_MS);
}

function readIsSidebarOpen(): boolean {
  return readStored('is_sidebar_open') !== '0';
}

function writeIsSidebarOpen(isOpen: boolean): void {
  writeStored('is_sidebar_open', isOpen ? '1' : '0');
}

// Whether the page starts with the sidebar docked: a wide screen, and it was not closed last time.
export function isDockedOnStart(): boolean {
  return wideScreenQuery.matches && readIsSidebarOpen();
}

// Wide screens dock it as a column (non-modal, remembered); narrow screens show it as a modal drawer.
export function openSidebar(): void {
  if (wideScreenQuery.matches) {
    // A docked sidebar is not modal: typing should continue where it was. focus() is a no-op on the
    // open button (hidden once the sidebar is open), so a click keeps the dialog's own focus.
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    historySidebar.show();
    previousFocus?.focus();
    writeIsSidebarOpen(true);
  } else {
    historySidebar.showModal();
  }
  sidebarOpenButton.setAttribute('aria-expanded', 'true');
  loadHistory();
}

export function closeSidebar(): void {
  historySidebar.close();
  if (wideScreenQuery.matches) writeIsSidebarOpen(false);
}

export function toggleSidebar(): void {
  if (historySidebar.open) closeSidebar();
  else openSidebar();
}

export function isSidebarOpen(): boolean {
  return historySidebar.open;
}

export function isSidebarModal(): boolean {
  return historySidebar.matches(':modal');
}

// ⌘K: opens the sidebar if needed and puts the cursor in its search field, its text selected.
export function focusHistorySearch(): void {
  if (!historySidebar.open) openSidebar();
  historySearch.focus();
  historySearch.select();
}

async function openHistoryEntry(entryId: number): Promise<void> {
  try {
    handlers?.showEntry(await fetchJson<Translation>(`/history/${entryId}`));
    if (isSidebarModal()) closeSidebar();
  } catch (error) {
    showHistoryStatus(`Could not open it: ${errorText(error)}`);
    loadHistory();
    return;
  }
  const summary = historySummaries.find((listed) => listed.id === entryId);
  if (summary?.isUnread) await markEntryRead(summary);
}

// Opening an unread entry clears its mark here at once, and on the server for every tab's next list.
async function markEntryRead(summary: TranslationSummary): Promise<void> {
  summary.isUnread = false;
  renderHistoryList();
  try {
    await fetchJson<null>(`/history/${summary.id}/read`, { method: 'POST' });
  } catch (error) {
    showHistoryStatus(`Could not mark it read: ${errorText(error)}`);
  }
}

function flushPendingDelete(entryId: number): void {
  clearTimeout(pendingDeletes.get(entryId));
  pendingDeletes.delete(entryId);
  fetch(`/history/${entryId}`, { method: 'DELETE', keepalive: true }).catch(() => {});
}

// Hides the row at once and deletes on the server only after DELETE_UNDO_MS, so Undo needs no server call.
function deleteHistoryEntry(entryId: number): void {
  const openButtons = [...historyList.querySelectorAll<HTMLButtonElement>('.history-open-button')];
  const visibleIds = openButtons.map((button) => Number(button.dataset.entryId));
  const deletedIndex = visibleIds.indexOf(entryId);
  const focusId = visibleIds[deletedIndex + 1] ?? visibleIds[deletedIndex - 1] ?? null;
  const hadFocus = historyList.contains(document.activeElement);
  pendingDeletes.set(entryId, setTimeout(() => {
    pendingDeletes.delete(entryId);
    fetchJson<null>(`/history/${entryId}`, { method: 'DELETE' })
      .then(() => { historySummaries = historySummaries.filter((summary) => summary.id !== entryId); })
      .catch((error: unknown) => showHistoryStatus(`Could not delete: ${errorText(error)}`));
  }, DELETE_UNDO_MS));
  if (entryId === shownEntryId) setShownHistoryId(null);
  renderHistoryList();
  if (hadFocus && focusId !== null) historyList.querySelector<HTMLButtonElement>(`[data-entry-id="${focusId}"]`)?.focus();
  showAlert({
    severity: 'info',
    title: 'Translation deleted',
    action: {
      label: 'Undo',
      run: () => {
        clearTimeout(pendingDeletes.get(entryId));
        pendingDeletes.delete(entryId);
        renderHistoryList();
        if (historySidebar.open) historyList.querySelector<HTMLButtonElement>(`[data-entry-id="${entryId}"]`)?.focus();
      },
    },
  });
}

// Wires the sidebar's own buttons and keys. The page passes what opening an entry and leaving the search do.
export function initHistorySidebar(pageHandlers: SidebarHandlers): void {
  handlers = pageHandlers;
  sidebarOpenButton.addEventListener('click', () => {
    openSidebar();
    historySearch.focus();
  });
  requiredElement('#sidebar-close-button', HTMLButtonElement).addEventListener('click', closeSidebar);
  // Only a modal drawer has a backdrop; a click on the dialog itself (not the content) is a click on it.
  historySidebar.addEventListener('click', (event) => {
    if (event.target === historySidebar && isSidebarModal()) closeSidebar();
  });
  historySidebar.addEventListener('close', () => {
    sidebarOpenButton.setAttribute('aria-expanded', 'false');
    clearTimeout(pollTimer);
  });
  wideScreenQuery.addEventListener('change', () => {
    historySidebar.close();
    if (wideScreenQuery.matches && readIsSidebarOpen()) openSidebar();
  });
  historySearch.addEventListener('input', renderHistoryList);
  historySearch.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      historyList.querySelector<HTMLButtonElement>('.history-open-button')?.focus();
    } else if (event.key === 'Escape') {
      // stopPropagation keeps this Esc from also cancelling a running translation in the page handler.
      event.stopPropagation();
      if (historySearch.value !== '') {
        event.preventDefault();
        historySearch.value = '';
        renderHistoryList();
      } else if (!isSidebarModal()) {
        handlers?.focusSourceText();
      }
    }
  });
  historyList.addEventListener('keydown', (event) => {
    const openButtons = [...historyList.querySelectorAll<HTMLButtonElement>('.history-open-button')];
    const focusedIndex = openButtons.findIndex((button) => button === document.activeElement);
    if (focusedIndex === -1) return;
    const targetIndex = arrowTargetOf(event.key, focusedIndex, openButtons.length);
    if (targetIndex !== undefined) {
      event.preventDefault();
      const targetButton = openButtons[Math.max(0, Math.min(openButtons.length - 1, targetIndex))];
      openButtons.forEach((button) => { button.tabIndex = button === targetButton ? 0 : -1; });
      targetButton.focus();
      targetButton.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Backspace' || event.key === 'Delete') {
      event.preventDefault();
      deleteHistoryEntry(Number(openButtons[focusedIndex].dataset.entryId));
    }
  });
  // A delete still inside its Undo window would be lost on reload; keepalive lets it finish as the page goes.
  window.addEventListener('pagehide', () => {
    for (const entryId of [...pendingDeletes.keys()]) flushPendingDelete(entryId);
  });
}
