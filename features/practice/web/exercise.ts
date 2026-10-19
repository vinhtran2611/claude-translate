// #/p/<project>/x/<exercise> (answer it) and #/a/<attempt> (look at an old attempt): the page every type shares. A card holds
// the Problem and Your answer side by side; the Evaluation card is below it, across the full width. The phases: answering,
// grading (the AI is working, its words streaming in), graded, failed. A template draws the insides of the panes (./templates/);
// this file draws the cards, the buttons and the phases.
import { createModelPicker, type ModelPicker } from '../../../shared/web/model-picker.ts';
import type { AiResult, AnswerByType, Attempt, AttemptStatus, ExerciseBody, ExerciseType } from '../api.ts';
import { kindOf } from '../text.ts';
import {
  ApiError, deleteExercise, errorText, readAttempt, readExercise, readGradingOptions, readProjectView, regrade, submitAttempt, watchGrading, type ProjectView,
} from './client.ts';
import { button, h, link } from './dom.ts';
import { clearDraft, readDraft, writeDraft } from './drafts.ts';
import { createEvaluation } from './evaluation.ts';
import { formatDateTime } from './format.ts';
import { sleep, type Page } from './page.ts';
import { projectToolbar, showSide } from './side.ts';
import { templateOf } from './templates/index.ts';
import type { View } from './templates/types.ts';

// How long to wait before following a grading again, when the stream broke while it was still going.
const FOLLOW_RETRY_MS = 1_500;
const PICKER_STORAGE_KEY = 'practice.grading';

type Answer = AnswerByType[ExerciseType];

interface Start {
  exercise_key: string;
  // Drafts in the browser are kept under it. null once the exercise is deleted (only an old attempt can show that).
  exercise_id: number | null;
  // What the page shows: the exercise as it is now, or as the attempt saw it.
  exercise: ExerciseBody;
  // The version shown. It is sent with the answer, so a change made meanwhile is caught (409 exercise_changed).
  version: number;
  // The attempt being reopened; null for a new answer.
  attempt: Attempt | null;
}

// One picker for the whole page: its menu lives in the document, and the choice is the same for every exercise.
let picker: ModelPicker | null = null;
async function gradingPicker(signal: AbortSignal): Promise<ModelPicker> {
  picker ??= createModelPicker(await readGradingOptions(signal), PICKER_STORAGE_KEY, document.body);
  return picker;
}

export async function showExercise(page: Page, project_key: string, exercise_key: string): Promise<void> {
  const [view, exercise, model_picker] = await Promise.all([
    readProjectView(project_key, page.signal),
    readExercise(project_key, exercise_key, page.signal),
    gradingPicker(page.signal),
  ]);
  const start: Start = { exercise_key, exercise_id: exercise.id, exercise, version: exercise.version, attempt: null };
  openScreen(page, view, start, model_picker);
}

export async function showAttempt(page: Page, attempt_id_text: string): Promise<void> {
  const attempt = await readAttempt(Number(attempt_id_text), page.signal);
  const [view, model_picker] = await Promise.all([readProjectView(attempt.project, page.signal), gradingPicker(page.signal)]);
  const current = view.exercises.find((item) => item.key === attempt.exercise);
  const start: Start = {
    exercise_key: attempt.exercise, exercise_id: current?.id ?? null, exercise: attempt.snapshot, version: attempt.exercise_version, attempt,
  };
  openScreen(page, view, start, model_picker);
}

