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
  exerciseKey: string;
  // Drafts in the browser are kept under it.
  exerciseId: number;
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
function gradingSettingsOf(modelPicker: ModelPicker): GradingSettings {
  const { modelId, effort } = modelPicker.settings();
  return { modelId, effort };
}

export async function showExercise(page: Page, projectKey: string, exerciseKey: string): Promise<void> {
  const [view, exercise, modelPicker] = await Promise.all([
    readProjectView(projectKey, page.signal),
    readExercise(projectKey, exerciseKey, page.signal),
    gradingPicker(page.signal),
  ]);
  const shown = { topic: exercise.topic, tags: exercise.tags, content: exercise.content };
  const start: Start = { exerciseKey, exerciseId: exercise.id, exercise: shown, version: exercise.version, attempt: null };
  openScreen(page, view, start, modelPicker);
}

export async function showAttempt(page: Page, attemptIdText: string): Promise<void> {
  const attempt = await readAttempt(Number(attemptIdText), page.signal);
  const [view, modelPicker] = await Promise.all([readProjectView(attempt.projectKey, page.signal), gradingPicker(page.signal)]);
  const start: Start = {
    exerciseKey: attempt.exerciseKey,
    exerciseId: attempt.exerciseId,
    exercise: attempt.exerciseSnapshot,
    version: attempt.exerciseVersion,
    attempt,
  };
  openScreen(page, view, start, modelPicker);
}

