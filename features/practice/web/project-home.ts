// #/p/<project> : the next exercise to do and what is not done yet; Export, Archive and Delete for the project.
import type { ExerciseItem, Project } from '../api.ts';
import { ApiError, deleteProject, errorText, exportUrl, putProject, readProjectView } from './client.ts';
import { button, h, link } from './dom.ts';
import { pluralize } from './format.ts';
import { reloadView, type Page } from './page.ts';
import { projectToolbar, showSide } from './side.ts';

export async function showProjectHome(page: Page, project_key: string): Promise<void> {
  const view = await readProjectView(project_key, page.signal);
  const { project } = view;
  showSide(view, {});
  page.setTitle(project.name);
  page.main.append(projectToolbar(view, ...projectActions(page, project)));

  const not_done = view.exercises.filter((exercise) => !exercise.done);
  const import_link = link('#/new', 'ghost-button', 'Import a file…');
  if (not_done.length === 0) {
    page.main.append(createAllDone(import_link));
    return;
  }
  const [next, ...later] = not_done;
  page.main.append(createNextUp(project, next, not_done.length, import_link));
  if (later.length > 0) page.main.append(createNotDoneYet(project, later));
}

function exerciseHref(project: Project, exercise: ExerciseItem): string {
  return `#/p/${project.key}/x/${exercise.key}`;
}

function createAllDone(import_link: HTMLElement): HTMLElement {
  const label = h('div', 'direction-label', h('span', 'language-name', 'All done'));
  const bar = h('div', 'direction-bar is-single', h('div', 'bar-half is-actions', label, h('div', 'bar-actions', import_link)));
  const note = h('p', 'card-section evaluation-note', 'Well done: you have done every exercise. Open one from the History to look at it again, or import more exercises.');
  return h('section', 'workspace', bar, note);
}

function createNextUp(project: Project, next: ExerciseItem, left_count: number, import_link: HTMLElement): HTMLElement {
  const label = h('div', 'direction-label', h('span', 'direction-role', 'Next up'), h('span', 'language-name', next.kind));
  const left = h('span', 'run-info', `${pluralize(left_count, 'exercise')} left`);
  const start = link(exerciseHref(project, next), 'primary-button', 'Start');
  const bar = h('div', 'direction-bar is-single', h('div', 'bar-half is-actions', label, h('div', 'bar-actions', left, import_link, start)));
  const description = project.description === '' ? [] : [h('p', 'evaluation-note', project.description)];
  return h('section', 'workspace', bar, h('div', 'card-section', ...description, h('p', 'read', next.preview)));
}

function createNotDoneYet(project: Project, exercises: ExerciseItem[]): HTMLElement {
  const label = h('div', 'direction-label', h('span', 'language-name', 'Not done yet'));
  const bar = h('div', 'direction-bar is-single', h('div', 'bar-half is-tinted', label));
  const rows = exercises.map((exercise) => {
    const meta = exercise.topic === null ? exercise.kind : `${exercise.kind} · ${exercise.topic}`;
    return link(exerciseHref(project, exercise), 'list-row', h('div', 'text', exercise.preview), h('div', 'meta', meta));
  });
  return h('section', 'workspace', bar, h('div', '', ...rows));
}

// ---- Export, Archive, Delete ----

function projectActions(page: Page, project: Project): HTMLElement[] {
  const export_link = Object.assign(link(exportUrl(project.key), 'ghost-button', 'Export'), { download: `${project.key}.json` });
  export_link.title = 'Download the project as a file you can edit and import again';
  const archive = button('ghost-button', project.archived ? 'Unarchive' : 'Archive', () => void toggleArchived(page, project));
  archive.title = project.archived ? 'Show it in the list of projects again' : 'Hide it from the list of projects; nothing is deleted';
  const remove = button('ghost-button', 'Delete', () => void deleteThisProject(page, project));
  return [export_link, archive, remove];
}

async function toggleArchived(page: Page, project: Project): Promise<void> {
  const input = { name: project.name, description: project.description, archived: !project.archived };
  try {
    await putProject(project.key, input, page.signal);
  } catch (error) {
    if (!page.signal.aborted) alert(`Could not change the project: ${errorText(error)}`);
    return;
  }
  reloadView();
}

// Asks first. A project with attempts asks a second time, because its attempts are deleted too.
async function deleteThisProject(page: Page, project: Project): Promise<void> {
  if (!confirm(`Delete “${project.name}” and its ${pluralize(project.exercise_count, 'exercise')}? This cannot be undone.`)) return;
  try {
    await deleteProject(project.key, false, page.signal);
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== 'has_attempts') {
      if (!page.signal.aborted) alert(`Could not delete the project: ${errorText(error)}`);
      return;
    }
    const question = `“${project.name}” has answers you gave. Delete them too?\n\nTo keep them, choose Cancel and then Archive.`;
    if (!confirm(question)) return;
    try {
      await deleteProject(project.key, true, page.signal);
    } catch (second_error) {
      if (!page.signal.aborted) alert(`Could not delete the project: ${errorText(second_error)}`);
      return;
    }
  }
  location.hash = '#/';
}