function openScreen(page: Page, first_view: ProjectView, start: Start, model_picker: ModelPicker): void {
  const { signal } = page;
  const { exercise_key, exercise_id, exercise, version, attempt: reopened } = start;
  const template = templateOf(exercise.type);
  const project_key = first_view.project.key;
  const is_review = reopened !== null;
  const is_exercise_deleted = exercise_id === null;
  // Only a new answer keeps a draft: an old attempt is read-only.
  const draft_id = is_review ? null : exercise_id;
  const opened_at = Date.now();
  let view = first_view;
  let attempt = reopened;
  let phase: AttemptStatus | 'answering' = reopened?.status ?? 'answering';
  let answer: Answer = reopened?.answer ?? template.empty(exercise);
  if (draft_id !== null) answer = readDraft(draft_id, exercise.type, template.empty(exercise)) ?? answer;
  let is_revealed = false;
  let is_sending = false;
  let is_following = false;
  let clock: ReturnType<typeof setInterval> | undefined;
  let status_line = h('p', 'footer-note');
  let submit_button: HTMLButtonElement | null = null;
  let submit_error = h('p', 'form-error');

  let toolbar = createToolbar();
  const card = h('section', 'workspace');
  const evaluation = createEvaluation(model_picker.labelOf);
  page.main.append(toolbar, card, evaluation.element);
  page.setTitle(kindOf(exercise));
  signal.addEventListener('abort', () => { clearInterval(clock); evaluation.dispose(); });

  const makeView = (): View<ExerciseType> => ({
    exercise, answer, editable: phase === 'answering',
    change: (changed) => {
      answer = changed;
      refreshStatus();
      if (submit_button !== null) submit_button.disabled = !template.isReady(exercise, answer);
      if (draft_id === null) return;
      if (template.isBlank(exercise, answer)) clearDraft(draft_id);
      else writeDraft(draft_id, exercise.type, answer);
    },
    submit: (chosen) => void send(chosen),
    reveal: () => { is_revealed = true; drawEvaluation(); },
  });

  function refreshStatus(): void {
    status_line.replaceChildren(...(template.status?.(makeView(), Date.now() - opened_at) ?? []));
  }

  const retryHref = `#/p/${project_key}/x/${exercise_key}`;

  // The chips; while answering, also Delete for this exercise.
  function createToolbar(): HTMLElement {
    if (is_review) return projectToolbar(view);
    return projectToolbar(view, button('ghost-button', 'Delete exercise', () => void deleteThisExercise()));
  }

  // Its old attempts stay: they keep their own copy of the exercise.
  async function deleteThisExercise(): Promise<void> {
    if (!confirm('Delete this exercise? Your past answers to it are kept. This cannot be undone.')) return;
    try {
      await deleteExercise(project_key, exercise_key, signal);
    } catch (error) {
      if (!signal.aborted) alert(`Could not delete the exercise: ${errorText(error)}`);
      return;
    }
    if (draft_id !== null) clearDraft(draft_id);
    location.hash = `#/p/${project_key}`;
  }

  // The buttons in the answer side's header.
  function createAnswerActions(): HTMLElement[] {
    if (is_review) {
      const submitted = Object.assign(h('span', 'run-info', `Submitted ${formatDateTime(reopened.submitted_at)}`), { title: 'A saved copy: it cannot be edited' });
      if (is_exercise_deleted) return [submitted, h('span', 'run-info', 'The exercise was deleted')];
      return [submitted, link(retryHref, 'primary-button', 'Try again')];
    }
    if (phase !== 'answering' || template.submitLabel === undefined) return [];
    submit_button = Object.assign(h('button', 'primary-button', template.submitLabel, h('span', 'shortcut-hint', '⌘↵')), { type: 'button' as const });
    submit_button.addEventListener('click', () => void send(answer));
    submit_button.disabled = !template.isReady(exercise, answer);
    return [model_picker.chip, submit_button];
  }

  function createFooter(): HTMLElement {
    status_line = h('p', 'footer-note');
    submit_error = Object.assign(h('p', 'form-error'), { role: 'alert' });
    refreshStatus();
    return h('div', 'pane-footer', status_line, submit_error);
  }

  function draw(): void {
    clearInterval(clock);
    submit_button = null;
    const view = makeView();
    const problem = template.problem(view);
    const is_single = template.single === true;
    const answer_content = template.answer?.(view);
    const actions = createAnswerActions();
    const problem_label = h('div', 'direction-label', h('span', 'direction-role', 'Problem'), h('span', 'language-name', problem.kind));
    const problem_pane = h('div', 'pane is-problem', h('div', 'pane-body', ...problem.content));
    if (is_single) {
      problem_pane.append(createFooter());
      card.replaceChildren(
        h('div', 'direction-bar is-single', h('div', 'bar-half is-actions', problem_label, h('div', 'bar-actions', ...actions))),
        h('div', 'panes is-single', problem_pane));
    } else {
      const answer_pane = h('div', 'pane', ...answer_content!, createFooter());
      card.replaceChildren(
        h('div', 'direction-bar',
          h('div', 'bar-half is-tinted', problem_label),
          h('div', 'bar-half is-actions', h('div', 'direction-label', h('span', 'language-name', 'Your answer')), h('div', 'bar-actions', ...actions))),
        h('div', 'panes', problem_pane, answer_pane));
    }
    drawEvaluation();
    if (phase === 'answering' && template.timed === true) clock = setInterval(refreshStatus, 1_000);
  }

  // The buttons in the Evaluation's header once it is final.
  function createEvaluationActions(): HTMLElement[] {
    if (is_review) return [];
    const next = view.exercises.find((candidate) => !candidate.done && candidate.key !== exercise_key);
    const next_href = next === undefined ? `#/p/${project_key}` : `#/p/${project_key}/x/${next.key}`;
    return [link(retryHref, 'ghost-button', 'Try again'), link(next_href, 'primary-button', 'Next exercise')];
  }

  function drawEvaluation(): void {
    if (phase === 'answering' && !is_revealed) {
      evaluation.empty();
    } else if (phase === 'failed') {
      evaluation.failed(attempt?.error ?? 'Grading failed.', [model_picker.chip, button('primary-button', 'Grade again', () => void gradeAgain())]);
    } else if (phase === 'graded' || phase === 'answering') {
      const own = template.evaluation?.(makeView());
      if (own !== undefined) evaluation.answer(own.title, own.content, phase === 'graded' ? createEvaluationActions() : []);
      else evaluation.graded(attempt!.result as AiResult, createEvaluationActions());
    }
  }

  // Moves focus to the Evaluation, so a keyboard or screen reader user lands on the news, and brings it into view.
  function showEvaluation(): void {
    evaluation.element.focus({ preventScroll: true });
    evaluation.element.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function showPhase(): void {
    draw();
    showEvaluation();
  }

  // The sidebar and the toolbar follow what was done. A failed read keeps what the page already has.
  async function refreshDetail(): Promise<void> {
    try {
      view = await readProjectView(project_key, signal);
    } catch {
      return;
    }
    if (signal.aborted) return;
    // The sidebar marks the attempt once there is one, the draft before.
    if (attempt === null) showSide(view, { draft_exercise_id: draft_id ?? undefined });
    else showSide(view, { attempt_id: attempt.id });
    const fresh = createToolbar();
    toolbar.replaceWith(fresh);
    toolbar = fresh;
  }

  // Follows the grading as it streams in, and again if the stream breaks while it is still going; then shows how it ended.
  async function follow(): Promise<void> {
    if (is_following) return;
    is_following = true;
    try {
      while (attempt?.status === 'grading') {
        await watchGrading(attempt.id, signal, evaluation.apply).catch((error: unknown) => { if (signal.aborted) throw error; });
        // The stream ended: the attempt says how. A read that fails is tried again at the next beat.
        attempt = await readAttempt(attempt.id, signal).catch(() => attempt);
        if (attempt!.status === 'grading') await sleep(FOLLOW_RETRY_MS, signal);
      }
    } catch {
      return;
    }
    phase = attempt!.status;
    await refreshDetail();
    if (signal.aborted) return;
    if (is_review) draw();
    else showPhase();
  }

  // The answer was saved: grading goes on (an AI type), or is already done.
  async function settle(): Promise<void> {
    phase = attempt!.status;
    if (phase === 'grading') {
      draw();
      evaluation.grading();
      showEvaluation();
      void refreshDetail();
      void follow();
      return;
    }
    await refreshDetail();
    if (!signal.aborted) showPhase();
  }

  async function send(final_answer: Answer): Promise<void> {
    if (is_sending) return;
    is_sending = true;
    answer = final_answer;
    if (submit_button !== null) submit_button.disabled = true;
    try {
      const target = { project: project_key, key: exercise_key, version };
      attempt = await submitAttempt(target, answer, Date.now() - opened_at, model_picker.settings(), signal);
    } catch (error) {
      is_sending = false;
      if (signal.aborted) return;
      if (submit_button !== null) submit_button.disabled = false;
      if (error instanceof ApiError && error.code === 'exercise_changed') {
        submit_error.textContent = 'This exercise was changed while you answered. Your answer is kept as a draft: reload the page to see the new version.';
      } else {
        submit_error.textContent = `Could not submit: ${errorText(error)} Your answer is still here.`;
      }
      return;
    }
    if (draft_id !== null) clearDraft(draft_id);
    // A reload now shows this attempt, not an empty exercise.
    history.replaceState(null, '', `#/a/${attempt.id}`);
    await settle();
  }

  async function gradeAgain(): Promise<void> {
    try {
      attempt = await regrade(attempt!.id, model_picker.settings(), signal);
    } catch (error) {
      if (!signal.aborted) evaluation.failed(`Could not start grading: ${errorText(error)}`, [model_picker.chip, button('primary-button', 'Grade again', () => void gradeAgain())]);
      return;
    }
    await settle();
  }

  // ⌘↵ submits, as it translates in Claude Translate.
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && submit_button !== null && !submit_button.disabled) {
      event.preventDefault();
      submit_button.click();
    }
  }, { signal });

  showSide(view, { attempt_id: reopened?.id, draft_exercise_id: draft_id ?? undefined });
  draw();
  if (phase === 'grading') {
    evaluation.grading();
    void follow();
  }
}
