// Grades one saved attempt (every type but a flashcard) with `claude -p`: one common prompt (prompts/grade.md), the exercise
// as stored in the attempt and the answer. The reply is Markdown and is stored as it is, with the grader's thinking summary,
// in the attempt's grading (a ModelRun and its feedback). The grading runs on the server and writes its outcome to the store,
// so closing the page does not stop it; what it has produced so far is kept in memory, so a page that comes back
// mid-grading is sent that first, then the rest.
import { readFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelLabelOf, runClaude, type Run } from '../../../shared/server/claude-runner.ts';
import { formatCount, formatSeconds, log } from '../../../shared/server/log.ts';
import type { Answer, AttemptDetail, ExerciseSnapshot, GradingSettings, GradingStreamEvents } from '../api.ts';
import { countWords } from '../text.ts';
import type { GradingOutcome, PracticeStore } from './store.ts';

const PROMPT_PATH = join(dirname(dirname(fileURLToPath(import.meta.url))), 'prompts', 'grade.md');
const LETTERS = 'ABCDEF';

let grading_request_count = 0;

// The answer as a person would read it: the text, the options picked, the gaps typed.
function answerTextOf(exercise: ExerciseSnapshot, answer: Answer): string {
  const { content } = exercise;
  if (answer.type === 'choice' && content.type === 'choice') {
    // "B. The option's text", one line per option picked.
    const lines = answer.chosenOptionIndexes.map((index) => `${LETTERS[index]}. ${content.options[index].text}`);
    return lines.join('\n');
  }
  if (answer.type === 'gap_fill' && content.type === 'gap_fill') {
    // "Gap 2: what was typed", one line per gap.
    const lines = content.gaps.map((_gap, index) => {
      const typed = answer.gapAnswers[index];
      if (typed === '') return `Gap ${index + 1}: (blank)`;
      return `Gap ${index + 1}: ${typed}`;
    });
    return lines.join('\n');
  }
  if ('text' in answer) return answer.text;
  return '';
}

export function userMessageOf(exercise: ExerciseSnapshot, answer: Answer): string {
  const { topic, tags, content } = exercise;
  const exercise_json = JSON.stringify({ topic, tags, content }, null, 2);
  let words = '';
  if ('text' in answer) words = ` word_count="${countWords(answer.text)}"`;
  const answer_text = answerTextOf(exercise, answer);
  return `Evaluate this answer.\n\n<exercise>\n${exercise_json}\n</exercise>\n\n<answer${words}>\n${answer_text}\n</answer>`;
}

// Read at every grading, so an edit of the prompt applies without a restart.
export function systemPrompt(): string {
  return `${readFileSync(PROMPT_PATH, 'utf8').trim()}\n`;
}

// A grading in progress: what it has produced so far, and the pages watching it.
interface LiveGrading {
  settings: GradingSettings;
  started_at: number;
  thinking_text: string;
  thinking_ms: number | null;
  text: string;
  watchers: Set<ServerResponse>;
}

export interface Grader {
  // Runs the grading (stored as running) of the attempt; the outcome is written to the store when it ends.
  start(attempt: AttemptDetail, grading_id: number, settings: GradingSettings): void;
  // Answers a request to watch the attempt's grading; a 'finished' event at once when it is not being graded.
  watch(res: ServerResponse, attempt_id: number): void;
}

