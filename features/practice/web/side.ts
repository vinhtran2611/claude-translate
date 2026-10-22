// The sidebar, the same one Claude Translate has: a docked column on wide screens (remembered under the same key), a drawer on
// narrow ones; a search field (⌘K); one row to start something new; then date groups of items. Inside a project it is the History:
// "New exercise" and the latest attempt of each exercise, unsent drafts first. Outside one it lists the projects, so the page has
// the same shape wherever you are. Also the row of chips under the masthead.
import { createIcon, foldForSearch, historyGroupOf, readStored, requiredElement, writeStored } from '../../../shared/web/ui.ts';
import type { ProjectSummary } from '../api.ts';
import type { ProjectView } from './client.ts';
import { h, link } from './dom.ts';
import { listDrafts } from './drafts.ts';
import { pluralize } from './format.ts';

const sidebar = requiredElement('#history-sidebar', HTMLDialogElement);
const open_button = requiredElement('#sidebar-open-button', HTMLButtonElement);
const new_button = requiredElement('#masthead-new-button', HTMLButtonElement);
const search = requiredElement('#history-search', HTMLInputElement);
const list = requiredElement('#history-list', HTMLOListElement);
const status = requiredElement('#history-status', HTMLParagraphElement);
const wide_screen_query = matchMedia('(min-width: 1280px)');
// The key Claude Translate keeps its sidebar's state under: open or closed is one choice for both pages.
const OPEN_KEY = 'is_sidebar_open';

// What the page shows now, so the sidebar can mark it: an attempt, or an exercise with a draft.
export interface Current {
  attempt_id?: number;
  draft_exercise_id?: number;
}

type Shown = { view: ProjectView; current: Current } | { projects: ProjectSummary[] };
let shown: Shown | null = null;
const new_label = requiredElement('#new-exercise-button .row-label', HTMLElement);

const isModal = (): boolean => sidebar.matches(':modal');

// When a project was last worked on: its newest attempt, or its creation before the first one.
function activityTimeOf(project: ProjectSummary): string {
  return project.lastActivityAt ?? project.createdAt;
}

function createItem(href: string, preview: string, meta: string, is_current: boolean): HTMLLIElement {
  const anchor = link(href, 'history-open-button', h('span', 'history-item-title', preview), h('span', 'history-item-meta', meta));
  anchor.title = `${preview}\n${meta}`;
  if (is_current) anchor.setAttribute('aria-current', 'true');
  return h('li', 'history-item', anchor);
}

// One row of the list; group is the section it belongs to, null for the unsent drafts' own.
interface Row {
  href: string;
  preview: string;
  meta: string;
  is_current: boolean;
  group: string;
}

function rowsOf(current_shown: Shown): { rows: Row[]; is_empty: boolean } {
  if ('projects' in current_shown) {
    const projects = [...current_shown.projects];
    projects.sort((a, b) => activityTimeOf(b).localeCompare(activityTimeOf(a)));
    const rows = projects.map((project): Row => ({
      href: `#/p/${project.key}`, preview: project.name, meta: `${pluralize(project.exerciseCount, 'exercise')} · ${project.doneCount} done`, is_current: false,
      group: historyGroupOf(activityTimeOf(project)),
    }));
    return { rows, is_empty: rows.length === 0 };
  }
  const { view, current } = current_shown;
  const project_key = view.project.key;
  const exercises = new Map(view.exercises.map((exercise) => [exercise.id, exercise]));
  const drafts = listDrafts(new Set(exercises.keys())).map(({ exerciseId }): Row => {
    const exercise = exercises.get(exerciseId)!;
    return {
      href: `#/p/${project_key}/x/${exercise.key}`, preview: exercise.preview, meta: `${exercise.label} · Draft`,
      is_current: current.draft_exercise_id === exerciseId, group: 'Drafts',
    };
  });
  // The History: the latest attempt of each exercise, newest first.
  const tried = view.exercises.filter((exercise) => exercise.lastAttempt !== null);
  tried.sort((a, b) => b.lastAttempt!.createdAt.localeCompare(a.lastAttempt!.createdAt));
  const attempts = tried.map((exercise): Row => {
    const last = exercise.lastAttempt!;
    return {
      href: `#/a/${last.id}`, preview: exercise.preview, meta: `${exercise.label} · ${last.historyLine}`,
      is_current: current.attempt_id === last.id, group: historyGroupOf(last.createdAt),
    };
  });
  return { rows: [...drafts, ...attempts], is_empty: drafts.length + attempts.length === 0 };
}

function renderList(): void {
  if (shown === null) return;
  const { rows, is_empty } = rowsOf(shown);
  const words = foldForSearch(search.value).split(/\s+/).filter(Boolean);
  const focused_href = list.contains(document.activeElement) ? (document.activeElement as HTMLElement).getAttribute('href') : null;
  const children: HTMLLIElement[] = [];
  let previous_group: string | null = null;
  for (const row of rows) {
    if (!words.every((word) => foldForSearch(`${row.preview} ${row.meta}`).includes(word))) continue;
    if (row.group !== previous_group) children.push(h('li', 'history-group-label', row.group));
    previous_group = row.group;
    children.push(createItem(row.href, row.preview, row.meta, row.is_current));
  }
  list.replaceChildren(...children);
  status.textContent = children.length > 0 ? '' : is_empty ? `Your ${'projects' in shown ? 'projects' : 'exercises'} will appear here.` : `No matches for “${search.value.trim()}”`;
  status.hidden = status.textContent === '';
  if (focused_href !== null) list.querySelector<HTMLElement>(`a[href="${focused_href}"]`)?.focus();
  list.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
}

