// The Practice page: the exercise list with type filters, the import dialog, the writing screen and an attempt with its
// feedback. Routes are hashes, so Back works: #/ (list), #/exercise/<id> (write) and #/attempt/<n> (an answer and its
// feedback).
import { createElement, fetchJson, readStored, requiredElement, writeStored } from '../../../shared/web/ui.ts';
import type {
  AttemptDetail, CreateAttemptRequest, Exercise, ExerciseDetail, ExerciseSummary, ExerciseType, Feedback, ImportProblem, ImportResult,
} from '../api.ts';
import { categoryLabelOf } from '../categories.ts';

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
const MEANING_LABELS: Record<string, string> = { complete: 'Meaning complete', minor_loss: 'Meaning: small loss', major_loss: 'Meaning: main idea lost' };
const MODEL_LABELS: Record<string, string> = { 'claude-opus-5-5': 'Opus 5.5', 'claude-sonnet-5-5': 'Sonnet 5.5', 'claude-haiku-5-5': 'Haiku 5.5' };
const FILTER_STORAGE_KEY = 'practice.filter';
const DRAFT_STORAGE_PREFIX = 'practice.draft.';
const EXERCISE_HASH = /^#\/exercise\/([a-z0-9][a-z0-9-]{0,63})$/;
const ATTEMPT_HASH = /^#\/attempt\/(\d+)$/;
const POLL_INTERVAL_MS = 1000;

const home_view = requiredElement('#home-view', HTMLElement);
const exercise_view = requiredElement('#exercise-view', HTMLElement);
const filters_element = requiredElement('#filters', HTMLElement);
const start_row = requiredElement('#start-row', HTMLElement);
const start_button = requiredElement('#start-button', HTMLButtonElement);
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
// What ⌘↵ does on the current screen: submit the answer, or open the next exercise; null when nothing.
let primary_action: (() => void) | null = null;
// Each route() call bumps this; a slower, older render sees it changed and stops (no late overwrite, no stray polling).
let route_generation = 0;

function formatSeconds(duration_ms: number): string {
  return `${Math.round(duration_ms / 1000)}s`;
}

function countWords(text: string): number {
  const words = text.trim().split(/\s+/);
  return words[0] === '' ? 0 : words.length;
}

function lastAttemptStatus(exercise: ExerciseSummary): { text: string; class_name: string } {
  const { last_attempt } = exercise;
  if (last_attempt === null) return { text: 'new', class_name: 'is-new' };
  if (last_attempt.status === 'grading') return { text: 'grading…', class_name: '' };
  if (last_attempt.status === 'failed') return { text: 'not graded', class_name: 'is-failed' };
  const error_count = last_attempt.error_count ?? 0;
  return { text: error_count === 0 ? 'no errors' : `${error_count} ${error_count === 1 ? 'error' : 'errors'}`, class_name: '' };
}

// The first gradable exercise with no attempt yet, of `type` (or any type), in list order; after `after_id` when given.
function nextNewExercise(type: ExerciseType | 'all', after_id: string | null = null): ExerciseSummary | null {
  const start_index = after_id === null ? 0 : exercises.findIndex((exercise) => exercise.id === after_id) + 1;
  const candidates = [...exercises.slice(start_index), ...exercises.slice(0, start_index)];
  return candidates.find((exercise) => exercise.is_gradable && exercise.attempt_count === 0 && (type === 'all' || exercise.type === type) &&
    exercise.id !== after_id) ?? null;
}

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
  link.href = exercise.last_attempt === null ? `#/exercise/${exercise.id}` : `#/attempt/${exercise.last_attempt.id}`;
  const status = lastAttemptStatus(exercise);
  link.append(
    createElement('span', 'exercise-id', exercise.id),
    createElement('span', 'exercise-title', exercise.title),
    createElement('span', `exercise-status ${status.class_name}`, status.text),
  );
  link.title = exercise.topic === null ? exercise.title : `${exercise.title}\nTopic: ${exercise.topic}`;
  item.append(link);
  return item;
}