function sendEvent<Name extends keyof GradingStreamEvents>(res: ServerResponse, name: Name, data: GradingStreamEvents[Name]): void {
  if (!res.destroyed && !res.writableEnded) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function createGrader(store: PracticeStore): Grader {
  // One entry per attempt being graded (at most one grading of an attempt runs: rule 7); removed when its outcome is saved.
  const live_gradings = new Map<number, LiveGrading>();

  function start(attempt: AttemptDetail, grading_id: number, settings: GradingSettings): void {
    if (live_gradings.has(attempt.id)) return;
    const request_number = ++grading_request_count;
    const { exerciseSnapshot: exercise } = attempt;
    const { modelId: model_id, effort } = settings;
    const live: LiveGrading = { settings, started_at: Date.now(), thinking_text: '', thinking_ms: null, text: '', watchers: new Set() };
    live_gradings.set(attempt.id, live);
    const tell = <Name extends keyof GradingStreamEvents>(name: Name, data: GradingStreamEvents[Name]): void => {
      for (const watcher of live.watchers) sendEvent(watcher, name, data);
    };
    // The outcome is saved before the watchers are told, so what they read next is final. A throw here would escape a stream
    // handler and stop the server; a failed save must only be logged.
    const finish = (outcome: GradingOutcome): void => {
      try {
        store.finishGrading(grading_id, outcome);
      } catch (save_error) {
        log('error', request_number, 'practice', `saving grading ${grading_id} of attempt ${attempt.id} failed: ${(save_error as Error).message}`);
      }
      live_gradings.delete(attempt.id);
      if (outcome.status === 'succeeded') tell('done', {});
      else tell('error', { message: outcome.errorMessage });
      for (const watcher of live.watchers) watcher.end();
    };
    // null until runClaude returns.
    let run: Run | null = null;
    const servedModelId = (): string => run?.served_model_id() ?? model_id;
    const what_so_far = () => ({ thinkingText: live.thinking_text, thinkingMs: live.thinking_ms, feedbackMarkdown: live.text });
    log('info', request_number, 'grade', `${exercise.content.type}  ${modelLabelOf(model_id)} ${effort}  attempt ${attempt.id}`);
    run = runClaude({
      request_number,
      settings: { model_id, effort, system_prompt: systemPrompt() },
      user_message: userMessageOf(exercise, attempt.answer),
      handlers: {
        onThinkingDelta: (text) => {
          live.thinking_text += text;
          tell('thinking_delta', { text });
        },
        onThinkingDone: (duration_ms) => {
          live.thinking_ms = duration_ms;
          tell('thinking_done', { durationMs: duration_ms });
        },
        onText: (text) => {
          live.text += text;
          tell('text_delta', { text });
        },
        onRetry: (retry) => tell('retry', { attempt: retry.attempt, maxRetries: retry.max_retries, error: retry.error }),
        onFallback: (fallback) => tell('fallback', { fromModelId: fallback.from_model_id, toModelId: fallback.to_model_id }),
        onDone: (reply_text) => {
          const grading_ms = Date.now() - live.started_at;
          const served_model_id = servedModelId();
          const text = reply_text.trim();
          if (text === '') {
            log('error', request_number, 'error', `${modelLabelOf(served_model_id)}  ${formatSeconds(grading_ms)}  empty reply  attempt ${attempt.id}`);
            const error = { errorCode: 'empty_reply' as const, errorMessage: 'The grader sent no text.' };
            finish({ status: 'failed', servedModelId: served_model_id, ...what_so_far(), ...error });
            return;
          }
          finish({ status: 'succeeded', servedModelId: served_model_id, ...what_so_far(), feedbackMarkdown: text });
          const timing = `${modelLabelOf(served_model_id).padEnd(10)}  ${effort.padEnd(6)}  ${formatSeconds(grading_ms).padStart(6)}`;
          log('info', request_number, 'graded', `${timing}  ${formatCount(text.length)} characters  attempt ${attempt.id}`);
        },
        onError: (error, failure_text, failure_detail_lines) => {
          const grading_ms = Date.now() - live.started_at;
          const served_model_id = servedModelId();
          const summary = `${modelLabelOf(served_model_id)}  ${formatSeconds(grading_ms)}  ${error.error_kind}: ${failure_text}  attempt ${attempt.id}`;
          log('error', request_number, 'error', summary, failure_detail_lines);
          const failure = { errorCode: error.error_kind, errorMessage: error.message };
          finish({ status: 'failed', servedModelId: served_model_id, ...what_so_far(), ...failure });
        },
      },
    });
  }

  function watch(res: ServerResponse, attempt_id: number): void {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const live = live_gradings.get(attempt_id);
    if (live === undefined) {
      sendEvent(res, 'finished', {});
      res.end();
      return;
    }
    sendEvent(res, 'snapshot', {
      thinkingText: live.thinking_text,
      thinkingMs: live.thinking_ms,
      text: live.text,
      modelId: live.settings.modelId,
      effort: live.settings.effort,
      elapsedMs: Date.now() - live.started_at,
    });
    live.watchers.add(res);
    res.on('close', () => live.watchers.delete(res));
  }

  return { start, watch };
}
