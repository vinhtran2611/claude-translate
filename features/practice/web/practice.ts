// The Practice page: the exercise list with type filters, the import dialog, and one exercise's view.
// Routes are hashes, so Back works: #/ (list) and #/exercise/<id>.
import { createElement, fetchJson, readStored, requiredElement, writeStored } from '../../../shared/web/ui.ts';
import type { Exercise, ExerciseDetail, ExerciseSummary, ExerciseType, ImportProblem, ImportResult } from '../api.ts';

const TYPE_LABELS: Record<ExerciseType, string> = {
  sentence_translation: 'Sentence translation',
  paragraph_translation: 'Paragraph translation',
  essay_translation: 'Essay translation',
  free_writing: 'Free writing',
  error_correction: 'Error correction',
};
const TYPE_ORDER = Object.keys(TYPE_LABELS) as ExerciseType[];
const ESSAY_TYPE_LABELS: Record<string, string> = {
  opinion: 'Opinion', discussion: 'Discussion', advantages_disadvantages: 'Advantages and disadvantages',
  problem_solution: 'Problem and solution', two_part: 'Two-part question',
};
const FILTER_STORAGE_KEY = 'practice.filter';
const EXERCISE_HASH = /^#\/exercise\/([a-z0-9][a-z0-9-]{0,63})$/;

const home_view = requiredElement('#home-view', HTMLElement);
const exercise_view = requiredElement('#exercise-view', HTMLElement);
const filters_element = requiredElement('#filters', HTMLElement);
const exercise_card = requiredElement('#exercise-card', HTMLElement);
const exercise_detail = requiredElement('#exercise-detail', HTMLElement);
const import_button = requiredElement('#import-button', HTMLButtonElement);
const import_dialog = requiredElement('#import-dialog', HTMLDialogElement);
const drop_zone = requiredElement('#drop-zone', HTMLElement);
const choose_file_button = requiredElement('#choose-file-button', HTMLButtonElement);
const file_input = requiredElement('#file-input', HTMLInputElement);
const import_result = requiredElement('#import-result', HTMLElement);
const copy_errors_button = requiredElement('#copy-errors-button', HTMLButtonElement);
const import_done_button = requiredElement('#import-done-button', HTMLButtonElement);

let exercises: ExerciseSummary[] = [];
// 'all' or one type; remembered in the browser.
let filter: ExerciseType | 'all' = (TYPE_ORDER as string[]).includes(readStored(FILTER_STORAGE_KEY) ?? '')
  ? readStored(FILTER_STORAGE_KEY) as ExerciseType : 'all';
// The last failed import's problems, for Copy errors.
let last_import_errors: ImportProblem[] = [];

function renderFilters(): void {
  const counts = new Map<ExerciseType | 'all', number>([['all', exercises.length]]);
  for (const exercise of exercises) counts.set(exercise.type, (counts.get(exercise.type) ?? 0) + 1);
  filters_element.replaceChildren();
  for (const option of ['all', ...TYPE_ORDER] as const) {
    if (option !== 'all' && !counts.has(option)) continue;
    const chip = createElement('button', 'chip', option === 'all' ? 'All' : TYPE_LABELS[option]);
    chip.append(createElement('span', 'chip-count', String(counts.get(option) ?? 0)));
    chip.setAttribute('aria-pressed', String(option === filter));
    chip.addEventListener('click', () => {
      filter = option;
      writeStored(FILTER_STORAGE_KEY, option);
      renderHome();
    });
    filters_element.append(chip);
  }
}

function renderEmptyState(): void {
  const empty = createElement('div', 'empty');
  empty.append(createElement('h2', '', 'No exercises yet'));
  const text = createElement('p');
  text.append('Make an exercise file with Claude (the prompt is in ', createElement('code', '', 'docs/practice-proposal.md'), ' §4.4), then import it. ');
  const example_link = createElement('a', '', 'Download the example file');
  example_link.href = '/practice/exercises.example.json';
  example_link.download = 'exercises.example.json';
  text.append(example_link, ' to see the format.');
  const button = createElement('button', 'primary-button', 'Import file');
  button.addEventListener('click', openImportDialog);
  empty.append(text, button);
  exercise_card.replaceChildren(empty);
}

