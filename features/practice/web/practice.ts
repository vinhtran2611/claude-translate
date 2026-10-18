// The Practice page: the exercise list with type filters, the import dialog, the writing screen, an attempt with its
// feedback, and the history of attempts. Routes are hashes, so Back works: #/ (list), #/exercise/<id> (write),
// #/attempt/<n> (an answer and its feedback) and #/history.
import { createElement, dateGroupOf, fetchJson, readStored, requiredElement, writeStored } from '../../../shared/web/ui.ts';
import type {
  AttemptDetail, AttemptStatus, AttemptSummary, Bands, CreateAttemptRequest, Exercise, ExerciseDetail, ExerciseSummary, ExerciseType, Feedback, ImportProblem, ImportResult,
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
const CRITERION_LABELS: Record<keyof Bands, string> = {
  task_response: 'Task Response', coherence_cohesion: 'Coherence & Cohesion', lexical_resource: 'Lexical Resource',
  grammatical_range_accuracy: 'Grammatical Range & Accuracy',
};
const CRITERION_ORDER = Object.keys(CRITERION_LABELS) as (keyof Bands)[];
const MODEL_LABELS: Record<string, string> = { 'claude-opus-5-5': 'Opus 5.5', 'claude-sonnet-5-5': 'Sonnet 5.5', 'claude-haiku-5-5': 'Haiku 5.5' };
const FILTER_STORAGE_KEY = 'practice.filter';
const HISTORY_FILTER_STORAGE_KEY = 'practice.history_filter';
const DRAFT_STORAGE_PREFIX = 'practice.draft.';
const EXERCISE_HASH = /^#\/exercise\/([a-z0-9][a-z0-9-]{0,63})$/;
const ATTEMPT_HASH = /^#\/attempt\/(\d+)$/;
const HISTORY_HASH = '#/history';
const POLL_INTERVAL_MS = 1000;

const home_view = requiredElement('#home-view', HTMLElement);
const exercise_view = requiredElement('#exercise-view', HTMLElement);
const history_view = requiredElement('#history-view', HTMLElement);
const history_filters_element = requiredElement('#history-filters', HTMLElement);
const history_card = requiredElement('#history-card', HTMLElement);
const back_link = requiredElement('#back-link', HTMLAnchorElement);
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
let history_filter: ExerciseType | 'all' = (TYPE_ORDER as string[]).includes(readStored(HISTORY_FILTER_STORAGE_KEY) ?? '')
  ? readStored(HISTORY_FILTER_STORAGE_KEY) as ExerciseType : 'all';
// Where "←" on an exercise or attempt goes back to: the list or History, whichever was shown last.
let last_list_hash = '#/';
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

// overall_band (free writing) is shown instead of the error count when there is one.
function attemptStatus(status: AttemptStatus, error_count: number | null, overall_band: number | null = null): { text: string; class_name: string } {
  if (status === 'grading') return { text: 'grading…', class_name: '' };
  if (status === 'failed') return { text: 'not graded', class_name: 'is-failed' };
  if (overall_band !== null) return { text: `band ${overall_band.toFixed(1)}`, class_name: '' };
  return { text: error_count === 0 ? 'no errors' : `${error_count} ${error_count === 1 ? 'error' : 'errors'}`, class_name: '' };
}

function lastAttemptStatus(exercise: ExerciseSummary): { text: string; class_name: string } {
  const { last_attempt } = exercise;
  return last_attempt === null ? { text: 'new', class_name: 'is-new' } : attemptStatus(last_attempt.status, last_attempt.error_count, last_attempt.overall_band);
}

// The first gradable exercise with no attempt yet, of `type` (or any type), in list order; after `after_id` when given.
function nextNewExercise(type: ExerciseType | 'all', after_id: string | null = null): ExerciseSummary | null {
  const start_index = after_id === null ? 0 : exercises.findIndex((exercise) => exercise.id === after_id) + 1;
  const candidates = [...exercises.slice(start_index), ...exercises.slice(0, start_index)];
  return candidates.find((exercise) => exercise.is_gradable && exercise.attempt_count === 0 && (type === 'all' || exercise.type === type) &&
    exercise.id !== after_id) ?? null;
}

// One chip for All and one per type present in `types`, each with its count; onPick gets the chosen one.
function renderTypeChips(container: HTMLElement, types: ExerciseType[], current: ExerciseType | 'all', onPick: (option: ExerciseType | 'all') => void): void {
  const counts = new Map<ExerciseType | 'all', number>([['all', types.length]]);
  for (const type of types) counts.set(type, (counts.get(type) ?? 0) + 1);
  container.replaceChildren();
  for (const option of ['all', ...TYPE_ORDER] as const) {
    if (option !== 'all' && !counts.has(option)) continue;
    const chip = createElement('button', 'chip', option === 'all' ? 'All' : TYPE_LABELS[option]);
    chip.append(createElement('span', 'chip-count', String(counts.get(option) ?? 0)));
    chip.setAttribute('aria-pressed', String(option === current));
    chip.addEventListener('click', () => onPick(option));
    container.append(chip);
  }
}

function renderFilters(): void {
  renderTypeChips(filters_element, exercises.map((exercise) => exercise.type), filter, (option) => {
    filter = option;
    writeStored(FILTER_STORAGE_KEY, option);
    renderHome();
  });
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

// A text box the browser must not correct: spellcheck, autocorrect and autocapitalize would fix your mistakes for you.
function createAnswerBox(label: string, size_class: string, placeholder: string, draft_key: string): HTMLTextAreaElement {
  const box = createElement('textarea', `answer-box ${size_class}`);
  box.setAttribute('aria-label', label);
  box.spellcheck = false;
  box.setAttribute('autocorrect', 'off');
  box.setAttribute('autocapitalize', 'off');
  box.placeholder = placeholder;
  box.value = readStored(draft_key) ?? '';
  // Saved on every change, so a closed tab never loses an answer; cleared once the server has it.
  box.addEventListener('input', () => writeStored(draft_key, box.value));
  return box;
}

function formatClock(duration_ms: number): string {
  const total_seconds = Math.floor(duration_ms / 1000);
  return `${Math.floor(total_seconds / 60)}:${String(total_seconds % 60).padStart(2, '0')}`;
}

const ANSWER_BOX_SIZES: Record<ExerciseType, string> = {
  sentence_translation: '', paragraph_translation: 'is-long', essay_translation: 'is-essay', free_writing: 'is-essay', error_correction: 'is-long',
};

function renderWriting(exercise: Exercise, generation: number): void {
  const opened_at = Date.now();
  const draft_key = `${DRAFT_STORAGE_PREFIX}${exercise.id}`;
  const prompt_draft_key = `${draft_key}.prompt`;
  const answer_side = createElement('div', 'work-side');
  // Essay translation has a second, small box for the task; every other type has one box.
  const prompt_box = exercise.type === 'essay_translation'
    ? createAnswerBox('Task in English', 'is-short', 'Translate the task here.', prompt_draft_key) : null;
  const answer_box = createAnswerBox(
    exercise.type === 'free_writing' ? 'Your essay' : exercise.type === 'essay_translation' ? 'Essay in English' : 'Your English',
    ANSWER_BOX_SIZES[exercise.type],
    exercise.type === 'free_writing' ? 'Write your essay here.' : exercise.type === 'essay_translation' ? 'Translate the essay here.' : 'Write your English translation here.',
    draft_key,
  );
  const footer = createElement('div', 'work-footer');
  const note = createElement('span', 'footer-note');
  const submit_button = createElement('button', 'primary-button');
  submit_button.append('Submit', createElement('span', 'shortcut-hint', '⌘↵'));
  footer.append(note, submit_button);
  if (prompt_box !== null) answer_side.append(createElement('p', 'field-label', 'Task in English'), prompt_box, createElement('p', 'field-label box-gap', 'Essay in English'));
  else answer_side.append(createElement('p', 'field-label', exercise.type === 'free_writing' ? 'Your essay' : 'Your English'));
  answer_side.append(answer_box, footer);

  const min_words = exercise.type === 'free_writing' ? exercise.min_words ?? 250 : null;
  const isReady = (): boolean => answer_box.value.trim() !== '' && (prompt_box === null || prompt_box.value.trim() !== '');
  const updateFooter = (): void => {
    if (submit_button.dataset.busy === 'true') return;
    const word_count = countWords(answer_box.value);
    const words_text = `${word_count} ${word_count === 1 ? 'word' : 'words'}${min_words === null ? '' : ` of ${min_words}`}`;
    // Free writing shows the time you have spent; it is never a limit.
    note.textContent = exercise.type === 'free_writing' ? `${words_text} · ${formatClock(Date.now() - opened_at)}` : words_text;
    note.classList.toggle('is-under', min_words !== null && word_count < min_words);
    submit_button.disabled = !isReady();
  };
  for (const box of [prompt_box, answer_box]) box?.addEventListener('input', updateFooter);
  if (exercise.type === 'free_writing') {
    const timer = setInterval(() => {
      if (generation !== route_generation || submit_button.dataset.busy === 'true') clearInterval(timer);
      else updateFooter();
    }, 1000);
  }
  const submit = async (): Promise<void> => {
    if (!isReady() || submit_button.dataset.busy === 'true') return;
    submit_button.dataset.busy = 'true';
    submit_button.disabled = true;
    note.textContent = 'Saving…';
    const answer = prompt_box === null ? { text: answer_box.value } : { text: answer_box.value, prompt_text: prompt_box.value };
    const request: CreateAttemptRequest = { exercise_id: exercise.id, answer, writing_ms: Date.now() - opened_at };
    try {
      const { attempt_id } = await fetchJson<{ attempt_id: number }>('/api/practice/attempts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
      });
      try {
        localStorage.removeItem(draft_key);
        localStorage.removeItem(prompt_draft_key);
      } catch { /* the draft stays; harmless */ }
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
  (prompt_box ?? answer_box).focus();
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
  if (summary?.is_gradable) renderWriting(detail.exercise, generation);
  else renderReadOnlyExercise(detail.exercise);
}

// "help → helps" with the old words struck through; an empty correction reads as a deletion.
function createErrorFix(original: string, correction: string): HTMLElement {
  const fix = createElement('span', 'error-fix');
  fix.append(createElement('del', '', original), ' → ');
  fix.append(correction === '' ? createElement('em', '', '(delete)') : createElement('ins', '', correction));
  return fix;
}

// The estimated bands: the overall band (free writing) and each criterion with why and what to do next.
function createBandBlock(bands: Bands, overall_band: number | null): HTMLElement {
  const block = createElement('div', 'band-block');
  const head = createElement('div', 'band-head');
  if (overall_band !== null) head.append(createElement('span', 'band-overall', `Estimated band ${overall_band.toFixed(1)}`));
  else head.append(createElement('span', 'band-overall', 'Estimated bands'));
  head.append(createElement('span', 'band-note', 'an estimate, not an official score'));
  block.append(head);
  const list = createElement('ul', 'criterion-list');
  for (const criterion of CRITERION_ORDER) {
    const entry = bands[criterion];
    if (entry === undefined) continue;
    const item = createElement('li', 'criterion');
    const title = createElement('div', 'criterion-title');
    title.append(createElement('span', '', CRITERION_LABELS[criterion]), createElement('span', 'criterion-band', entry.band.toFixed(1)));
    const next_step = createElement('p', 'error-line');
    next_step.append(createElement('b', '', 'Next: '), entry.next_step);
    item.append(title, createElement('p', 'error-line', entry.comment), next_step);
    list.append(item);
  }
  block.append(list);
  return block;
}

function renderFeedback(result: HTMLElement, attempt: AttemptDetail, feedback: Feedback): void {
  const status = createElement('div', 'result-status');
  const model_label = MODEL_LABELS[attempt.served_model_id ?? ''] ?? attempt.served_model_id ?? '';
  status.append(`✓ Graded · ${model_label}${attempt.grading_ms === null ? '' : ` · ${(attempt.grading_ms / 1000).toFixed(1)}s`}`);
  const summary = createElement('p', 'result-summary', feedback.summary);
  if (feedback.meaning !== undefined) summary.append(createElement('span', `meaning-badge is-${feedback.meaning}`, MEANING_LABELS[feedback.meaning]));
  result.append(status);
  if (feedback.bands !== undefined) result.append(createBandBlock(feedback.bands, attempt.overall_band));
  result.append(summary);
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
        createElement('span', `error-tag is-${error.severity}`,
          `${error.part === undefined ? '' : `${error.part === 'prompt' ? 'Task' : 'Essay'} · `}${categoryLabelOf(error.category)} · ${error.severity}`));
      const why = createElement('p', 'error-line');
      why.append(createElement('b', '', 'Why: '), error.explanation);
      const rule = createElement('p', 'error-line');
      rule.append(createElement('b', '', 'Remember: '), error.rule);
      card.append(head, why, rule);
      return card;
    }));
    result.append(list);
  }
  if (feedback.corrected_prompt_text !== undefined && feedback.errors.some((error) => error.part === 'prompt')) {
    result.append(createField('Corrected task', feedback.corrected_prompt_text, 'field version-block'));
  }
  const has_text_errors = feedback.errors.some((error) => error.part !== 'prompt');
  if (has_text_errors) result.append(createField(feedback.corrected_prompt_text === undefined ? 'Corrected' : 'Corrected essay', feedback.corrected_text, 'field version-block'));
  if (feedback.natural_version !== undefined) result.append(createField('Natural', feedback.natural_version, 'field version-block'));
  const remember = createElement('div', 'remember');
  const remember_list = createElement('ul');
  remember_list.append(...feedback.remember.map((lesson) => createElement('li', '', lesson)));
  remember.append(createElement('p', 'field-label', 'Remember today'), remember_list);
  result.append(remember);
  // Shown only after grading, so it cannot shape what you write.
  const exercise = attempt.exercise_snapshot;
  if (exercise.type === 'free_writing' && exercise.sample_essay_en !== undefined) {
    const sample = createElement('details', 'sample-essay');
    sample.append(createElement('summary', '', 'Sample essay'), createElement('p', 'field-text', exercise.sample_essay_en));
    result.append(sample);
  }
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
  if (attempt.answer.prompt_text !== undefined) {
    answer_side.append(createField('Task in English', attempt.answer.prompt_text), createField('Essay in English', attempt.answer.text));
  } else {
    answer_side.append(createField(exercise.type === 'free_writing' ? 'Your essay' : 'Your English', attempt.answer.text));
  }
  const words_text = `${attempt.word_count} ${attempt.word_count === 1 ? 'word' : 'words'}`;
  answer_side.append(createElement('p', 'footer-note', attempt.writing_ms === null ? words_text : `${words_text} · written in ${formatClock(attempt.writing_ms)}`));
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

