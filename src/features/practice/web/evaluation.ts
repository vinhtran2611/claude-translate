// The Evaluation card under the problem: the AI's feedback streaming in as Markdown, its thinking summary above it (Claude
// Translate's "Thought for 20s" disclosure), then the finished feedback with the model, effort and time in the header. Also a
// flashcard's Answer. It only draws: the page decides when each state starts.
import { renderDocument } from '../../../shared/web/markdown.ts';
import { createIcon } from '../../../shared/web/ui.ts';
import type { AiResult } from '../api-types.ts';
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
  graded(result: AiResult, actions: HTMLElement[]): void;
  failed(message: string, actions: HTMLElement[]): void;
  // Stops the clock; the card is not used again.
  dispose(): void;
}

const COPY_RESET_MS = 1400;

const seconds = (duration_ms: number): string => `${(duration_ms / 1000).toFixed(1)}s`;

// labelOf: "Sonnet 5.5 · High" for a model and effort (the picker's wording).
export function createEvaluation(labelOf: (model_id: string, effort: string | null) => string): Evaluation {
  const title = h('span', 'language-name', 'Evaluation');
  const activity = createIcon('star', 'run-activity');
  const info = h('span', 'run-info');
  const actions_slot = h('div', 'bar-actions', activity, info);
  const bar = h('div', 'direction-bar is-single', h('div', 'bar-half is-tinted is-actions',
    h('div', 'direction-label', title), actions_slot));
  const body = h('div', 'evaluation-body');
  const element = Object.assign(h('section', 'workspace evaluation', bar, body), { tabIndex: -1 });
  let clock: ReturnType<typeof setInterval> | undefined;

  // What the grading has produced so far, and when it started (the server's elapsed time on a reattach).
  let started_at = 0;
  let thinking_text = '';
  let thinking_ms: number | null = null;
  let text = '';
  let note = '';
  const thinking = h('details', 'thinking');
  thinking.lang = 'en';
  const thinking_label = h('span', 'thinking-label');
  thinking.append(h('summary', 'thinking-toggle', createIcon('star', 'thinking-icon'), thinking_label, createIcon('thinkingChevron', 'thinking-chevron')));
  const thinking_body = h('div', 'thinking-text doc-content');
  thinking.append(thinking_body);
  const skeleton = h('div', 'skeleton', h('span'), h('span'), h('span'));
  skeleton.setAttribute('aria-hidden', 'true');
  const feedback = h('div', 'eval-text doc-content');

  function setActions(actions: HTMLElement[]): void {
    actions_slot.replaceChildren(activity, info, ...actions);
  }

  function reset(heading: string): void {
    clearInterval(clock);
    title.textContent = heading;
    activity.setAttribute('hidden', '');
    info.textContent = '';
    element.removeAttribute('role');
  }

  // text '' hides the block; duration_ms null shows it as still thinking.
  function setThinking(summary: string, duration_ms: number | null, is_open: boolean): void {
    thinking.hidden = summary === '';
    thinking.open = is_open;
    thinking.classList.toggle('is-live', summary !== '' && duration_ms === null);
    thinking_label.textContent = summary === '' ? '' : duration_ms === null ? 'Thinking…' : `Thought for ${Math.max(1, Math.round(duration_ms / 1000))}s`;
    renderDocument(thinking_body, summary.trim());
  }

  function drawProgress(): void {
    const waited = Math.floor((Date.now() - started_at) / 1000);
    const is_thinking = thinking_text !== '' && thinking_ms === null && text === '';
    info.textContent = note !== '' ? `${note} ${waited}s` : `${is_thinking ? 'Thinking…' : 'Grading…'} ${waited}s`;
  }

  function drawStream(): void {
    skeleton.hidden = text !== '';
    renderDocument(feedback, text, true);
  }

  async function copy(copy_button: HTMLButtonElement, label: HTMLElement, copied_text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(copied_text);
    } catch {
      return;
    }
    label.textContent = 'Copied';
    copy_button.classList.add('is-done');
    setTimeout(() => { label.textContent = 'Copy'; copy_button.classList.remove('is-done'); }, COPY_RESET_MS);
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
      started_at = Date.now();
      thinking_text = text = note = '';
      thinking_ms = null;
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
        thinking_text = data.thinking_text;
        thinking_ms = data.thinking_ms;
        text = data.text;
        started_at = Date.now() - data.elapsed_ms;
        setThinking(thinking_text, thinking_ms, thinking_ms === null && text === '');
      } else if (name === 'thinking_delta') {
        // Opens as the summary starts arriving; a click to close it while thinking is kept.
        thinking_text += data.text;
        setThinking(thinking_text, null, thinking_text === data.text || thinking.open);
      } else if (name === 'thinking_done') {
        thinking_ms = data.duration_ms;
        setThinking(thinking_text, thinking_ms, false);
      } else if (name === 'text_delta') {
        text += data.text;
      } else if (name === 'retry') {
        note = `API busy (${data.error}), retry ${data.attempt}/${data.max_retries}…`;
      } else if (name === 'fallback') {
        note = `${labelOf(data.from_model_id, null)} is slow, switched to ${labelOf(data.to_model_id, null)}…`;
      } else {
        return;
      }
      if (name === 'text_delta' || name === 'snapshot') note = '';
      drawStream();
      drawProgress();
    },
    graded(result, actions) {
      reset('Evaluation');
      const copy_label = h('span', '', 'Copy');
      const copy_button = Object.assign(h('button', 'ghost-button', createIcon('copy'), copy_label), { type: 'button' as const });
      copy_button.addEventListener('click', () => void copy(copy_button, copy_label, result.text));
      info.textContent = `${labelOf(result.model, result.effort)} · ${seconds(result.ms)}`;
      setActions([copy_button, ...actions]);
      setThinking(result.thinking_text, result.thinking_ms, false);
      skeleton.hidden = true;
      renderDocument(feedback, result.text);
      body.replaceChildren(thinking, feedback);
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
