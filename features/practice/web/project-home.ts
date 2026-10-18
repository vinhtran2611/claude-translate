// #/p/<project> : the next exercise to do and what is not done yet.
import type { ExerciseItem } from '../api.ts';
import { readProject } from './client.ts';
import { h, link } from './dom.ts';
import { pluralize } from './format.ts';
import type { Page } from './page.ts';
import { projectToolbar, showSide } from './side.ts';

export async function showProjectHome(page: Page, project_id: number): Promise<void> {
  const detail = await readProject(project_id, page.signal);
  const { project } = detail;
  showSide(detail, {});
  page.setTitle(project.name);
  const [next, ...later] = detail.exercises.filter((exercise) => !exercise.done);
  const exerciseLink = (exercise: ExerciseItem, class_name: string, ...children: (Node | string)[]) => link(`#/p/${project_id}/x/${exercise.id}`, class_name, ...children);
  const add = link(`#/p/${project_id}/add`, 'ghost-button', 'Add exercises…');
  page.main.append(projectToolbar(detail));
  if (next === undefined) {
    page.main.append(h('section', 'workspace',
      h('div', 'direction-bar is-single', h('div', 'bar-half is-actions', h('div', 'direction-label', h('span', 'language-name', 'All done')), h('div', 'bar-actions', add))),
      h('p', 'card-section evaluation-note', 'Well done: you have done every exercise. Open one from the History to look at it again, or add more exercises.')));
    return;
  }
  const description = project.description === '' ? [] : [h('p', 'evaluation-note', project.description)];
  page.main.append(h('section', 'workspace',
    h('div', 'direction-bar is-single', h('div', 'bar-half is-actions',
      h('div', 'direction-label', h('span', 'direction-role', 'Next up'), h('span', 'language-name', next.kind)),
      h('div', 'bar-actions', h('span', 'run-info', `${pluralize(later.length + 1, 'exercise')} left`), add, exerciseLink(next, 'primary-button', 'Start')))),
    h('div', 'card-section', ...description, h('p', 'read', next.preview))));
  if (later.length > 0) {
    page.main.append(h('section', 'workspace',
      h('div', 'direction-bar is-single', h('div', 'bar-half is-tinted', h('div', 'direction-label', h('span', 'language-name', 'Not done yet')))),
      h('div', '', ...later.map((exercise) => exerciseLink(exercise, 'list-row',
        h('div', 'text', exercise.preview), h('div', 'meta', exercise.topic === null ? exercise.kind : `${exercise.kind} · ${exercise.topic}`))))));
  }
}
