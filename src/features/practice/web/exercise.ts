// #/p/<project>/x/<exercise> (answer it) and #/a/<attempt> (look at an old attempt): the page every type shares. A card holds
// the Problem and Your answer side by side; the Evaluation card is below it, across the full width. The phases: answering,
// grading (the AI is working, its words streaming in), graded, failed. A template draws the insides of the panes (./templates/);
// this file draws the cards, the buttons and the phases.
import { createModelPicker, type ModelPicker } from '../../../shared/web/model-picker.ts';
import type { Answer, AttemptDetail, ExerciseContent, ExerciseType, Grading, GradingSettings } from '../api-types.ts';
import { labelOf } from '../text.ts';
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
import type { ShownExercise, View } from './templates/types.ts';

// How long to wait before following a grading again, when the stream broke while it was still going.
const FOLLOW_RETRY_MS = 1_500;
const PICKER_STORAGE_KEY = 'practice.grading';

// Where the page is: answering, or an attempt whose latest grading is running, succeeded, or failed (a cancelled one too).
// A flashcard attempt is graded at once: its rating is its result.
type Phase = 'answering' | 'grading' | 'graded' | 'failed';

interface Start {
  exercise_key: string;
  // Drafts in the browser are kept under it.
  exercise_id: number;
  // What the page shows: the exercise as it is now, or as the attempt saw it.
  exercise: ShownExercise<ExerciseType>;
  // The version shown. It is sent with the answer, so a change made meanwhile is caught (409 exercise_changed).
  version: number;
  // The attempt being reopened; null for a new answer.
  attempt: AttemptDetail | null;
}

// The grading an attempt shows: its latest (rule 7). null for a flashcard.
function latestGradingOf(attempt: AttemptDetail): Grading | null {
  return attempt.gradings.at(-1) ?? null;
}

function phaseOf(attempt: AttemptDetail): Phase {
  if (attempt.answer.type === 'flashcard') return 'graded';
  const latest = latestGradingOf(attempt);
  if (latest === null) return 'failed';
  if (latest.run.status === 'running') return 'grading';
  if (latest.run.status === 'succeeded') return 'graded';
  return 'failed';
}

// The model answer the learner sees after grading; null when the exercise has none.
function modelAnswerOf(content: ExerciseContent): string | null {
  if ('modelAnswer' in content) return content.modelAnswer;
  return null;
}

// One picker for the whole page: its menu lives in the document, and the choice is the same for every exercise.
let picker: ModelPicker | null = null;
async function gradingPicker(signal: AbortSignal): Promise<ModelPicker> {
  if (picker !== null) return picker;
  const options = await readGradingOptions(signal);
  // Another call may have made it while this one waited.
  picker ??= createModelPicker(options, PICKER_STORAGE_KEY, document.body);
  return picker;
}

// The picker's choice, as the API names it.
function gradingSettingsOf(model_picker: ModelPicker): GradingSettings {
  const { modelId, effort } = model_picker.settings();
  return { modelId, effort };
}

export async function showExercise(page: Page, project_key: string, exercise_key: string): Promise<void> {
  const [view, exercise, model_picker] = await Promise.all([
    readProjectView(project_key, page.signal),
    readExercise(project_key, exercise_key, page.signal),
    gradingPicker(page.signal),
  ]);
  const shown = { topic: exercise.topic, tags: exercise.tags, content: exercise.content };
  const start: Start = { exercise_key, exercise_id: exercise.id, exercise: shown, version: exercise.version, attempt: null };
  openScreen(page, view, start, model_picker);
}

export async function showAttempt(page: Page, attempt_id_text: string): Promise<void> {
  const attempt = await readAttempt(Number(attempt_id_text), page.signal);
  const [view, model_picker] = await Promise.all([readProjectView(attempt.projectKey, page.signal), gradingPicker(page.signal)]);
  const start: Start = {
    exercise_key: attempt.exerciseKey,
    exercise_id: attempt.exerciseId,
    exercise: attempt.exerciseSnapshot,
    version: attempt.exerciseVersion,
    attempt,
  };
  openScreen(page, view, start, model_picker);
}

