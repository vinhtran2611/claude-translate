// Grades one saved attempt (every type but a flashcard) with `claude -p`: one common prompt (prompts/grade.md), the exercise
// as stored in the attempt and the answer. The reply is Markdown and is stored as it is, with the grader's thinking summary.
// The grading runs on the server and writes its outcome to the store, so closing the page does not stop it; what it has
// produced so far is kept in memory, so a page that comes back mid-grading is sent that first, then the rest.
import { readFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import { modelLabelOf, runClaude } from '../../../shared/server/claude-runner.ts';
import { formatCount, formatSeconds, log } from '../../../shared/server/log.ts';
import { FEATURES_DIRECTORY } from '../../../shared/server/paths.ts';
import type { AnswerByType, Attempt, ChoiceContent, ExerciseBody, FillContent, GradingSettings, GradingStreamEvents } from '../api.ts';
import { countWords } from '../text.ts';
import type { GradingOutcome, PracticeStore } from './store.ts';

const PROMPT_PATH = join(FEATURES_DIRECTORY, 'practice', 'prompts', 'grade.md');
const LETTERS = 'ABCDEF';

let grading_request_count = 0;

// The answer as a person would read it: the text, the options picked, the gaps typed.
function answerTextOf(exercise: ExerciseBody, answer: AnswerByType[keyof AnswerByType]): string {
  if ('text' in answer) return answer.text;
  if ('chosen' in answer) {
    // "B. The option's text", one line per option picked.
    const { options } = exercise.content as ChoiceContent;
    return answer.chosen.map((index) => `${LETTERS[index]}. ${options[index].text}`).join('\n');
  }
  if ('gaps' in answer) {
    // "Gap 2: what was typed", one line per gap.
    const { gaps } = exercise.content as FillContent;
    return gaps.map((_gap, index) => {
      const typed = answer.gaps[index];
      return `Gap ${index + 1}: ${typed === '' ? '(blank)' : typed}`;
    }).join('\n');
  }
  return '';
}

export function userMessageOf(exercise: ExerciseBody, answer: AnswerByType[keyof AnswerByType]): string {
  const { type, topic, tags, content } = exercise;
  const exercise_json = JSON.stringify({ type, topic, tags, content }, null, 2);
  const words = 'text' in answer ? ` word_count="${countWords(answer.text)}"` : '';
  const answer_text = answerTextOf(exercise, answer);
  return `Evaluate this answer.\n\n<exercise>\n${exercise_json}\n</exercise>\n\n<answer${words}>\n${answer_text}\n</answer>`;
}

// Read at every grading, so an edit of the prompt applies without a restart.
export function systemPrompt(): string {
  return `${readFileSync(PROMPT_PATH, 'utf8').trim()}\n`;
}

// A grading in progress: what it has produced so far, and the pages watching it.
interface Grading {
  settings: GradingSettings;
  started_at: number;
  thinking_text: string;
  thinking_ms: number | null;
  text: string;
  watchers: Set<ServerResponse>;
}

export interface Grader {
  // Starts grading the attempt, which must be in status 'grading'; the outcome is written to the store when it ends.
  start(attempt: Attempt, settings: GradingSettings): void;
  // Answers a request to watch the attempt's grading; a 'finished' event at once when it is not being graded.
  watch(res: ServerResponse, attempt_id: number): void;
}

function sendEvent<Name extends keyof GradingStreamEvents>(res: ServerResponse, name: Name, data: GradingStreamEvents[Name]): void {
  if (!res.destroyed && !res.writableEnded) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function createGrader(store: PracticeStore): Grader {
  // One entry per attempt being graded; removed when its outcome is saved.
  const gradings = new Map<number, Grading>();

  function start(attempt: Attempt, settings: GradingSettings): void {
    if (gradings.has(attempt.id)) return;
    const request_number = ++grading_request_count;
    const { snapshot: exercise } = attempt;
    const { model_id, effort } = settings;
    const grading: Grading = { settings, started_at: Date.now(), thinking_text: '', thinking_ms: null, text: '', watchers: new Set() };
    gradings.set(attempt.id, grading);
    const tell = <Name extends keyof GradingStreamEvents>(name: Name, data: GradingStreamEvents[Name]): void => {
      for (const watcher of grading.watchers) sendEvent(watcher, name, data);
    };
    // The outcome is saved before the watchers are told, so what they read next is final. A throw here would escape a stream
    // handler and stop the server; a failed save must only be logged.
    const finish = (outcome: GradingOutcome): void => {
      try {
        store.finishGrading(attempt.id, outcome);
      } catch (save_error) {
        log('error', request_number, 'practice', `saving attempt ${attempt.id} failed: ${(save_error as Error).message}`);
      }
      gradings.delete(attempt.id);
      if (outcome.status === 'graded') tell('done', {});
      else tell('error', { message: outcome.error });
      for (const watcher of grading.watchers) watcher.end();
    };
    log('info', request_number, 'grade', `${exercise.type}  ${modelLabelOf(model_id)} ${effort}  attempt ${attempt.id}`);
    const run = runClaude({
      request_number,
      settings: { model_id, effort, system_prompt: systemPrompt() },
      user_message: userMessageOf(exercise, attempt.answer),
      handlers: {
        onThinkingDelta: (text) => { grading.thinking_text += text; tell('thinking_delta', { text }); },
        onThinkingDone: (duration_ms) => { grading.thinking_ms = duration_ms; tell('thinking_done', { duration_ms }); },
        onText: (text) => { grading.text += text; tell('text_delta', { text }); },
        onRetry: (retry) => tell('retry', retry),
        onFallback: (fallback) => tell('fallback', fallback),
        onDone: (reply_text) => {
          const grading_ms = Date.now() - grading.started_at;
          const model = run.served_model_id();
          const text = reply_text.trim();
          if (text === '') {
            log('error', request_number, 'error', `${modelLabelOf(model)}  ${formatSeconds(grading_ms)}  empty reply  attempt ${attempt.id}`);
            finish({ status: 'failed', error: 'The grader sent no text.', model, grading_ms });
            return;
          }
          finish({ status: 'graded', text, thinking_text: grading.thinking_text, thinking_ms: grading.thinking_ms, model, effort, grading_ms });
          log('info', request_number, 'graded', `${modelLabelOf(model).padEnd(10)}  ${effort.padEnd(6)}  ${formatSeconds(grading_ms).padStart(6)}  ${formatCount(text.length)} characters  attempt ${attempt.id}`);
        },
        onError: (error, failure_text, failure_detail_lines) => {
          const grading_ms = Date.now() - grading.started_at;
          const model = run.served_model_id();
          log('error', request_number, 'error', `${modelLabelOf(model)}  ${formatSeconds(grading_ms)}  ${error.error_kind}: ${failure_text}  attempt ${attempt.id}`, failure_detail_lines);
          finish({ status: 'failed', error: error.message, model, grading_ms });
        },
      },
    });
  }

  function watch(res: ServerResponse, attempt_id: number): void {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const grading = gradings.get(attempt_id);
    if (grading === undefined) {
      sendEvent(res, 'finished', {});
      res.end();
      return;
    }
    const { thinking_text, thinking_ms, text, settings, started_at } = grading;
    sendEvent(res, 'snapshot', { thinking_text, thinking_ms, text, ...settings, elapsed_ms: Date.now() - started_at });
    grading.watchers.add(res);
    res.on('close', () => grading.watchers.delete(res));
  }

  return { start, watch };
}