function createExerciseRow(exercise: ExerciseSummary): HTMLLIElement {
  const item = createElement('li');
  const link = createElement('a', 'exercise-row');
  link.href = `#/exercise/${exercise.id}`;
  const status = exercise.attempt_count === 0 ? 'new' : `${exercise.attempt_count} ${exercise.attempt_count === 1 ? 'attempt' : 'attempts'}`;
  link.append(
    createElement('span', 'exercise-id', exercise.id),
    createElement('span', 'exercise-title', exercise.title),
    createElement('span', `exercise-status${exercise.attempt_count === 0 ? ' is-new' : ''}`, status),
  );
  link.title = exercise.topic === null ? exercise.title : `${exercise.title}\nTopic: ${exercise.topic}`;
  item.append(link);
  return item;
}

function renderHome(): void {
  // A remembered filter whose type is no longer imported falls back to All.
  if (filter !== 'all' && !exercises.some((exercise) => exercise.type === filter)) filter = 'all';
  renderFilters();
  if (exercises.length === 0) {
    renderEmptyState();
    return;
  }
  const groups = TYPE_ORDER.filter((type) => filter === 'all' || type === filter).map((type) => {
    const group_exercises = exercises.filter((exercise) => exercise.type === type);
    if (group_exercises.length === 0) return null;
    const group = createElement('section', 'group');
    const list = createElement('ol', 'exercise-list');
    list.append(...group_exercises.map(createExerciseRow));
    group.append(createElement('h2', 'group-title', TYPE_LABELS[type]), list);
    return group;
  }).filter((group) => group !== null);
  exercise_card.replaceChildren(...groups);
}

function createField(label: string, value: string | HTMLElement): HTMLElement {
  const field = createElement('div', 'field');
  field.append(createElement('p', 'field-label', label));
  field.append(typeof value === 'string' ? createElement('p', 'field-text', value) : value);
  return field;
}

// What you work from. Reference answers and planted mistakes are left out: they would give the answer away.
function exerciseFields(exercise: Exercise): HTMLElement[] {
  switch (exercise.type) {
    case 'sentence_translation':
    case 'paragraph_translation':
      return [createField('Vietnamese', exercise.text_vi)];
    case 'essay_translation':
      return [createField('Task (Vietnamese)', exercise.prompt_vi), createField('Essay (Vietnamese)', exercise.essay_vi)];
    case 'free_writing':
      return [
        createField('Task', exercise.prompt_en),
        createField('Essay type', `${ESSAY_TYPE_LABELS[exercise.essay_type]} · at least ${exercise.min_words ?? 250} words · ${exercise.time_limit_minutes ?? 40} minutes`),
      ];
    case 'error_correction':
      return [createField(`Find and fix ${exercise.mistakes.length} ${exercise.mistakes.length === 1 ? 'mistake' : 'mistakes'}`, exercise.text_en)];
  }
}

async function renderExercise(exercise_id: string): Promise<void> {
  exercise_detail.replaceChildren(createElement('p', 'detail-meta', 'Loading…'));
  let detail: ExerciseDetail;
  try {
    detail = await fetchJson<ExerciseDetail>(`/api/practice/exercises/${exercise_id}`);
  } catch {
    exercise_detail.replaceChildren(createElement('p', 'detail-meta', `No exercise "${exercise_id}".`));
    return;
  }
  const { exercise } = detail;
  const head = createElement('div', 'detail-head');
  head.append(createElement('h2', '', TYPE_LABELS[exercise.type]), createElement('span', 'detail-meta', [exercise.id, exercise.topic].filter(Boolean).join(' · ')));
  const fields = exerciseFields(exercise);
  if (exercise.focus !== undefined && exercise.focus.length > 0) {
    const focus_list = createElement('ul', 'focus-list');
    focus_list.append(...exercise.focus.map((point) => createElement('li', '', point)));
    fields.push(createField('Focus', focus_list));
  }
  exercise_detail.replaceChildren(head, ...fields, createElement('p', 'note', 'Writing your answer and getting feedback come in the next version.'));
}

