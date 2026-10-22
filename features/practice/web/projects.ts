// #/ : every project as a card, with a search and a sort.
import { requiredElement } from '../../../shared/web/ui.ts';
import type { ProjectSummary } from '../api.ts';
import { listProjects } from './client.ts';
import { h, link } from './dom.ts';
import { pluralize, relativeDay, typeMix } from './format.ts';
import { reloadView, type Page } from './page.ts';
import { showProjectsSide } from './side.ts';

// Its newest attempt, or its creation before the first one.
const activityTimeOf = (project: ProjectSummary): string => project.lastActivityAt ?? project.createdAt;

const SORTS = {
  activity: { label: 'Last activity', compare: (a: ProjectSummary, b: ProjectSummary) => activityTimeOf(b).localeCompare(activityTimeOf(a)) },
  name: { label: 'Name', compare: (a: ProjectSummary, b: ProjectSummary) => a.name.localeCompare(b.name) },
  created: { label: 'Newest', compare: (a: ProjectSummary, b: ProjectSummary) => b.createdAt.localeCompare(a.createdAt) },
};

// Archived projects are hidden unless this is on. It lasts until the page is reloaded.
let is_showing_archived = false;

function activityOf(project: ProjectSummary): string {
  if (project.archivedAt !== null) return 'Archived';
  if (project.lastActivityAt === null) return `Created ${relativeDay(project.createdAt)} · not started`;
  return `Last activity ${relativeDay(project.lastActivityAt)}`;
}

function createCard(project: ProjectSummary): HTMLAnchorElement {
  const activity = activityOf(project);
  return link(`#/p/${project.key}`, 'project-card',
    h('div', 'project-icon', Array.from(project.name)[0].toUpperCase()),
    h('h2', '', project.name),
    h('p', 'count', `${pluralize(project.exerciseCount, 'exercise')} · ${project.doneCount} done`),
    h('p', 'mix', typeMix(project.typeCounts)),
    h('p', 'activity', activity));
}

export async function showProjects(page: Page): Promise<void> {
  page.setTitle('Projects');
  const projects = await listProjects(is_showing_archived ? 'all' : 'false', page.signal);
  showProjectsSide(projects);
  const sort = Object.assign(h('select'), { id: 'sort' });
  sort.append(...Object.entries(SORTS).map(([value, { label }]) => Object.assign(h('option', '', label), { value })));
  // The sidebar's search field filters the cards as well as its own list.
  const search = requiredElement('#history-search', HTMLInputElement);
  const grid = h('div', 'project-grid');
  const draw = (): void => {
    const query = search.value.trim().toLowerCase();
    const shown = projects.filter((project) => project.name.toLowerCase().includes(query))
      .sort(SORTS[sort.value as keyof typeof SORTS].compare);
    const no_match = Object.assign(h('p', 'empty-note', `No project matches “${search.value.trim()}”.`), { role: 'status' });
    grid.replaceChildren(...(shown.length > 0 ? shown.map(createCard) : [no_match]));
  };
  search.addEventListener('input', draw, { signal: page.signal });
  sort.addEventListener('change', draw);
  page.main.append(h('h1', '', 'Projects'));
  const new_project = link('#/new', 'primary-button', 'New project');
  const archived_toggle = createArchivedToggle();
  if (projects.length === 0) {
    const toolbar = h('div', 'toolbar', archived_toggle, h('span', 'grow'), new_project);
    const note = h('p', 'empty-note', 'No projects yet. A project is one JSON file of exercises: choose New project to import one.');
    page.main.append(toolbar, note);
    return;
  }
  const toolbar = h('div', 'toolbar', h('label', 'settings-chip sort-chip', 'Sort by', sort), archived_toggle, h('span', 'grow'), new_project);
  page.main.append(toolbar, grid);
  draw();
}

function createArchivedToggle(): HTMLElement {
  const checkbox = Object.assign(h('input'), { type: 'checkbox', checked: is_showing_archived });
  checkbox.addEventListener('change', () => {
    is_showing_archived = checkbox.checked;
    reloadView();
  });
  return h('label', 'settings-chip', checkbox, 'Show archived');
}
