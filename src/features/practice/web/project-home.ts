// #/p/<project> : the next exercise to do and what is not done yet; Export, Archive and Delete for the project.
import type { ExerciseItem, ProjectSummary } from '../api-types.ts';
import { ApiError, deleteProject, errorText, exportUrl, putProject, readProjectView } from './client.ts';
import { button, h, link } from './dom.ts';
import { pluralize } from './format.ts';
import { reloadView, type Page } from './page.ts';
import { projectToolbar, showSide } from './side.ts';

export async function showProjectHome(page: Page, projectKey: string): Promise<void> {
  const view = await readProjectView(projectKey, page.signal);
  const { project } = view;
  showSide(view, {});
  page.setTitle(project.name);
  page.main.append(projectToolbar(view, ...projectActions(page, project)));

  const notDone = view.exercises.filter((exercise) => !exercise.isDone);
  const importLink = link('#/new', 'ghost-button', 'Import a file…');
  if (notDone.length === 0) {
    page.main.append(createAllDone(importLink));
    return;
  }
  const [next, ...later] = notDone;
  page.main.append(createNextUp(project, next, notDone.length, importLink));
  if (later.length > 0) page.main.append(createNotDoneYet(project, later));
}

function exerciseHref(project: ProjectSummary, exercise: ExerciseItem): string {
  return `#/p/${project.key}/x/${exercise.key}`;
}

function createAllDone(importLink: HTMLElement): HTMLElement {
  const label = h('div', 'direction-label', h('span', 'language-name', 'All done'));
  const bar = h('div', 'direction-bar is-single', h('div', 'bar-half is-actions', label, h('div', 'bar-actions', importLink)));
  const note = h('p', 'card-section evaluation-note', 'Well done: you have done every exercise. Open one from the History to look at it again, or import more exercises.');
  return h('section', 'workspace', bar, note);
}

function createNextUp(project: ProjectSummary, next: ExerciseItem, leftCount: number, importLink: HTMLElement): HTMLElement {
  const label = h('div', 'direction-label', h('span', 'direction-role', 'Next up'), h('span', 'language-name', next.label));
  const left = h('span', 'run-info', `${pluralize(leftCount, 'exercise')} left`);
  const start = link(exerciseHref(project, next), 'primary-button', 'Start');
  const bar = h('div', 'direction-bar is-single', h('div', 'bar-half is-actions', label, h('div', 'bar-actions', left, importLink, start)));
  const description = project.description === null ? [] : [h('p', 'evaluation-note', project.description)];
  return h('section', 'workspace', bar, h('div', 'card-section', ...description, h('p', 'read', next.preview)));
}

function createNotDoneYet(project: ProjectSummary, exercises: ExerciseItem[]): HTMLElement {
  const label = h('div', 'direction-label', h('span', 'language-name', 'Not done yet'));
  const bar = h('div', 'direction-bar is-single', h('div', 'bar-half is-tinted', label));
  const rows = exercises.map((exercise) => {
    const meta = exercise.topic === null ? exercise.label : `${exercise.label} · ${exercise.topic}`;
    return link(exerciseHref(project, exercise), 'list-row', h('div', 'text', exercise.preview), h('div', 'meta', meta));
  });
  return h('section', 'workspace', bar, h('div', '', ...rows));
}

// ---- Export, Archive, Delete ----

function projectActions(page: Page, project: ProjectSummary): HTMLElement[] {
  const exportLink = Object.assign(link(exportUrl(project.key), 'ghost-button', 'Export'), { download: `${project.key}.json` });
  exportLink.title = 'Download the project as a file you can edit and import again';
  const isArchived = project.archivedAt !== null;
  const archive = button('ghost-button', isArchived ? 'Unarchive' : 'Archive', () => void toggleArchived(page, project));
  archive.title = isArchived ? 'Show it in the list of projects again' : 'Hide it from the list of projects; nothing is deleted';
  const remove = button('ghost-button', 'Delete', () => void deleteThisProject(page, project));
  return [exportLink, archive, remove];
}

async function toggleArchived(page: Page, project: ProjectSummary): Promise<void> {
  let archivedAt: string | null = null;
  if (project.archivedAt === null) archivedAt = new Date().toISOString();
  const input = { name: project.name, description: project.description, archivedAt };
  try {
    await putProject(project.key, input, page.signal);
  } catch (error) {
    if (!page.signal.aborted) alert(`Could not change the project: ${errorText(error)}`);
    return;
  }
  reloadView();
}

// Asks first. A project with attempts asks a second time, because its attempts are deleted too.
async function deleteThisProject(page: Page, project: ProjectSummary): Promise<void> {
  if (!confirm(`Delete “${project.name}” and its ${pluralize(project.exerciseCount, 'exercise')}? This cannot be undone.`)) return;
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
    } catch (secondError) {
      if (!page.signal.aborted) alert(`Could not delete the project: ${errorText(secondError)}`);
      return;
    }
  }
  location.hash = '#/';
}