async function loadExercises(): Promise<void> {
  exercises = await fetchJson<ExerciseSummary[]>('/api/practice/exercises');
}

async function route(): Promise<void> {
  const exercise_match = EXERCISE_HASH.exec(location.hash);
  home_view.hidden = exercise_match !== null;
  exercise_view.hidden = exercise_match === null;
  if (exercise_match) {
    await renderExercise(exercise_match[1]);
  } else {
    await loadExercises();
    renderHome();
  }
}

function showImportResult(file_name: string, is_error: boolean, summary: string, problems: ImportProblem[]): void {
  import_result.className = `import-result${is_error ? ' is-error' : ''}`;
  const head = createElement('div');
  head.append(createElement('span', 'result-file', file_name), `: ${summary}`);
  import_result.replaceChildren(head);
  if (problems.length > 0) {
    const list = createElement('ul', 'problem-list');
    list.append(...problems.map((problem) => {
      const item = createElement('li');
      if (problem.path !== '') item.append(createElement('span', 'problem-path', problem.path), ': ');
      item.append(problem.message);
      return item;
    }));
    import_result.append(list);
  }
}

async function importFile(file: File): Promise<void> {
  last_import_errors = [];
  copy_errors_button.hidden = true;
  showImportResult(file.name, false, 'importing…', []);
  const response = await fetch('/api/practice/exercises/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-File-Name': encodeURIComponent(file.name) },
    body: await file.text(),
  });
  if (response.ok) {
    const { added, updated, warnings } = await response.json() as ImportResult;
    const warning_text = warnings.length > 0 ? `, ${warnings.length} ${warnings.length === 1 ? 'warning' : 'warnings'}` : '';
    showImportResult(file.name, false, `${added} added, ${updated} updated${warning_text}`, warnings);
    await loadExercises();
    renderHome();
  } else {
    const body = await response.json().catch(() => ({ errors: [{ path: '', message: `HTTP ${response.status}` }] })) as { errors: ImportProblem[] };
    last_import_errors = body.errors;
    copy_errors_button.hidden = false;
    copy_errors_button.textContent = 'Copy errors';
    showImportResult(file.name, true, `${body.errors.length} ${body.errors.length === 1 ? 'error' : 'errors'}, nothing imported`, body.errors);
  }
}

function openImportDialog(): void {
  import_result.replaceChildren();
  copy_errors_button.hidden = true;
  import_dialog.showModal();
}

import_button.addEventListener('click', openImportDialog);
choose_file_button.addEventListener('click', () => file_input.click());
file_input.addEventListener('change', () => {
  const [file] = file_input.files ?? [];
  file_input.value = '';
  if (file) void importFile(file);
});
drop_zone.addEventListener('dragover', (event) => {
  event.preventDefault();
  drop_zone.classList.add('is-over');
});
drop_zone.addEventListener('dragleave', () => drop_zone.classList.remove('is-over'));
drop_zone.addEventListener('drop', (event) => {
  event.preventDefault();
  drop_zone.classList.remove('is-over');
  const [file] = event.dataTransfer?.files ?? [];
  if (file) void importFile(file);
});
// Pasted back to Claude, the list says exactly what to fix in the file.
copy_errors_button.addEventListener('click', async () => {
  const text = last_import_errors.map((problem) => `${problem.path === '' ? '' : `${problem.path}: `}${problem.message}`).join('\n');
  await navigator.clipboard.writeText(`Fix these errors in the exercise file:\n${text}`);
  copy_errors_button.textContent = 'Copied';
});
import_done_button.addEventListener('click', () => import_dialog.close());

window.addEventListener('hashchange', () => void route());
void route();