function renderHome(): void {
  // A remembered filter whose type is no longer imported falls back to All.
  if (filter !== 'all' && !exercises.some((exercise) => exercise.type === filter)) filter = 'all';
  renderFilters();
  const next_exercise = nextNewExercise(filter);
  start_row.hidden = next_exercise === null;
  primary_action = null;
  if (next_exercise !== null) {
    start_button.replaceChildren(`Start next: ${TYPE_LABELS[next_exercise.type]} · ${next_exercise.id}`, createElement('span', 'shortcut-hint', '⌘↵'));
    primary_action = () => { location.hash = `#/exercise/${next_exercise.id}`; };
  }
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

function createField(label: string, value: string | HTMLElement, class_name = 'field'): HTMLElement {
  const field = createElement('div', class_name);
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

function exerciseHead(exercise: Exercise): HTMLElement {
  const head = createElement('div', 'detail-head');
  head.append(createElement('h2', '', TYPE_LABELS[exercise.type]), createElement('span', 'detail-meta', [exercise.id, exercise.topic].filter(Boolean).join(' · ')));
  return head;
}

function exerciseSide(exercise: Exercise): HTMLElement {
  const side = createElement('div', 'work-side');
  side.append(exerciseHead(exercise), ...exerciseFields(exercise));
  return side;
}

// A type this version cannot grade yet: the exercise only.
function renderReadOnlyExercise(exercise: Exercise): void {
  const detail = createElement('div', 'detail');
  const fields = exerciseFields(exercise);
  if (exercise.focus !== undefined && exercise.focus.length > 0) {
    const focus_list = createElement('ul', 'focus-list');
    focus_list.append(...exercise.focus.map((point) => createElement('li', '', point)));
    fields.push(createField('Focus', focus_list));
  }
  detail.append(exerciseHead(exercise), ...fields, createElement('p', 'note', 'Writing and feedback for this type come in a later version.'));
  exercise_detail.replaceChildren(detail);
}

function renderWriting(exercise: Exercise): void {
  const opened_at = Date.now();
  const draft_key = `${DRAFT_STORAGE_PREFIX}${exercise.id}`;
  const answer_side = createElement('div', 'work-side');
  const answer_box = createElement('textarea', `answer-box${exercise.type === 'sentence_translation' ? '' : ' is-long'}`);
  answer_box.setAttribute('aria-label', 'Your English');
  // The browser must not fix your mistakes for you.
  answer_box.spellcheck = false;
  answer_box.setAttribute('autocorrect', 'off');
  answer_box.setAttribute('autocapitalize', 'off');
  answer_box.placeholder = 'Write your English translation here.';
  answer_box.value = readStored(draft_key) ?? '';
  const footer = createElement('div', 'work-footer');
  const note = createElement('span', 'footer-note');
  const submit_button = createElement('button', 'primary-button');
  submit_button.append('Submit', createElement('span', 'shortcut-hint', '⌘↵'));
  footer.append(note, submit_button);
  answer_side.append(createElement('p', 'field-label', 'Your English'), answer_box, footer);

  const updateFooter = (): void => {
    const word_count = countWords(answer_box.value);
    note.textContent = `${word_count} ${word_count === 1 ? 'word' : 'words'}`;
    submit_button.disabled = answer_box.value.trim() === '';
  };
  // Saved on every change, so a closed tab never loses an answer; cleared once the server has it.
  answer_box.addEventListener('input', () => {
    writeStored(draft_key, answer_box.value);
    updateFooter();
  });
  const submit = async (): Promise<void> => {
    if (answer_box.value.trim() === '' || submit_button.dataset.busy === 'true') return;
    submit_button.dataset.busy = 'true';
    submit_button.disabled = true;
    note.textContent = 'Saving…';
    const request: CreateAttemptRequest = { exercise_id: exercise.id, answer: { text: answer_box.value }, writing_ms: Date.now() - opened_at };
    try {
      const { attempt_id } = await fetchJson<{ attempt_id: number }>('/api/practice/attempts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
      });
      try { localStorage.removeItem(draft_key); } catch { /* the draft stays; harmless */ }
      location.hash = `#/attempt/${attempt_id}`;
    } catch (error) {
      delete submit_button.dataset.busy;
      note.textContent = `Not saved: ${(error as Error).message}. Your text is kept here.`;
      submit_button.disabled = false;
    }
  };
  submit_button.addEventListener('click', () => void submit());
  primary_action = () => void submit();
  updateFooter();

  const work = createElement('div', 'work');
  work.append(exerciseSide(exercise), answer_side);
  exercise_detail.replaceChildren(work);
  answer_box.focus();
}

async function renderExercise(exercise_id: string, generation: number): Promise<void> {
  exercise_detail.replaceChildren(createElement('p', 'detail detail-meta', 'Loading…'));
  let detail: ExerciseDetail;
  try {
    [detail] = await Promise.all([fetchJson<ExerciseDetail>(`/api/practice/exercises/${exercise_id}`), loadExercises()]);
  } catch {
    exercise_detail.replaceChildren(createElement('p', 'detail detail-meta', `No exercise "${exercise_id}".`));
    return;
  }
  if (generation !== route_generation) return;
  const summary = exercises.find((exercise) => exercise.id === exercise_id);
  if (summary?.is_gradable) renderWriting(detail.exercise);
  else renderReadOnlyExercise(detail.exercise);
}

// "help → helps" with the old words struck through; an empty correction reads as a deletion.
function createErrorFix(original: string, correction: string): HTMLElement {
  const fix = createElement('span', 'error-fix');
  fix.append(createElement('del', '', original), ' → ');
  fix.append(correction === '' ? createElement('em', '', '(delete)') : createElement('ins', '', correction));
  return fix;
}

function renderFeedback(result: HTMLElement, attempt: AttemptDetail, feedback: Feedback): void {
  const status = createElement('div', 'result-status');
  const model_label = MODEL_LABELS[attempt.served_model_id ?? ''] ?? attempt.served_model_id ?? '';
  status.append(`✓ Graded · ${model_label}${attempt.grading_ms === null ? '' : ` · ${(attempt.grading_ms / 1000).toFixed(1)}s`}`);
  const summary = createElement('p', 'result-summary', feedback.summary);
  if (feedback.meaning !== undefined) summary.append(createElement('span', `meaning-badge is-${feedback.meaning}`, MEANING_LABELS[feedback.meaning]));
  result.append(status, summary);
  if (feedback.strengths.length > 0) {
    const strengths = createElement('ul', 'strengths');
    strengths.append(...feedback.strengths.map((strength) => createElement('li', '', strength)));
    result.append(strengths);
  }
  if (feedback.errors.length === 0) {
    result.append(createElement('p', 'no-errors', 'No errors found.'));
  } else {
    const list = createElement('ol', 'error-list');
    list.append(...feedback.errors.map((error) => {
      const card = createElement('li', 'error-card');
      const head = createElement('div', 'error-head');
      head.append(createErrorFix(error.original, error.correction),
        createElement('span', `error-tag is-${error.severity}`, `${categoryLabelOf(error.category)} · ${error.severity}`));
      const why = createElement('p', 'error-line');
      why.append(createElement('b', '', 'Why: '), error.explanation);
      const rule = createElement('p', 'error-line');
      rule.append(createElement('b', '', 'Remember: '), error.rule);
      card.append(head, why, rule);
      return card;
    }));
    result.append(list);
  }
  if (feedback.errors.length > 0) result.append(createField('Corrected', feedback.corrected_text, 'field version-block'));
  if (feedback.natural_version !== undefined) result.append(createField('Natural', feedback.natural_version, 'field version-block'));
  const remember = createElement('div', 'remember');
  const remember_list = createElement('ul');
  remember_list.append(...feedback.remember.map((lesson) => createElement('li', '', lesson)));
  remember.append(createElement('p', 'field-label', 'Remember today'), remember_list);
  result.append(remember);
}

function renderFailure(result: HTMLElement, attempt: AttemptDetail): void {
  const failure = createElement('div', 'failure');
  failure.append(createElement('p', 'failure-title', 'Not graded'), createElement('p', 'failure-text', `${attempt.error_message ?? 'Grading failed.'} Your answer is saved.`));
  if (attempt.raw_output !== '') {
    const raw = createElement('details', 'raw-output');
    raw.append(createElement('summary', '', "The grader's reply"), createElement('pre', '', attempt.raw_output));
    failure.append(raw);
  }
  result.append(failure);
}

// Renders the attempt, and while it is grading asks the server again every second until it is graded or failed.
async function renderAttempt(attempt_id: number, generation: number): Promise<void> {
  let attempt: AttemptDetail;
  try {
    attempt = await fetchJson<AttemptDetail>(`/api/practice/attempts/${attempt_id}`);
    // The list is needed only for Next, so it is not reloaded on every poll.
    if (attempt.status !== 'grading') await loadExercises();
  } catch {
    exercise_detail.replaceChildren(createElement('p', 'detail detail-meta', `No attempt ${attempt_id}.`));
    return;
  }
  if (generation !== route_generation) return;
  const exercise = attempt.exercise_snapshot;
  const answer_side = createElement('div', 'work-side');
  answer_side.append(createElement('p', 'field-label', 'Your English'), createElement('p', 'field-text', attempt.answer.text));
  const work = createElement('div', 'work');
  work.append(exerciseSide(exercise), answer_side);
  const result = createElement('div', 'result');
  const actions = createElement('div', 'result-actions');
  const try_again_link = createElement('a', 'ghost-button link-button', 'Try again');
  try_again_link.href = `#/exercise/${attempt.exercise_id}`;
  actions.append(try_again_link);
  primary_action = null;

  if (attempt.status === 'grading') {
    const status = createElement('div', 'result-status');
    status.append(createElement('span', 'dot'), `Grading… ${formatSeconds(Date.now() - Date.parse(attempt.submitted_at))} (your answer is saved)`);
    result.append(status);
    setTimeout(() => { if (generation === route_generation) void renderAttempt(attempt_id, generation); }, POLL_INTERVAL_MS);
  } else if (attempt.status === 'failed') {
    renderFailure(result, attempt);
    const regrade_button = createElement('button', 'primary-button', 'Grade again');
    regrade_button.addEventListener('click', async () => {
      regrade_button.disabled = true;
      try {
        await fetchJson(`/api/practice/attempts/${attempt.id}/regrade`, { method: 'POST' });
      } catch {
        // Already grading again (409) or gone: the redraw below shows which.
      }
      if (generation === route_generation) void renderAttempt(attempt.id, generation);
    });
    actions.append(regrade_button);
  } else if (attempt.feedback !== null) {
    renderFeedback(result, attempt, attempt.feedback);
  }

  if (attempt.status !== 'grading') {
    const next_exercise = nextNewExercise(exercise.type, attempt.exercise_id);
    const next_link = createElement('a', 'primary-button link-button');
    next_link.append(next_exercise === null ? 'Back to exercises' : 'Next', createElement('span', 'shortcut-hint', '⌘↵'));
    next_link.href = next_exercise === null ? '#/' : `#/exercise/${next_exercise.id}`;
    actions.append(next_link);
    primary_action = () => { location.hash = next_link.hash; };
    result.append(actions);
  }
  exercise_detail.replaceChildren(work, result);
}

async function loadExercises(): Promise<void> {
  exercises = await fetchJson<ExerciseSummary[]>('/api/practice/exercises');
}

async function route(): Promise<void> {
  const generation = ++route_generation;
  primary_action = null;
  const exercise_match = EXERCISE_HASH.exec(location.hash);
  const attempt_match = ATTEMPT_HASH.exec(location.hash);
  home_view.hidden = exercise_match !== null || attempt_match !== null;
  exercise_view.hidden = !home_view.hidden;
  if (exercise_match) {
    await renderExercise(exercise_match[1], generation);
  } else if (attempt_match) {
    exercise_detail.replaceChildren(createElement('p', 'detail detail-meta', 'Loading…'));
    await renderAttempt(Number(attempt_match[1]), generation);
  } else {
    await loadExercises();
    if (generation === route_generation) renderHome();
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

start_button.addEventListener('click', () => primary_action?.());
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
document.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !import_dialog.open && primary_action !== null) {
    event.preventDefault();
    primary_action();
  }
});

window.addEventListener('hashchange', () => void route());
void route();
