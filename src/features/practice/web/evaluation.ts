// The Evaluation card under the problem: the AI's feedback streaming in as Markdown, its thinking summary above it (Claude
// Translate's "Thought for 20s" disclosure), then the finished feedback with the model, effort and time in the header, and
// the exercise's model answer under it. Also a flashcard's Answer. It only draws: the page decides when each state starts.
import { renderDocument } from '../../../shared/web/markdown.ts';
import { createIcon } from '../../../shared/web/ui.ts';
import type { Grading } from '../api-types.ts';
import type { GradingEvent } from './client.ts';
import { h } from './dom.ts';

export interface Evaluation {
  element: HTMLElement;
  // Nothing to show yet.
  empty(): void;
  // The Answer of a flashcard.
  answer(title: string, content: HTMLElement[], actions: HTMLElement[]): void;
  // The AI started grading (or the page reattached to a grading); events follow through apply().
  grading(): void;
  apply(event: GradingEvent): void;
  // A succeeded grading. modelAnswer: the exercise's, shown after grading (null when it has none).
  graded(grading: Grading, modelAnswer: string | null, actions: HTMLElement[]): void;
  failed(message: string, actions: HTMLElement[]): void;
  // Stops the clock; the card is not used again.
  dispose(): void;
}

const COPY_RESET_MS = 1400;

const seconds = (durationMs: number): string => `${(durationMs / 1000).toFixed(1)}s`;

// How long a finished grading took: finishedAt - startedAt (never stored).
function durationOf(grading: Grading): number {
  const finishedAt = grading.run.finishedAt ?? grading.run.startedAt;
  return Date.parse(finishedAt) - Date.parse(grading.run.startedAt);
}