// Wide screens dock it as a column (non-modal, remembered); narrow screens show it as a modal drawer.
function openSidebar(): void {
  if (wide_screen_query.matches) {
    // A docked sidebar is not modal: typing should continue where it was.
    const previous_focus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    sidebar.show();
    previous_focus?.focus();
    writeStored(OPEN_KEY, '1');
  } else {
    sidebar.showModal();
  }
  open_button.setAttribute('aria-expanded', 'true');
}

function closeSidebar(): void {
  sidebar.close();
  if (wide_screen_query.matches) writeStored(OPEN_KEY, '0');
}

const toggleSidebar = (): void => (sidebar.open ? closeSidebar() : openSidebar());

// Where the sidebar's first row goes: inside a project the next exercise not done (the project's home when every one is);
// outside, the page that makes a project.
function startNew(): void {
  if (shown === null) return;
  if ('projects' in shown) {
    location.hash = '#/new';
  } else {
    const project_key = shown.view.project.key;
    const next = shown.view.exercises.find((exercise) => !exercise.isDone);
    location.hash = next === undefined ? `#/p/${project_key}` : `#/p/${project_key}/x/${next.key}`;
  }
  if (isModal()) closeSidebar();
}

function show(next: Shown, new_text: string): void {
  const is_first = shown === null;
  shown = next;
  new_label.textContent = new_text;
  new_button.title = new_button.ariaLabel = new_text;
  open_button.hidden = new_button.hidden = false;
  if (is_first && wide_screen_query.matches && readStored(OPEN_KEY) !== '0' && !sidebar.open) openSidebar();
  renderList();
}

export const showSide = (view: ProjectView, current: Current): void => show({ view, current }, 'New exercise');
export const showProjectsSide = (projects: ProjectSummary[]): void => show({ projects }, 'New project');

export function hideSide(): void {
  shown = null;
  if (sidebar.open) sidebar.close();
  open_button.hidden = new_button.hidden = true;
}

// The chips under the masthead: back to the projects, this project, how far along it is; then the page's own buttons.
export function projectToolbar({ project }: ProjectView, ...actions: HTMLElement[]): HTMLElement {
  const back = link('#/', 'settings-chip', createIcon('back', 'chip-icon'), 'Projects');
  const name = link(`#/p/${project.key}`, 'settings-chip is-name', h('span', '', project.name));
  name.title = project.name;
  const progress = h('span', 'settings-chip is-quiet', `${pluralize(project.exerciseCount, 'exercise')} · ${project.doneCount} done`);
  const archived = project.archivedAt !== null ? [h('span', 'settings-chip is-quiet', 'Archived')] : [];
  return h('div', 'settings-bar', back, name, progress, ...archived, h('span', 'grow'), ...actions);
}

open_button.addEventListener('click', () => {
  openSidebar();
  search.focus();
});
requiredElement('#sidebar-close-button', HTMLButtonElement).addEventListener('click', closeSidebar);
requiredElement('#new-exercise-button', HTMLButtonElement).addEventListener('click', startNew);
new_button.addEventListener('click', startNew);
// Only a modal drawer has a backdrop; a click on the dialog itself (not the content) is a click on it.
sidebar.addEventListener('click', (event) => {
  if (event.target === sidebar && isModal()) closeSidebar();
  else if (isModal() && event.target instanceof Element && event.target.closest('a.history-open-button')) closeSidebar();
});
sidebar.addEventListener('close', () => open_button.setAttribute('aria-expanded', 'false'));
wide_screen_query.addEventListener('change', () => {
  sidebar.close();
  if (shown !== null && wide_screen_query.matches && readStored(OPEN_KEY) !== '0') openSidebar();
});
search.addEventListener('input', renderList);
search.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    list.querySelector<HTMLElement>('.history-open-button')?.focus();
  } else if (event.key === 'Escape') {
    event.stopPropagation();
    if (search.value !== '') {
      event.preventDefault();
      search.value = '';
      renderList();
    }
  }
});
list.addEventListener('keydown', (event) => {
  const items = [...list.querySelectorAll<HTMLElement>('.history-open-button')];
  const index = items.findIndex((item) => item === document.activeElement);
  const target = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: items.length - 1 }[event.key];
  if (index === -1 || target === undefined) return;
  event.preventDefault();
  items[Math.max(0, Math.min(items.length - 1, target))].focus();
});
document.addEventListener('keydown', (event) => {
  if (shown === null || isModal() || !(event.metaKey || event.ctrlKey)) return;
  if (event.key.toLowerCase() === 'k') {
    event.preventDefault();
    if (!sidebar.open) openSidebar();
    search.focus();
    search.select();
  } else if (event.key === '\\') {
    event.preventDefault();
    toggleSidebar();
  }
});
// A draft written or removed in another tab.
window.addEventListener('storage', (event) => {
  if (event.key === null || event.key.startsWith('practice.draft.')) renderList();
});