function formatClockTime(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function createHistoryRow(attempt: AttemptSummary, generation: number): HTMLLIElement {
  const item = createElement('li');
  const link = createElement('a', 'history-row');
  link.href = `#/attempt/${attempt.id}`;
  const status = attemptStatus(attempt.status, attempt.error_count, attempt.overall_band);
  const end = createElement('span', 'history-end');
  end.append(createElement('span', `exercise-status ${status.class_name}`, status.text));
  if (attempt.status === 'failed') {
    const regrade_button = createElement('button', 'ghost-button', 'Grade again');
    regrade_button.addEventListener('click', async (event) => {
      // The row is a link; this button grades here instead of opening it.
      event.preventDefault();
      regrade_button.disabled = true;
      try {
        await fetchJson(`/api/practice/attempts/${attempt.id}/regrade`, { method: 'POST' });
      } catch {
        // Already grading again (409) or gone: the redraw below shows which.
      }
      if (generation === route_generation) void renderHistory(generation);
    });
    end.append(regrade_button);
  }
  link.append(
    createElement('span', 'history-time', formatClockTime(attempt.submitted_at)),
    createElement('span', 'history-type', TYPE_LABELS[attempt.exercise_type]),
    createElement('span', 'exercise-id', attempt.exercise_id),
    createElement('span', 'exercise-title', attempt.title),
    end,
  );
  link.title = `${attempt.title}\n${new Date(attempt.submitted_at).toLocaleString('en-GB')}`;
  item.append(link);
  return item;
}

// Every attempt, newest first, grouped by day; while one is grading the list is asked for again every second.
async function renderHistory(generation: number): Promise<void> {
  const attempts = await fetchJson<AttemptSummary[]>('/api/practice/attempts');
  if (generation !== route_generation) return;
  if (history_filter !== 'all' && !attempts.some((attempt) => attempt.exercise_type === history_filter)) history_filter = 'all';
  renderTypeChips(history_filters_element, attempts.map((attempt) => attempt.exercise_type), history_filter, (option) => {
    history_filter = option;
    writeStored(HISTORY_FILTER_STORAGE_KEY, option);
    void renderHistory(route_generation);
  });
  const shown_attempts = attempts.filter((attempt) => history_filter === 'all' || attempt.exercise_type === history_filter);
  if (shown_attempts.length === 0) {
    const empty = createElement('div', 'empty');
    empty.append(createElement('h2', '', 'No attempts yet'), createElement('p', '', 'Every answer you submit is kept here with its feedback.'));
    history_card.replaceChildren(empty);
  } else {
    const groups = new Map<string, AttemptSummary[]>();
    for (const attempt of shown_attempts) {
      const label = dateGroupOf(attempt.submitted_at);
      groups.set(label, [...(groups.get(label) ?? []), attempt]);
    }
    history_card.replaceChildren(...[...groups].map(([label, group_attempts]) => {
      const group = createElement('section', 'group');
      const list = createElement('ol', 'exercise-list');
      list.append(...group_attempts.map((attempt) => createHistoryRow(attempt, generation)));
      group.append(createElement('h2', 'group-title', label), list);
      return group;
    }));
  }
  if (attempts.some((attempt) => attempt.status === 'grading')) {
    setTimeout(() => { if (generation === route_generation) void renderHistory(generation); }, POLL_INTERVAL_MS);
  }
}

async function loadExercises(): Promise<void> {
  exercises = await fetchJson<ExerciseSummary[]>('/api/practice/exercises');
}

async function route(): Promise<void> {
  const generation = ++route_generation;
  primary_action = null;
  const exercise_match = EXERCISE_HASH.exec(location.hash);
  const attempt_match = ATTEMPT_HASH.exec(location.hash);
  const is_history = location.hash === HISTORY_HASH;
  home_view.hidden = exercise_match !== null || attempt_match !== null || is_history;
  history_view.hidden = !is_history;
  exercise_view.hidden = exercise_match === null && attempt_match === null;
  if (home_view.hidden === false) last_list_hash = '#/';
  if (is_history) last_list_hash = HISTORY_HASH;
  back_link.href = last_list_hash;
  back_link.textContent = last_list_hash === HISTORY_HASH ? '← History' : '← Exercises';
  if (is_history) {
    history_card.replaceChildren(createElement('p', 'detail detail-meta', 'Loading…'));
    await renderHistory(generation);
  } else if (exercise_match) {
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
