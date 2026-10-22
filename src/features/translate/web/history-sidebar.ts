// The history sidebar: the list of saved translations, grouped by day, with search, keyboard moves and delete with
// Undo. Docked as a column on wide screens, a modal drawer on narrow ones.
import { parseInline, plainTextOf } from '../../../shared/web/markdown.ts';
import { foldForSearch, historyGroupOf, readStored, requiredElement, writeStored } from '../../../shared/web/ui.ts';
import type { HistoryEntry, HistorySummary } from '../api-types.ts';
import { errorText, showAlert } from './alert.ts';
import { fetchJson } from './fetch-json.ts';
import { arrowTargetOf, choiceLabelOf, modeNoteOf } from './settings-menus.ts';

// What the sidebar asks the page to do. Set once by initHistorySidebar.
interface SidebarHandlers {
  // Shows an entry the user opened.
  showEntry: (entry: HistoryEntry) => void;
  // Esc in an empty search field of the docked sidebar goes back to the text box.
  focusSourceText: () => void;
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

let handlers: SidebarHandlers | null = null;
// Summaries from the last GET /history, newest first; written only by loadHistory.
let history_summaries: HistorySummary[] = [];
// The entry on screen, marked in the list; null when the workspace holds anything else. Written only by setShownHistoryId.
let shown_history_id: number | null = null;
// Deletes waiting out their Undo window: entry id -> timer. The row stays hidden while its id is here.
const pending_deletes = new Map<number, ReturnType<typeof setTimeout>>();

export function shownHistoryId(): number | null {
  return shown_history_id;
}

export function setShownHistoryId(history_id: number | null): void {
  shown_history_id = history_id;
  for (const open_button of history_list.querySelectorAll<HTMLButtonElement>('.history-open-button')) {
    const is_current = Number(open_button.dataset.entryId) === history_id;
    if (is_current) open_button.setAttribute('aria-current', 'true');
    else open_button.removeAttribute('aria-current');
  }
}

// The first non-blank line of input_preview, without the Markdown that would otherwise show as raw marks.
export function historyTitleOf(input_preview: string): string {
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

export async function loadHistory(): Promise<void> {
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

// Whether the page starts with the sidebar docked: a wide screen, and it was not closed last time.
export function isDockedOnStart(): boolean {
  return wide_screen_query.matches && readIsSidebarOpen();
}

// Wide screens dock it as a column (non-modal, remembered); narrow screens show it as a modal drawer.
export function openSidebar(): void {
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

export function closeSidebar(): void {
  history_sidebar.close();
  if (wide_screen_query.matches) writeIsSidebarOpen(false);
}

export function toggleSidebar(): void {
  if (history_sidebar.open) closeSidebar();
  else openSidebar();
}

export function isSidebarOpen(): boolean {
  return history_sidebar.open;
}

export function isSidebarModal(): boolean {
  return history_sidebar.matches(':modal');
}

// ⌘K: opens the sidebar if needed and puts the cursor in its search field, its text selected.
export function focusHistorySearch(): void {
  if (!history_sidebar.open) openSidebar();
  history_search.focus();
  history_search.select();
}

async function openHistoryEntry(entry_id: number): Promise<void> {
  try {
    handlers?.showEntry(await fetchJson<HistoryEntry>(`/history/${entry_id}`));
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

// Wires the sidebar's own buttons and keys. The page passes what opening an entry and leaving the search do.
export function initHistorySidebar(page_handlers: SidebarHandlers): void {
  handlers = page_handlers;
  sidebar_open_button.addEventListener('click', () => {
    openSidebar();
    history_search.focus();
  });
  requiredElement('#sidebar-close-button', HTMLButtonElement).addEventListener('click', closeSidebar);
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
        handlers?.focusSourceText();
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
}
