// #/g/<generation> : a project being made from a translation (docs/practice-from-translation-design.md §7). While it runs,
// how many exercises are written so far and for how long; once it has made the project, that project; when it failed, why,
// and Try again. The run goes on on the server, so the tab can be closed and opened again.
import { createIcon } from '../../../shared/web/ui.ts';
import type { GenerationDetail } from '../../../shared/api-types.ts';
import { ApiError, errorText, listProjects, readGeneration, readGradingOptions, retryGeneration, watchGeneration } from './client.ts';
import { button, h, link } from './dom.ts';
import { formatClock, pluralize } from './format.ts';
import { reloadView, sleep, type Page } from './page.ts';
import { showProjectsSide } from './side.ts';

// A broken stream of a run that is still going is followed again after this.
const REWATCH_DELAY_MS = 2_000;
const CLOCK_TICK_MS = 1_000;

// What a failed run says, by its error code.
const FAILURE_TEXTS: Record<string, string> = {
  interrupted: 'The server stopped while it was writing the exercises.',
  invalid_reply: 'The model’s reply could not be used.',
};

// Starts the run again and opens it; a run that is already going is opened instead.
async function tryAgain(generation: GenerationDetail, page: Page, status: HTMLElement): Promise<void> {
  try {
    const started = await retryGeneration(generation.id, page.signal);
    location.hash = `#/g/${started.id}`;
  } catch (error) {
    if (page.signal.aborted) return;
    if (error instanceof ApiError && error.code === 'generating') {
      location.hash = `#/g/${error.fields.generationId}`;
      return;
    }
    status.replaceChildren(h('p', 'is-error-text', errorText(error)));
  }
}

// Follows a running generation: the count of exercises written and the time, until it ends; then draws the page again.
async function followRun(generation: GenerationDetail, page: Page, info: HTMLElement): Promise<void> {
  let exerciseCount = 0;
  let startedAt = Date.parse(generation.run.startedAt);
  const draw = (): void => {
    const written = `${exerciseCount} of ${generation.targetCount}`;
    info.textContent = `Writing exercises · ${written} · ${formatClock(Date.now() - startedAt)}`;
  };
  const clock = setInterval(draw, CLOCK_TICK_MS);
  page.signal.addEventListener('abort', () => clearInterval(clock));
  draw();
  try {
    await watchGeneration(generation.id, page.signal, ([name, data]) => {
      if (name === 'snapshot') {
        exerciseCount = data.exerciseCount;
        startedAt = Date.now() - data.elapsedMs;
      } else if (name === 'progress') {
        exerciseCount = data.exerciseCount;
      }
      draw();
    });
  } catch {
    // A broken connection: the state is read again below.
  }
  clearInterval(clock);
  try {
    const now = await readGeneration(generation.id, page.signal);
    if (now.run.status === 'running') await sleep(REWATCH_DELAY_MS, page.signal);
  } catch {
    // The person went elsewhere, or the server is gone: drawing again shows which.
  }
  if (page.signal.aborted) return;
  reloadView();
}

export async function showGeneration(page: Page, id: string): Promise<void> {
  const [generation, options, projects] = await Promise.all([
    readGeneration(Number(id), page.signal),
    readGradingOptions(page.signal),
    listProjects('false', page.signal),
  ]);
  const { run } = generation;
  // The project is there and nothing was left out: open it.
  if (run.status === 'succeeded' && generation.projectKey !== null && generation.droppedCount === 0) {
    location.replace(`#/p/${generation.projectKey}`);
    return;
  }
  showProjectsSide(projects);
  page.setTitle('Making exercises');

  const modelId = run.servedModelId ?? run.requestedModelId ?? '';
  const modelLabel = options.models.find((model) => model.modelId === modelId)?.label ?? modelId;
  const status = h('div', 'generation-status');
  const actions = h('div', 'bar-actions');
  const lines: HTMLElement[] = [h('p', 'field-label', 'From the translation'), h('p', '', generation.title)];

  if (run.status === 'running') {
    const info = h('p', 'generation-progress');
    const activity = createIcon('star', 'run-activity');
    lines.push(h('p', 'generation-line', activity, info), h('p', 'evaluation-note', `${modelLabel} · You can close this tab.`));
    void followRun(generation, page, info);
  } else if (run.status === 'succeeded' && generation.projectKey !== null) {
    const kept = Math.max(0, generation.targetCount - (generation.droppedCount ?? 0));
    const dropped = pluralize(generation.droppedCount ?? 0, 'exercise');
    lines.push(Object.assign(h('div', 'found', h('strong', '', `✓ ${kept} of ${generation.targetCount} kept`),
      h('small', '', `${dropped} failed the check and were left out.`)), { role: 'status' }));
    actions.append(link(`#/p/${generation.projectKey}`, 'primary-button', 'Open the project'));
  } else if (run.status === 'succeeded') {
    lines.push(h('p', '', 'The project made from this translation was deleted.'));
    actions.append(button('primary-button', 'Make again', () => void tryAgain(generation, page, status)));
  } else {
    const reason = FAILURE_TEXTS[run.errorCode ?? ''] ?? 'The model could not finish.';
    lines.push(Object.assign(h('p', 'is-error-text', `${reason} ${run.errorMessage ?? ''}`.trim()), { role: 'alert' }));
    actions.append(button('primary-button', 'Try again', () => void tryAgain(generation, page, status)));
  }

  const heading = h('div', 'direction-label', h('span', 'direction-role', 'Practice'), h('span', 'language-name', 'from a translation'));
  const card = h('section', 'workspace',
    h('div', 'direction-bar is-single', h('div', 'bar-half is-actions', heading, actions)),
    h('div', 'panes is-single', h('div', 'pane', h('div', 'pane-body', ...lines, status))));
  const back = link('#/', 'settings-chip', createIcon('back', 'chip-icon'), 'Projects');
  page.main.append(h('nav', 'settings-bar', back), card);
}
