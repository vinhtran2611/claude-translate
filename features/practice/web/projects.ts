// #/ : every project as a card, with a search and a sort.
import { requiredElement } from '../../../shared/web/ui.ts';
import type { ProjectSummary } from '../api.ts';
import { listProjects } from './client.ts';
import { h, link } from './dom.ts';
import { pluralize, relativeDay, typeMix } from './format.ts';
import type { Page } from './page.ts';
import { showProjectsSide } from './side.ts';

const SORTS = {
  activity: { label: 'Last activity', compare: (a: ProjectSummary, b: ProjectSummary) => (b.last_activity_at ?? b.created_at).localeCompare(a.last_activity_at ?? a.created_at) },
  name: { label: 'Name', compare: (a: ProjectSummary, b: ProjectSummary) => a.name.localeCompare(b.name) },
  created: { label: 'Newest', compare: (a: ProjectSummary, b: ProjectSummary) => b.created_at.localeCompare(a.created_at) },
};

function createCard(project: ProjectSummary): HTMLAnchorElement {
  const activity = project.last_activity_at === null ? `Created ${relativeDay(project.created_at)} · not started` : `Last activity ${relativeDay(project.last_activity_at)}`;
  return link(`#/p/${project.id}`, 'project-card',
    h('div', 'project-icon', Array.from(project.name)[0].toUpperCase()),
    h('h2', '', project.name),
    h('p', 'count', `${pluralize(project.exercise_count, 'exercise')} · ${project.done_count} done`),
    h('p', 'mix', typeMix(project.type_counts)),
    h('p', 'activity', activity));
}

export async function showProjects(page: Page): Promise<void> {
  page.setTitle('Projects');
  const projects = await listProjects(page.signal);
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
  if (projects.length === 0) {
    page.main.append(h('div', 'toolbar', h('span', 'grow'), link('#/new', 'primary-button', 'New project')),
      h('p', 'empty-note', 'No projects yet. A project is one JSON file of exercises: choose New project to import one.'));
    return;
  }
  page.main.append(
    h('div', 'toolbar', h('label', 'settings-chip sort-chip', 'Sort by', sort), h('span', 'grow'), link('#/new', 'primary-button', 'New project')),
    grid);
  draw();
}