function openScreen(page: Page, firstView: ProjectView, start: Start, modelPicker: ModelPicker): void {
  const { signal } = page;
  const { exerciseKey, exerciseId, exercise, version, attempt: reopened } = start;
  const template = templateOf(exercise.content.type);
  const projectKey = firstView.project.key;
  const isReview = reopened !== null;
  // Only a new answer keeps a draft: an old attempt is read-only.
  const draftId = isReview ? null : exerciseId;
  const openedAt = Date.now();
  let view = firstView;
  let attempt = reopened;
  let phase: Phase = 'answering';
  if (reopened !== null) phase = phaseOf(reopened);
  let answer: Answer = reopened?.answer ?? template.empty(exercise);
  // A draft written for an older version of the exercise is kept, with a note.
  let isDraftOutdated = false;
  if (draftId !== null) {
    const draft = readDraft(draftId, version, template.empty(exercise));
    if (draft !== null) {
      answer = draft.answer;
      isDraftOutdated = draft.isOutdated;
    }
  }
  let isRevealed = false;
  let isSending = false;
  let isFollowing = false;
  // True while a Grade again request is on its way.
  let isStartingGrading = false;
  let clock: ReturnType<typeof setInterval> | undefined;
  let statusLine = h('p', 'footer-note');
  let submitButton: HTMLButtonElement | null = null;
  let submitError = h('p', 'form-error');

  let toolbar = createToolbar();
  const card = h('section', 'workspace');
  const evaluation = createEvaluation(modelPicker.labelOf);
  page.main.append(toolbar, card, evaluation.element);
  page.setTitle(labelOf(exercise.content));
  signal.addEventListener('abort', () => { clearInterval(clock); evaluation.dispose(); });

  const makeView = (): View<ExerciseType> => ({
    exercise, answer, editable: phase === 'answering',
    change: (changed) => {
      answer = changed;
      refreshStatus();
      if (submitButton !== null) submitButton.disabled = !template.isReady(exercise, answer);
      if (draftId === null) return;
      if (template.isBlank(exercise, answer)) clearDraft(draftId);
      else writeDraft(draftId, version, answer);
    },
    submit: (chosen) => void send(chosen),
    reveal: () => { isRevealed = true; drawEvaluation(); },
  });

  function refreshStatus(): void {
    statusLine.replaceChildren(...(template.status?.(makeView(), Date.now() - openedAt) ?? []));
  }

  const retryHref = `#/p/${projectKey}/x/${exerciseKey}`;

  // The chips; while answering, also Delete for this exercise.
  function createToolbar(): HTMLElement {
    if (isReview) return projectToolbar(view);
    return projectToolbar(view, button('ghost-button', 'Delete exercise', () => void deleteThisExercise()));
  }

  // Asks first. An exercise with answers asks a second time, because its answers are deleted with it (rule 8).
  async function deleteThisExercise(): Promise<void> {
    if (!confirm('Delete this exercise? This cannot be undone.')) return;
    try {
      await deleteExercise(projectKey, exerciseKey, false, signal);
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'has_attempts') {
        if (!signal.aborted) alert(`Could not delete the exercise: ${errorText(error)}`);
        return;
      }
      if (!confirm('This exercise has answers you gave. Delete them too?')) return;
      try {
        await deleteExercise(projectKey, exerciseKey, true, signal);
      } catch (secondError) {
        if (!signal.aborted) alert(`Could not delete the exercise: ${errorText(secondError)}`);
        return;
      }
    }
    if (draftId !== null) clearDraft(draftId);
    location.hash = `#/p/${projectKey}`;
  }

  // The buttons in the answer side's header.
  function createAnswerActions(): HTMLElement[] {
    if (reopened !== null) {
      const submitted = Object.assign(h('span', 'run-info', `Submitted ${formatDateTime(reopened.createdAt)}`), { title: 'A saved copy: it cannot be edited' });
      return [submitted, link(retryHref, 'primary-button', 'Try again')];
    }
    if (phase !== 'answering' || template.submitLabel === undefined) return [];
    submitButton = Object.assign(h('button', 'primary-button', template.submitLabel, h('span', 'shortcut-hint', '⌘↵')), { type: 'button' as const });
    submitButton.addEventListener('click', () => void send(answer));
    submitButton.disabled = !template.isReady(exercise, answer);
    return [modelPicker.chip, submitButton];
  }

  function createFooter(): HTMLElement {
    statusLine = h('p', 'footer-note');
    submitError = Object.assign(h('p', 'form-error'), { role: 'alert' });
    if (phase === 'answering' && isDraftOutdated) {
      submitError.textContent = 'This exercise changed after you saved this draft. Check your answer before you submit it.';
    }
    refreshStatus();
    return h('div', 'pane-footer', statusLine, submitError);
  }

  function draw(): void {
    clearInterval(clock);
    submitButton = null;
    const view = makeView();
    const problem = template.problem(view);
    const isSingle = template.single === true;
    const answerContent = template.answer?.(view);
    const actions = createAnswerActions();
    const problemLabel = h('div', 'direction-label', h('span', 'direction-role', 'Problem'), h('span', 'language-name', problem.kind));
    const problemPane = h('div', 'pane is-problem', h('div', 'pane-body', ...problem.content));
    if (isSingle) {
      problemPane.append(createFooter());
      card.replaceChildren(
        h('div', 'direction-bar is-single', h('div', 'bar-half is-actions', problemLabel, h('div', 'bar-actions', ...actions))),
        h('div', 'panes is-single', problemPane));
    } else {
      const answerPane = h('div', 'pane', ...answerContent!, createFooter());
      card.replaceChildren(
        h('div', 'direction-bar',
          h('div', 'bar-half is-tinted', problemLabel),
          h('div', 'bar-half is-actions', h('div', 'direction-label', h('span', 'language-name', 'Your answer')), h('div', 'bar-actions', ...actions))),
        h('div', 'panes', problemPane, answerPane));
    }
    drawEvaluation();
    if (phase === 'answering' && template.timed === true) clock = setInterval(refreshStatus, 1_000);
  }

  // The buttons in the Evaluation's header once it is final.
  function createEvaluationActions(): HTMLElement[] {
    if (isReview) return [];
    const next = view.exercises.find((candidate) => !candidate.isDone && candidate.key !== exerciseKey);
    const nextHref = next === undefined ? `#/p/${projectKey}` : `#/p/${projectKey}/x/${next.key}`;
    return [link(retryHref, 'ghost-button', 'Try again'), link(nextHref, 'primary-button', 'Next exercise')];
  }

  // The model chip and Grade again. buttonClass: primary when the grading failed, ghost next to Next exercise.
  function gradeAgainActions(buttonClass: string): HTMLElement[] {
    return [modelPicker.chip, button(buttonClass, 'Grade again', () => void gradeAgain())];
  }

  // Every grading of the attempt but its latest, oldest first.
  function earlierGradings(): Grading[] {
    if (attempt === null) return [];
    return attempt.gradings.slice(0, -1);
  }

  function drawEvaluation(): void {
    if (phase === 'answering' && !isRevealed) {
      evaluation.empty();
      return;
    }
    if (phase === 'failed') {
      const latest = attempt === null ? null : latestGradingOf(attempt);
      evaluation.failed(latest?.run.errorMessage ?? 'Grading failed.', gradeAgainActions('primary-button'), earlierGradings());
      return;
    }
    if (phase === 'graded' || phase === 'answering') {
      const own = template.evaluation?.(makeView());
      const actions = phase === 'graded' ? createEvaluationActions() : [];
      if (own !== undefined) {
        evaluation.answer(own.title, own.content, actions);
        return;
      }
      // An AI-graded attempt whose grading is finished: it can be graded again (rule 7).
      const latest = latestGradingOf(attempt as AttemptDetail) as Grading;
      evaluation.graded(latest, modelAnswerOf(exercise.content), [...gradeAgainActions('ghost-button'), ...actions], earlierGradings());
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
      view = await readProjectView(projectKey, signal);
    } catch {
      return;
    }
    if (signal.aborted) return;
    // The sidebar marks the attempt once there is one, the draft before.
    if (attempt === null) showSide(view, { draftExerciseId: draftId ?? undefined });
    else showSide(view, { attemptId: attempt.id });
    const fresh = createToolbar();
    toolbar.replaceWith(fresh);
    toolbar = fresh;
  }

  // Follows the grading as it streams in, and again if the stream breaks while it is still going; then shows how it ended.
  async function follow(): Promise<void> {
    if (isFollowing) return;
    isFollowing = true;
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
      isFollowing = false;
    }
    if (attempt === null) return;
    phase = phaseOf(attempt);
    await refreshDetail();
    if (signal.aborted) return;
    if (isReview) draw();
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

  async function send(finalAnswer: Answer): Promise<void> {
    if (isSending) return;
    isSending = true;
    answer = finalAnswer;
    if (submitButton !== null) submitButton.disabled = true;
    let saved: AttemptDetail;
    try {
      const target = { projectKey, key: exerciseKey, version };
      saved = await submitAttempt(target, answer, Date.now() - openedAt, gradingSettingsOf(modelPicker), signal);
    } catch (error) {
      isSending = false;
      if (signal.aborted) return;
      if (submitButton !== null) submitButton.disabled = false;
      if (error instanceof ApiError && error.code === 'exercise_changed') {
        submitError.textContent = 'This exercise was changed while you answered. Your answer is kept as a draft: reload the page to see the new version.';
      } else {
        submitError.textContent = `Could not submit: ${errorText(error)} Your answer is still here.`;
      }
      return;
    }
    attempt = saved;
    if (draftId !== null) clearDraft(draftId);
    // A reload now shows this attempt, not an empty exercise.
    history.replaceState(null, '', `#/a/${saved.id}`);
    await settle();
  }

  async function gradeAgain(): Promise<void> {
    if (attempt === null || isStartingGrading) return;
    // A second click before the answer comes back starts nothing.
    isStartingGrading = true;
    const graded = attempt;
    try {
      attempt = await regrade(graded.id, gradingSettingsOf(modelPicker), signal);
    } catch (error) {
      isStartingGrading = false;
      // No new grading was made, so every grading the attempt has is an earlier one.
      if (!signal.aborted) evaluation.failed(`Could not start grading: ${errorText(error)}`, gradeAgainActions('primary-button'), graded.gradings);
      return;
    }
    isStartingGrading = false;
    await settle();
  }

  // ⌘↵ submits, as it translates in Claude Translate.
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && submitButton !== null && !submitButton.disabled) {
      event.preventDefault();
      submitButton.click();
    }
  }, { signal });

  showSide(view, { attemptId: reopened?.id, draftExerciseId: draftId ?? undefined });
  draw();
  if (phase === 'grading') {
    evaluation.grading();
    void follow();
  }
}
