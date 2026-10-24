// Makes a Practice project from a translated post with `claude -p` (docs/practice-from-translation-design.md §4 and §5):
// one prompt (prompts/generate.md), the post and a plan of how many exercises of each kind. The reply is checked
// (generation-check.ts), and the exercises that pass become a new project. Like a grading, it runs on the server and saves
// its outcome to the store, so closing the page does not stop it; its progress is kept in memory, so a page that comes back
// mid-run is sent that first, then the rest.
import { readFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { Effort, GenerationDetail } from '../../../shared/api-types.ts';
import { modelLabelOf, runClaude, type Run } from '../../../shared/server/claude-runner.ts';
import { formatCount, formatSeconds, log, nextRequestNumber } from '../../../shared/server/log.ts';
import { FEATURES_DIRECTORY } from '../../../shared/server/paths.ts';
import type { GenerationStreamEvents } from '../api-types.ts';
import {
  checkReply, firstTokenAllowanceMsOf, planOf, postWordCount, projectFileOf, projectKeyOf, userMessageOf,
} from '../generation-check.ts';
import type { GenerationOutcome, NewGeneration, PracticeStore } from './store.ts';

const PROMPT_PATH = join(FEATURES_DIRECTORY, 'practice', 'prompts', 'generate.md');
// Build step 1 compared the options on translation 24.
export const GENERATION_SETTINGS: { modelId: string; effort: Effort } = { modelId: 'claude-opus-5-5', effort: 'medium' };
// Every exercise of the reply starts with its key, so counting them as they stream in shows the progress.
const KEY_FIELD = /"key"\s*:/g;

// Read at every generation, so an edit of the prompt applies without a restart.
export function systemPrompt(): string {
  return `${readFileSync(PROMPT_PATH, 'utf8').trim()}\n`;
}

// A generation in progress: what it has produced so far, and the pages watching it.
interface LiveGeneration {
  generation: GenerationDetail;
  startedAt: number;
  thinkingText: string;
  thinkingMs: number | null;
  text: string;
  exerciseCount: number;
  watchers: Set<ServerResponse>;
}

interface Generator {
  // Runs the generation (stored as running) of the post; the outcome is written to the store when it ends.
  start(generation: GenerationDetail, post: NewGeneration): void;
  // Answers a request to watch the generation; a 'finished' event at once when it is not running.
  watch(res: ServerResponse, generationId: number): void;
}

function sendEvent<Name extends keyof GenerationStreamEvents>(res: ServerResponse, name: Name, data: GenerationStreamEvents[Name]): void {
  if (!res.destroyed && !res.writableEnded) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function createGenerator(store: PracticeStore): Generator {
  // One entry per running generation; removed when its outcome is saved.
  const liveGenerations = new Map<number, LiveGeneration>();

  function start(generation: GenerationDetail, post: NewGeneration): void {
    if (liveGenerations.has(generation.id)) return;
    const requestNumber = nextRequestNumber();
    const modelId = generation.run.requestedModelId ?? GENERATION_SETTINGS.modelId;
    const effort = generation.run.effort ?? GENERATION_SETTINGS.effort;
    const plan = planOf(postWordCount(post.blocks));
    const live: LiveGeneration = {
      generation, startedAt: Date.now(), thinkingText: '', thinkingMs: null, text: '', exerciseCount: 0, watchers: new Set(),
    };
    liveGenerations.set(generation.id, live);
    const tell = <Name extends keyof GenerationStreamEvents>(name: Name, data: GenerationStreamEvents[Name]): void => {
      for (const watcher of live.watchers) sendEvent(watcher, name, data);
    };
    // The outcome is saved before the watchers are told, so what they read next is final. A throw here would escape a stream
    // handler and stop the server; a failed save must only be logged.
    const finish = (outcome: GenerationOutcome): void => {
      let projectKey: string | null = null;
      try {
        projectKey = store.finishGeneration(generation.id, outcome);
      } catch (saveError) {
        log('error', requestNumber, 'practice', `saving generation ${generation.id} failed: ${(saveError as Error).message}`);
      }
      liveGenerations.delete(generation.id);
      if (outcome.status === 'failed') tell('error', { message: outcome.errorMessage });
      else if (projectKey === null) tell('error', { message: 'The project could not be saved; the details are in the server log.' });
      else tell('done', { projectKey });
      for (const watcher of live.watchers) watcher.end();
    };
    // null until runClaude returns.
    let run: Run | null = null;
    const currentServedModelId = (): string => run?.servedModelId() ?? modelId;
    const whatSoFar = () => ({ thinkingText: live.thinkingText, thinkingMs: live.thinkingMs, replyText: live.text });
    log('info', requestNumber, 'generate', `${modelLabelOf(modelId)} ${effort}  translation ${post.translationId}  ${plan.total} exercises`);
    run = runClaude({
      requestNumber,
      settings: { modelId, effort, systemPrompt: systemPrompt() },
      userMessage: userMessageOf(post, plan),
      firstTokenAllowanceMs: firstTokenAllowanceMsOf(post.blocks),
      handlers: {
        onThinkingDelta: (text) => {
          live.thinkingText += text;
        },
        onThinkingDone: (durationMs) => {
          live.thinkingMs = durationMs;
        },
        onText: (text) => {
          live.text += text;
          const exerciseCount = live.text.match(KEY_FIELD)?.length ?? 0;
          if (exerciseCount === live.exerciseCount) return;
          live.exerciseCount = exerciseCount;
          tell('progress', { exerciseCount });
        },
        onRetry: (retry) => tell('retry', retry),
        onFallback: (fallback) => tell('fallback', fallback),
        onDone: (replyText) => {
          const generationMs = Date.now() - live.startedAt;
          const servedModelId = currentServedModelId();
          const timing = `${modelLabelOf(servedModelId)}  ${formatSeconds(generationMs)}`;
          const checked = checkReply(replyText, plan);
          if (checked.reply === null) {
            log('error', requestNumber, 'error', `${timing}  invalid_reply: ${checked.problem}  generation ${generation.id}`);
            finish({ status: 'failed', servedModelId, ...whatSoFar(), replyText, errorCode: 'invalid_reply', errorMessage: checked.problem });
            return;
          }
          const { reply } = checked;
          const file = projectFileOf(post, reply, projectKeyOf(post.translationId, reply.name));
          finish({ status: 'succeeded', servedModelId, ...whatSoFar(), replyText, file, droppedCount: reply.droppedCount });
          const counts = `${reply.exercises.length} of ${plan.total} exercises, ${reply.droppedCount} dropped, ${formatCount(replyText.length)} characters`;
          log('info', requestNumber, 'generated', `${timing}  ${counts}  generation ${generation.id}`, [...reply.droppedLines, ...reply.warnings]);
        },
        onError: (error, failureText, failureDetailLines) => {
          const generationMs = Date.now() - live.startedAt;
          const servedModelId = currentServedModelId();
          const summary = `${modelLabelOf(servedModelId)}  ${formatSeconds(generationMs)}  ${error.errorCode}: ${failureText}  generation ${generation.id}`;
          log('error', requestNumber, 'error', summary, failureDetailLines);
          const failure = { errorCode: error.errorCode, errorMessage: error.message };
          finish({ status: 'failed', servedModelId, ...whatSoFar(), ...failure });
        },
      },
    });
  }

  function watch(res: ServerResponse, generationId: number): void {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const live = liveGenerations.get(generationId);
    if (live === undefined) {
      sendEvent(res, 'finished', {});
      res.end();
      return;
    }
    const { generation } = live;
    sendEvent(res, 'snapshot', {
      exerciseCount: live.exerciseCount,
      targetCount: generation.targetCount,
      modelId: generation.run.requestedModelId ?? GENERATION_SETTINGS.modelId,
      effort: generation.run.effort ?? GENERATION_SETTINGS.effort,
      elapsedMs: Date.now() - live.startedAt,
    });
    live.watchers.add(res);
    res.on('close', () => live.watchers.delete(res));
  }

  return { start, watch };
}