function openScreen(page: Page, first_view: ProjectView, start: Start, model_picker: ModelPicker): void {
  const { signal } = page;
  const { exercise_key, exercise_id, exercise, version, attempt: reopened } = start;
  const template = templateOf(exercise.content.type);
  const project_key = first_view.project.key;
  const is_review = reopened !== null;
  // Only a new answer keeps a draft: an old attempt is read-only.
  const draft_id = is_review ? null : exercise_id;
  const opened_at = Date.now();
  let view = first_view;
  let attempt = reopened;
  let phase: Phase = 'answering';
  if (reopened !== null) phase = phaseOf(reopened);
  let answer: Answer = reopened?.answer ?? template.empty(exercise);
  // A draft written for an older version of the exercise is kept, with a note.
  let is_draft_outdated = false;
  if (draft_id !== null) {
    const draft = readDraft(draft_id, version, template.empty(exercise));
    if (draft !== null) {
      answer = draft.answer;
      is_draft_outdated = draft.is_outdated;
    }
  }
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
  page.setTitle(labelOf(exercise.content));
  signal.addEventListener('abort', () => { clearInterval(clock); evaluation.dispose(); });

  const makeView = (): View<ExerciseType> => ({
    exercise, answer, editable: phase === 'answering',
    change: (changed) => {
      answer = changed;
      refreshStatus();
      if (submit_button !== null) submit_button.disabled = !template.isReady(exercise, answer);
      if (draft_id === null) return;
      if (template.isBlank(exercise, answer)) clearDraft(draft_id);
      else writeDraft(draft_id, version, answer);
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

  // Asks first. An exercise with answers asks a second time, because its answers are deleted with it (rule 8).
  async function deleteThisExercise(): Promise<void> {
    if (!confirm('Delete this exercise? This cannot be undone.')) return;
    try {
      await deleteExercise(project_key, exercise_key, false, signal);
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'has_attempts') {
        if (!signal.aborted) alert(`Could not delete the exercise: ${errorText(error)}`);
        return;
      }
      if (!confirm('This exercise has answers you gave. Delete them too?')) return;
      try {
        await deleteExercise(project_key, exercise_key, true, signal);
      } catch (second_error) {
        if (!signal.aborted) alert(`Could not delete the exercise: ${errorText(second_error)}`);
        return;
      }
    }
    if (draft_id !== null) clearDraft(draft_id);
    location.hash = `#/p/${project_key}`;
  }

  // The buttons in the answer side's header.
  function createAnswerActions(): HTMLElement[] {
    if (reopened !== null) {
      const submitted = Object.assign(h('span', 'run-info', `Submitted ${formatDateTime(reopened.createdAt)}`), { title: 'A saved copy: it cannot be edited' });
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
    if (phase === 'answering' && is_draft_outdated) {
      submit_error.textContent = 'This exercise changed after you saved this draft. Check your answer before you submit it.';
    }
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
    const next = view.exercises.find((candidate) => !candidate.isDone && candidate.key !== exercise_key);
    const next_href = next === undefined ? `#/p/${project_key}` : `#/p/${project_key}/x/${next.key}`;
    return [link(retryHref, 'ghost-button', 'Try again'), link(next_href, 'primary-button', 'Next exercise')];
  }

  function gradeAgainActions(): HTMLElement[] {
    return [model_picker.chip, button('primary-button', 'Grade again', () => void gradeAgain())];
  }

  function drawEvaluation(): void {
    if (phase === 'answering' && !is_revealed) {
      evaluation.empty();
      return;
    }
    if (phase === 'failed') {
      const latest = attempt === null ? null : latestGradingOf(attempt);
      evaluation.failed(latest?.run.errorMessage ?? 'Grading failed.', gradeAgainActions());
      return;
    }
    if (phase === 'graded' || phase === 'answering') {
      const own = template.evaluation?.(makeView());
      const actions = phase === 'graded' ? createEvaluationActions() : [];
      if (own !== undefined) {
        evaluation.answer(own.title, own.content, actions);
        return;
      }
      const latest = latestGradingOf(attempt as AttemptDetail) as Grading;
      evaluation.graded(latest, modelAnswerOf(exercise.content), actions);
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
      while (attempt !== null && phaseOf(attempt) === 'grading') {
        await watchGrading(attempt.id, signal, evaluation.apply).catch((error: unknown) => { if (signal.aborted) throw error; });
        // The stream ended: the attempt says how. A read that fails is tried again at the next beat.
        const current: AttemptDetail = attempt;
        attempt = await readAttempt(current.id, signal).catch(() => current);
        if (phaseOf(attempt) === 'grading') await sleep(FOLLOW_RETRY_MS, signal);
      }
    } catch {
      return;
    } finally {
      is_following = false;
    }
    if (attempt === null) return;
    phase = phaseOf(attempt);
    await refreshDetail();
    if (signal.aborted) return;
    if (is_review) draw();
    else showPhase();
  }

  // The answer was saved: grading goes on (an AI type), or is already done.
  async function settle(): Promise<void> {
    phase = phaseOf(attempt as AttemptDetail);
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
    let saved: AttemptDetail;
    try {
      const target = { projectKey: project_key, key: exercise_key, version };
      saved = await submitAttempt(target, answer, Date.now() - opened_at, gradingSettingsOf(model_picker), signal);
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
    attempt = saved;
    if (draft_id !== null) clearDraft(draft_id);
    // A reload now shows this attempt, not an empty exercise.
    history.replaceState(null, '', `#/a/${saved.id}`);
    await settle();
  }

  async function gradeAgain(): Promise<void> {
    if (attempt === null) return;
    try {
      attempt = await regrade(attempt.id, gradingSettingsOf(model_picker), signal);
    } catch (error) {
      if (!signal.aborted) evaluation.failed(`Could not start grading: ${errorText(error)}`, gradeAgainActions());
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
