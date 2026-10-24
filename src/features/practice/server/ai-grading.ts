// Grades one saved attempt (every type but a flashcard) with `claude -p`: one common prompt (prompts/grade.md), the exercise
// as stored in the attempt and the answer. The reply is Markdown and is stored as it is, with the grader's thinking summary,
// in the attempt's grading (a ModelRun and its feedback). The grading runs on the server and writes its outcome to the store,
// so closing the page does not stop it; what it has produced so far is kept in memory, so a page that comes back
// mid-grading is sent that first, then the rest.
import { readFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import { modelLabelOf, runClaude, type Run } from '../../../shared/server/claude-runner.ts';
import { formatCount, formatSeconds, log, nextRequestNumber } from '../../../shared/server/log.ts';
import { FEATURES_DIRECTORY } from '../../../shared/server/paths.ts';
import type { Answer, AttemptDetail, ExerciseSnapshot, GradingSettings, GradingStreamEvents } from '../api-types.ts';
import { countWords } from '../text.ts';
import type { GradingOutcome, PracticeStore } from './store.ts';

const PROMPT_PATH = join(FEATURES_DIRECTORY, 'practice', 'prompts', 'grade.md');
const LETTERS = 'ABCDEF';

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
  const exerciseJson = JSON.stringify({ topic, tags, content }, null, 2);
  let words = '';
  if ('text' in answer) words = ` word_count="${countWords(answer.text)}"`;
  const answerText = answerTextOf(exercise, answer);
  return `Evaluate this answer.\n\n<exercise>\n${exerciseJson}\n</exercise>\n\n<answer${words}>\n${answerText}\n</answer>`;
}

// Read at every grading, so an edit of the prompt applies without a restart.
export function systemPrompt(): string {
  return `${readFileSync(PROMPT_PATH, 'utf8').trim()}\n`;
}

// A grading in progress: what it has produced so far, and the pages watching it.
interface LiveGrading {
  settings: GradingSettings;
  startedAt: number;
  thinkingText: string;
  thinkingMs: number | null;
  text: string;
  watchers: Set<ServerResponse>;
}

interface Grader {
  // Runs the grading (stored as running) of the attempt; the outcome is written to the store when it ends.
  start(attempt: AttemptDetail, gradingId: number, settings: GradingSettings): void;
  // Answers a request to watch the attempt's grading; a 'finished' event at once when it is not being graded.
  watch(res: ServerResponse, attemptId: number): void;
}

function sendEvent<Name extends keyof GradingStreamEvents>(res: ServerResponse, name: Name, data: GradingStreamEvents[Name]): void {
  if (!res.destroyed && !res.writableEnded) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function createGrader(store: PracticeStore): Grader {
  // One entry per attempt being graded (at most one grading of an attempt runs: rule 7); removed when its outcome is saved.
  const liveGradings = new Map<number, LiveGrading>();

  function start(attempt: AttemptDetail, gradingId: number, settings: GradingSettings): void {
    if (liveGradings.has(attempt.id)) return;
    const requestNumber = nextRequestNumber();
    const { exerciseSnapshot: exercise } = attempt;
    const { modelId, effort } = settings;
    const live: LiveGrading = { settings, startedAt: Date.now(), thinkingText: '', thinkingMs: null, text: '', watchers: new Set() };
    liveGradings.set(attempt.id, live);
    const tell = <Name extends keyof GradingStreamEvents>(name: Name, data: GradingStreamEvents[Name]): void => {
      for (const watcher of live.watchers) sendEvent(watcher, name, data);
    };
    // The outcome is saved before the watchers are told, so what they read next is final. A throw here would escape a stream
    // handler and stop the server; a failed save must only be logged.
    const finish = (outcome: GradingOutcome): void => {
      try {
        store.finishGrading(gradingId, outcome);
      } catch (saveError) {
        log('error', requestNumber, 'practice', `saving grading ${gradingId} of attempt ${attempt.id} failed: ${(saveError as Error).message}`);
      }
      liveGradings.delete(attempt.id);
      if (outcome.status === 'succeeded') tell('done', {});
      else tell('error', { message: outcome.errorMessage });
      for (const watcher of live.watchers) watcher.end();
    };
    // null until runClaude returns.
    let run: Run | null = null;
    const currentServedModelId = (): string => run?.servedModelId() ?? modelId;
    const whatSoFar = () => ({ thinkingText: live.thinkingText, thinkingMs: live.thinkingMs, feedbackMarkdown: live.text });
    log('info', requestNumber, 'grade', `${exercise.content.type}  ${modelLabelOf(modelId)} ${effort}  attempt ${attempt.id}`);
    run = runClaude({
      requestNumber,
      settings: { modelId, effort, systemPrompt: systemPrompt() },
      userMessage: userMessageOf(exercise, attempt.answer),
      handlers: {
        onThinkingDelta: (text) => {
          live.thinkingText += text;
          tell('thinking_delta', { text });
        },
        onThinkingDone: (durationMs) => {
          live.thinkingMs = durationMs;
          tell('thinking_done', { durationMs });
        },
        onText: (text) => {
          live.text += text;
          tell('text_delta', { text });
        },
        onRetry: (retry) => tell('retry', retry),
        onFallback: (fallback) => tell('fallback', fallback),
        onDone: (replyText) => {
          const gradingMs = Date.now() - live.startedAt;
          const servedModelId = currentServedModelId();
          const text = replyText.trim();
          if (text === '') {
            log('error', requestNumber, 'error', `${modelLabelOf(servedModelId)}  ${formatSeconds(gradingMs)}  empty reply  attempt ${attempt.id}`);
            const error = { errorCode: 'empty_reply' as const, errorMessage: 'The grader sent no text.' };
            finish({ status: 'failed', servedModelId, ...whatSoFar(), ...error });
            return;
          }
          finish({ status: 'succeeded', servedModelId, ...whatSoFar(), feedbackMarkdown: text });
          const timing = `${modelLabelOf(servedModelId).padEnd(10)}  ${effort.padEnd(6)}  ${formatSeconds(gradingMs).padStart(6)}`;
          log('info', requestNumber, 'graded', `${timing}  ${formatCount(text.length)} characters  attempt ${attempt.id}`);
        },
        onError: (error, failureText, failureDetailLines) => {
          const gradingMs = Date.now() - live.startedAt;
          const servedModelId = currentServedModelId();
          const summary = `${modelLabelOf(servedModelId)}  ${formatSeconds(gradingMs)}  ${error.errorCode}: ${failureText}  attempt ${attempt.id}`;
          log('error', requestNumber, 'error', summary, failureDetailLines);
          const failure = { errorCode: error.errorCode, errorMessage: error.message };
          finish({ status: 'failed', servedModelId, ...whatSoFar(), ...failure });
        },
      },
    });
  }

  function watch(res: ServerResponse, attemptId: number): void {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const live = liveGradings.get(attemptId);
    if (live === undefined) {
      sendEvent(res, 'finished', {});
      res.end();
      return;
    }
    sendEvent(res, 'snapshot', {
      thinkingText: live.thinkingText,
      thinkingMs: live.thinkingMs,
      text: live.text,
      modelId: live.settings.modelId,
      effort: live.settings.effort,
      elapsedMs: Date.now() - live.startedAt,
    });
    live.watchers.add(res);
    res.on('close', () => live.watchers.delete(res));
  }

  return { start, watch };
}