// labelOf: "Sonnet 5.5 · High" for a model and effort (the picker's wording).
export function createEvaluation(labelOf: (modelId: string, effort: string | null) => string): Evaluation {
  const title = h('span', 'language-name', 'Evaluation');
  const activity = createIcon('star', 'run-activity');
  const info = h('span', 'run-info');
  const actionsSlot = h('div', 'bar-actions', activity, info);
  const bar = h('div', 'direction-bar is-single', h('div', 'bar-half is-tinted is-actions',
    h('div', 'direction-label', title), actionsSlot));
  const body = h('div', 'evaluation-body');
  const element = Object.assign(h('section', 'workspace evaluation', bar, body), { tabIndex: -1 });
  let clock: ReturnType<typeof setInterval> | undefined;

  // What the grading has produced so far, and when it started (the server's elapsed time on a reattach).
  let startedAt = 0;
  let thinkingText = '';
  let thinkingMs: number | null = null;
  let text = '';
  let note = '';
  const thinking = h('details', 'thinking');
  thinking.lang = 'en';
  const thinkingLabel = h('span', 'thinking-label');
  thinking.append(h('summary', 'thinking-toggle', createIcon('star', 'thinking-icon'), thinkingLabel, createIcon('thinkingChevron', 'thinking-chevron')));
  const thinkingBody = h('div', 'thinking-text doc-content');
  thinking.append(thinkingBody);
  const skeleton = h('div', 'skeleton', h('span'), h('span'), h('span'));
  skeleton.setAttribute('aria-hidden', 'true');
  const feedback = h('div', 'eval-text doc-content');

  function setActions(actions: HTMLElement[]): void {
    actionsSlot.replaceChildren(activity, info, ...actions);
  }

  function reset(heading: string): void {
    clearInterval(clock);
    title.textContent = heading;
    activity.setAttribute('hidden', '');
    info.textContent = '';
    element.removeAttribute('role');
  }

  // text '' hides the block; durationMs null shows it as still thinking.
  function setThinking(summary: string, durationMs: number | null, isOpen: boolean): void {
    thinking.hidden = summary === '';
    thinking.open = isOpen;
    thinking.classList.toggle('is-live', summary !== '' && durationMs === null);
    thinkingLabel.textContent = summary === '' ? '' : durationMs === null ? 'Thinking…' : `Thought for ${Math.max(1, Math.round(durationMs / 1000))}s`;
    renderDocument(thinkingBody, summary.trim());
  }

  function drawProgress(): void {
    const waited = Math.floor((Date.now() - startedAt) / 1000);
    const isThinking = thinkingText !== '' && thinkingMs === null && text === '';
    info.textContent = note !== '' ? `${note} ${waited}s` : `${isThinking ? 'Thinking…' : 'Grading…'} ${waited}s`;
  }

  function drawStream(): void {
    skeleton.hidden = text !== '';
    renderDocument(feedback, text, true);
  }

  async function copy(copyButton: HTMLButtonElement, label: HTMLElement, copiedText: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(copiedText);
    } catch {
      return;
    }
    label.textContent = 'Copied';
    copyButton.classList.add('is-done');
    setTimeout(() => { label.textContent = 'Copy'; copyButton.classList.remove('is-done'); }, COPY_RESET_MS);
  }

  return {
    element,
    empty() {
      reset('Evaluation');
      setActions([]);
      body.replaceChildren(h('p', 'eval-empty', 'Your evaluation appears here'));
    },
    answer(heading, content, actions) {
      reset(heading);
      setActions(actions);
      body.replaceChildren(...content);
    },
    grading() {
      reset('Evaluation');
      setActions([]);
      startedAt = Date.now();
      thinkingText = text = note = '';
      thinkingMs = null;
      activity.removeAttribute('hidden');
      element.setAttribute('role', 'status');
      setThinking('', null, false);
      body.replaceChildren(thinking, skeleton, feedback);
      drawStream();
      drawProgress();
      clock = setInterval(drawProgress, 1000);
    },
    apply([name, data]) {
      if (name === 'snapshot') {
        thinkingText = data.thinkingText;
        thinkingMs = data.thinkingMs;
        text = data.text;
        startedAt = Date.now() - data.elapsedMs;
        setThinking(thinkingText, thinkingMs, thinkingMs === null && text === '');
      } else if (name === 'thinking_delta') {
        // Opens as the summary starts arriving; a click to close it while thinking is kept.
        thinkingText += data.text;
        setThinking(thinkingText, null, thinkingText === data.text || thinking.open);
      } else if (name === 'thinking_done') {
        thinkingMs = data.durationMs;
        setThinking(thinkingText, thinkingMs, false);
      } else if (name === 'text_delta') {
        text += data.text;
      } else if (name === 'retry') {
        note = `API busy (${data.error}), retry ${data.attempt}/${data.maxRetries}…`;
      } else if (name === 'fallback') {
        note = `${labelOf(data.fromModelId, null)} is slow, switched to ${labelOf(data.toModelId, null)}…`;
      } else {
        return;
      }
      if (name === 'text_delta' || name === 'snapshot') note = '';
      drawStream();
      drawProgress();
    },
    graded(grading, modelAnswer, actions) {
      reset('Evaluation');
      const feedbackText = grading.feedbackMarkdown ?? '';
      const { run } = grading;
      const copyLabel = h('span', '', 'Copy');
      const copyButton = Object.assign(h('button', 'ghost-button', createIcon('copy'), copyLabel), { type: 'button' as const });
      copyButton.addEventListener('click', () => void copy(copyButton, copyLabel, feedbackText));
      const modelId = run.servedModelId ?? run.requestedModelId ?? '';
      info.textContent = `${labelOf(modelId, run.effort)} · ${seconds(durationOf(grading))}`;
      setActions([copyButton, ...actions]);
      setThinking(run.thinkingText ?? '', run.thinkingMs, false);
      skeleton.hidden = true;
      renderDocument(feedback, feedbackText);
      body.replaceChildren(thinking, feedback);
      if (modelAnswer !== null) body.append(h('p', 'label', 'Model answer'), h('p', 'read', modelAnswer));
    },
    failed(message, actions) {
      reset('Not graded');
      setActions(actions);
      element.setAttribute('role', 'alert');
      body.replaceChildren(h('p', 'is-error-text', message));
    },
    dispose: () => clearInterval(clock),
  };
}
