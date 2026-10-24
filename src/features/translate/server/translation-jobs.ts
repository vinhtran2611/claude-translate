// Translate runs as jobs owned by the server (docs/translate-background-jobs-design.md). POST /translate starts one and
// any page watches it over Server-Sent Events; closing a stream only stops watching, and only cancel stops a run. What a
// run has produced so far is kept in memory, so a page that comes back mid-run is sent that first, then the rest. The
// shape and names follow Practice's gradings and generations: start, watch, and a finish that saves before it tells.
import type { ServerResponse } from 'node:http';
import type { CliErrorCode, Effort, TranslatedBlock } from '../../../shared/api-types.ts';
import { modelLabelOf, runClaude, type ClaudeProcess, type Run } from '../../../shared/server/claude-runner.ts';
import { formatCount, formatSeconds, log, nextRequestNumber, type LogLevel } from '../../../shared/server/log.ts';
import type { Language, Outcome, RunNotice, SourceFormat, StreamEvent, TranslateRequest, Translation } from '../api-types.ts';
import type { HistoryStore, InterruptedTranslation } from './history-store.ts';
import { createPairStreamParser } from './pair-stream-parser.ts';
import { systemPromptOf } from './translate-prompt.ts';

// What a translate process is started with; all three are fixed for its lifetime.
export interface TranslateSettings {
  modelId: string;
  effort: Effort;
  sourceFormat: SourceFormat;
}

// Room for a handful of documents at once. The subscription quota is the real limit, and each claude process takes about
// 200-250 MB. Raised from 3 after use; the gateway still plans 3 (docs/llm-gateway-design.md §5 step 3), so the two are
// set again when it takes over. A run past the limit is refused, not queued.
export const MAX_RUNNING_TRANSLATIONS = 5;
// Measured on Claude's tokenizer from a 19.5k-char en->vi run: English ~4 chars per token, Vietnamese ~1.3.
const CHARS_PER_TOKEN: Record<Language, number> = { en: 4, vi: 1.3 };
// Arbitrary: reading a long input delays the first token; 1s per 10k input tokens keeps a 77k-token input from
// being mistaken for a silent model.
const FIRST_TOKEN_MS_PER_INPUT_TOKEN = 0.1;
// Bounds what a crash loses to a few seconds of text, at one write per interval: a 100k-char run rewrites ~230 KB per write.
const CHECKPOINT_INTERVAL_MS = 5000;
const LANGUAGE_NAMES: Record<Language, string> = { en: 'English', vi: 'Vietnamese' };
const RUN_STATUS_OF_OUTCOME = { done: 'succeeded', error: 'failed', cancelled: 'cancelled' } as const;
// Arbitrary: enough ids to find the rows after a restart; the rest are counted, so the line stays one terminal line.
const MAX_LISTED_INTERRUPTED = 10;

// What stopped a cancelled run: the Cancel button or Esc (one request, the server cannot tell them apart), or a delete.
export type CancelCause = 'cancel' | 'delete';

// What the model has produced so far, in the shape history stores. thinkingDurationMs stays null unless a thinking
// block closed.
interface TranslationOutput {
  blocks: TranslatedBlock[];
  textOutsideBlocks: string;
  thinkingText: string;
  thinkingDurationMs: number | null;
}

// A run in progress: its request, what it has produced so far, and the pages watching it.
interface LiveTranslation {
  id: number;
  request: TranslateRequest;
  // The log's #n.
  requestNumber: number;
  // Date.now() at start.
  startedAt: number;
  // Written only by foldOutput.
  output: TranslationOutput;
  // The latest retry or fallback; cleared by the next block or outside text, as the page clears its note.
  notice: RunNotice | null;
  // Date.now() of the last checkpoint; startedAt at first. Written only by saveCheckpoint.
  lastSavedAt: number;
  // Checkpoints saved, for the closing line. Written only by saveCheckpoint.
  checkpointCount: number;
  // A failed checkpoint is logged once per run.
  hasCheckpointFailed: boolean;
  // null until runClaude returns, which calls no handler before it does.
  run: Run | null;
  // null until the run gets that far.
  firstTextMs: number | null;
  outputTokens: number | null;
  watchers: Set<ServerResponse>;
}

export interface TranslationJobs {
  // Saves the row and starts the run; the row's id. The caller checks isFull() first. Throws when the row cannot be saved.
  start(request: TranslateRequest): number;
  // True when MAX_RUNNING_TRANSLATIONS jobs are live.
  isFull(): boolean;
  // The one rule for "is this run live": it is in the live map.
  isLive(translationId: number): boolean;
  // The live runs' row ids, oldest first, for the 429 line.
  liveIds(): number[];
  // Streams a run to one page: snapshot, live events, closing event. A run that is not live gets `finished` and the
  // stream ends. isReattach: a page coming back to a run, not the page that started it; only that is logged.
  watch(res: ServerResponse, translationId: number, isReattach: boolean): void;
  // Stops a live run and saves it as cancelled; cause goes to the closing line. false when it is not live.
  cancel(translationId: number, cause: CancelCause): boolean;
}

interface JobsOptions {
  historyStore: HistoryStore;
  // The warm spare, or a new process when the spare was started for other settings (routes.ts).
  takeClaudeProcess(settings: TranslateSettings): { claudeProcess: ClaudeProcess; isColdStart: boolean };
  // A result arrived, so the CLI works (routes.ts clears its spare warning).
  noteClaudeResult(): void;
}

function sendEvent(res: ServerResponse, ...[eventName, data]: StreamEvent): void {
  if (res.destroyed || res.writableEnded) return;
  res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
}

// "1 block", "18 blocks".
function formatCountOf(count: number, noun: string): string {
  const nounText = count === 1 ? noun : `${noun}s`;
  return `${formatCount(count)} ${nounText}`;
}

// The slots in use, as the start, closing and 429 lines print them.
export function formatRunningCount(runningCount: number): string {
  return `${runningCount}/${MAX_RUNNING_TRANSLATIONS} running`;
}

// The start line's message. runningCount counts this run; `cold start` stays last.
export function formatStartLine({ request, historyId, runningCount, isColdStart }: {
  request: TranslateRequest; historyId: number; runningCount: number; isColdStart: boolean;
}): string {
  const { sourceLanguage, targetLanguage, sourceText, modelId, effort, sourceFormat } = request;
  const fields = [
    `${sourceLanguage}->${targetLanguage}`,
    `${formatCount(sourceText.length)} chars`,
    `${modelLabelOf(modelId)} ${effort}`,
    sourceFormat,
    `history ${historyId}`,
    formatRunningCount(runningCount),
  ];
  if (isColdStart) fields.push('cold start');
  return fields.join('  ');
}

// The closing line's message. A fact the request never reached (null, or no tokens) is left out. 10, 6 and 6 fit
// 'Sonnet 5.5', 'medium' and '144.5s', so model, effort and duration line up across closing lines. failureText is an
// error's `errorCode: reason` or a cancel's `by cancel`; runningCount is the slots in use once this run has left.
export function formatRequestSummary({
  outcome, modelLabel, effort, durationMs, failureText, firstTextMs, thinkingDurationMs, blockCount,
  outsideCharCount, outputTokens, checkpointCount, historyId, runningCount, isUnread,
}: {
  outcome: Outcome; modelLabel: string; effort: Effort; durationMs: number; failureText: string; firstTextMs: number | null;
  thinkingDurationMs: number | null; blockCount: number; outsideCharCount: number; outputTokens: number | null;
  checkpointCount: number; historyId: number; runningCount: number; isUnread: boolean;
}): string {
  const fields = [modelLabel.padEnd(10), effort.padEnd(6), formatSeconds(durationMs).padStart(6)];
  if (failureText !== '') fields.push(failureText);
  if (firstTextMs !== null) fields.push(`first text ${formatSeconds(firstTextMs)}`);
  if (thinkingDurationMs !== null) fields.push(`thought ${formatSeconds(thinkingDurationMs)}`);
  if (blockCount > 0 || outcome === 'done') fields.push(formatCountOf(blockCount, 'block'));
  if (outsideCharCount > 0) fields.push(`${formatCount(outsideCharCount)} chars outside blocks`);
  if (outputTokens !== null && outputTokens > 0) fields.push(`${formatCount(outputTokens)} tokens`);
  if (checkpointCount > 0) fields.push(formatCountOf(checkpointCount, 'checkpoint'));
  fields.push(`history ${historyId}`);
  fields.push(formatRunningCount(runningCount));
  if (isUnread) fields.push('unread');
  return fields.join('  ');
}

// The startup line for the rows a restart cut short, by history id: the old #n mean nothing in the new process.
export function formatInterruptedLine(interrupted: InterruptedTranslation[]): string {
  const listedRows = interrupted.slice(0, MAX_LISTED_INTERRUPTED);
  const rowTexts = listedRows.map(({ id, blockCount }) => {
    const savedText = blockCount === 0 ? 'nothing saved' : `${formatCountOf(blockCount, 'block')} saved`;
    return `${id} (${savedText})`;
  });
  const unlistedCount = interrupted.length - listedRows.length;
  if (unlistedCount > 0) rowTexts.push(`and ${unlistedCount} more`);
  return `${formatCountOf(interrupted.length, 'translation')} interrupted by a restart: ${rowTexts.join(', ')}`;
}

// The closing log line is a warning when the model ignored the block format, an error when the run failed.
function closingLogLevel(outcome: Outcome, blockCount: number, outsideCharCount: number): LogLevel {
  if (outcome === 'error') return 'error';
  const isBlockFormatBroken = outcome === 'done' && (blockCount === 0 || outsideCharCount > 0);
  if (isBlockFormatBroken) return 'warn';
  return 'info';
}

// The requested model, or its fallback once runClaude has handed over.
function currentServedModelId(live: LiveTranslation): string {
  return live.run?.servedModelId() ?? live.request.modelId;
}

// The row as it would read if it were saved now: the snapshot a late watcher starts from.
function translationOf(live: LiveTranslation): Translation {
  const { request, output } = live;
  const startedAt = new Date(live.startedAt).toISOString();
  let textOutsideBlocks: string | null = output.textOutsideBlocks;
  if (textOutsideBlocks === '') textOutsideBlocks = null;
  let thinkingText: string | null = output.thinkingText;
  if (thinkingText === '') thinkingText = null;
  return {
    id: live.id,
    sourceLanguage: request.sourceLanguage,
    targetLanguage: request.targetLanguage,
    sourceFormat: request.sourceFormat,
    sourceText: request.sourceText,
    blocks: output.blocks,
    textOutsideBlocks,
    run: {
      status: 'running',
      requestedModelId: request.modelId,
      servedModelId: currentServedModelId(live),
      effort: request.effort,
      thinkingText,
      thinkingMs: output.thinkingDurationMs,
      errorCode: null,
      errorMessage: null,
      startedAt,
      finishedAt: null,
    },
    createdAt: startedAt,
    updatedAt: new Date(live.lastSavedAt).toISOString(),
  };
}

export function createTranslationJobs({ historyStore, takeClaudeProcess, noteClaudeResult }: JobsOptions): TranslationJobs {
  // One entry per running translation, keyed by its row id; removed by finishJob. Its size is the slots in use.
  const liveTranslations = new Map<number, LiveTranslation>();

  function isLive(translationId: number): boolean {
    return liveTranslations.has(translationId);
  }

  function isFull(): boolean {
    return liveTranslations.size >= MAX_RUNNING_TRANSLATIONS;
  }

  // A Map keeps insertion order, which is start order.
  function liveIds(): number[] {
    return [...liveTranslations.keys()];
  }

  function tell(live: LiveTranslation, ...streamEvent: StreamEvent): void {
    for (const watcher of live.watchers) sendEvent(watcher, ...streamEvent);
  }

  // Folds the model's output into live.output, then sends it on: the output is exactly what the watchers were sent, so a
  // snapshot plus the events after it is the whole run.
  function foldOutput(live: LiveTranslation, outputEvents: StreamEvent[]): void {
    const { output } = live;
    for (const outputEvent of outputEvents) {
      const [eventName, data] = outputEvent;
      if (eventName === 'block_start') {
        const { blockType, level, marker } = data;
        output.blocks[data.blockIndex] = { blockType, level, marker, sourceText: '', translatedText: '' };
        live.notice = null;
      } else if (eventName === 'source_delta') {
        output.blocks[data.blockIndex].sourceText += data.text;
        live.notice = null;
      } else if (eventName === 'translation_delta') {
        output.blocks[data.blockIndex].translatedText += data.text;
        live.notice = null;
      } else if (eventName === 'outside_text_delta') {
        output.textOutsideBlocks += data.text;
        live.notice = null;
      } else if (eventName === 'thinking_delta') {
        output.thinkingText += data.text;
      } else if (eventName === 'thinking_done') {
        output.thinkingDurationMs = data.durationMs;
      }
      tell(live, ...outputEvent);
    }
    if (Date.now() - live.lastSavedAt >= CHECKPOINT_INTERVAL_MS) saveCheckpoint(live);
  }

  // Saves the output so far, so a server that stops mid-run keeps all but the last few seconds; the restart rule then
  // marks the row interrupted with it. No timer: a run that streams nothing has nothing new to save. A failed write does
  // not stop the job, whose final save writes everything again.
  function saveCheckpoint(live: LiveTranslation): void {
    live.lastSavedAt = Date.now();
    const { output } = live;
    try {
      historyStore.saveProgress(live.id, {
        blocks: output.blocks,
        textOutsideBlocks: output.textOutsideBlocks,
        servedModelId: currentServedModelId(live),
        thinkingText: output.thinkingText,
        thinkingMs: output.thinkingDurationMs,
      });
      live.checkpointCount += 1;
    } catch (saveError) {
      if (live.hasCheckpointFailed) return;
      live.hasCheckpointFailed = true;
      const message = (saveError as Error).message;
      log('error', live.requestNumber, 'history', `${live.id} checkpoint failed: ${message}; a crash keeps the last good one`);
    }
  }

  // The one place a run ends: saves how it ended with what the model produced, logs the closing line, then tells every
  // watcher and ends their streams. When outcome is 'error', error = { errorCode, message } goes to the page and the saved
  // run, and failureText (one line) and failureDetailLines (e.g. a stderr tail) go to the log only; a cancel's
  // failureText is its cause. A throw here would escape a stream handler and stop the server, so a failed save is only
  // logged.
  function finishJob(
    live: LiveTranslation, outcome: Outcome, error: { errorCode: CliErrorCode; message: string } | null = null, failureText = '',
    failureDetailLines: string[] = [],
  ): void {
    if (!isLive(live.id)) return;
    const { request, output } = live;
    const servedModelId = currentServedModelId(live);
    const durationMs = Date.now() - live.startedAt;
    const blockCount = output.blocks.length;
    const outsideCharCount = output.textOutsideBlocks.length;
    let textOutsideBlocks = output.textOutsideBlocks;
    if (textOutsideBlocks.trim() === '') textOutsideBlocks = '';
    // A run someone watched end is never unread. Worked out once, so the saved row and the log line agree.
    const isUnread = live.watchers.size === 0;
    try {
      historyStore.finishTranslation(live.id, {
        status: RUN_STATUS_OF_OUTCOME[outcome],
        blocks: output.blocks,
        textOutsideBlocks,
        servedModelId,
        thinkingText: output.thinkingText,
        thinkingMs: output.thinkingDurationMs,
        errorCode: error?.errorCode ?? null,
        errorMessage: error?.message ?? null,
        isUnread,
      });
    } catch (saveError) {
      const message = (saveError as Error).message;
      log('error', live.requestNumber, 'history', `${live.id} save failed: ${message}; the row stays running until a restart marks it interrupted`);
    }
    liveTranslations.delete(live.id);
    let summaryFailureText = failureText;
    if (error !== null) summaryFailureText = `${error.errorCode}: ${failureText}`;
    const summary = formatRequestSummary({
      outcome,
      modelLabel: modelLabelOf(servedModelId),
      effort: request.effort,
      durationMs,
      failureText: summaryFailureText,
      firstTextMs: live.firstTextMs,
      thinkingDurationMs: output.thinkingDurationMs,
      blockCount,
      outsideCharCount,
      outputTokens: live.outputTokens,
      checkpointCount: live.checkpointCount,
      historyId: live.id,
      runningCount: liveTranslations.size,
      isUnread,
    });
    log(closingLogLevel(outcome, blockCount, outsideCharCount), live.requestNumber, outcome, summary, failureDetailLines);
    const isFallback = servedModelId !== request.modelId;
    const runFacts = { servedModelId, effort: request.effort, isFallback, translationId: live.id };
    if (outcome === 'done') tell(live, 'done', { durationMs, ...runFacts });
    else if (outcome === 'cancelled') tell(live, 'cancelled', { durationMs, translationId: live.id });
    else if (error !== null) tell(live, 'error', { ...error, ...runFacts });
    for (const watcher of live.watchers) watcher.end();
  }

  function start(request: TranslateRequest): number {
    const { sourceLanguage, targetLanguage, sourceText, modelId: requestedModelId, effort, sourceFormat } = request;
    const requestNumber = nextRequestNumber();
    const startedAt = Date.now();
    // The run is saved as it starts (the spec's run rules), so a failure or a cancel is kept too. A job is keyed by its
    // row's id, so a failed save throws to the caller and nothing starts.
    const id = historyStore.startTranslation({
      sourceLanguage,
      targetLanguage,
      sourceFormat,
      sourceText,
      requestedModelId,
      effort,
      startedAt: new Date(startedAt).toISOString(),
    });
    const live: LiveTranslation = {
      id,
      request,
      requestNumber,
      startedAt,
      output: { blocks: [], textOutsideBlocks: '', thinkingText: '', thinkingDurationMs: null },
      notice: null,
      lastSavedAt: startedAt,
      checkpointCount: 0,
      hasCheckpointFailed: false,
      run: null,
      firstTextMs: null,
      outputTokens: null,
      watchers: new Set(),
    };
    liveTranslations.set(id, live);

    const directionLine = `Translate from ${LANGUAGE_NAMES[sourceLanguage]} into ${LANGUAGE_NAMES[targetLanguage]}.`;
    const firstTokenAllowanceMs = Math.round((sourceText.length / CHARS_PER_TOKEN[sourceLanguage]) * FIRST_TOKEN_MS_PER_INPUT_TOKEN);
    const pairParser = createPairStreamParser();
    const { claudeProcess, isColdStart } = takeClaudeProcess({ modelId: requestedModelId, effort, sourceFormat });
    const startLine = formatStartLine({ request, historyId: id, runningCount: liveTranslations.size, isColdStart });
    log('info', requestNumber, 'start', startLine);
    live.run = runClaude({
      requestNumber,
      settings: { modelId: requestedModelId, effort, systemPrompt: systemPromptOf(sourceFormat) },
      userMessage: `${directionLine}\n\n<input_text>\n${sourceText}\n</input_text>`,
      firstTokenAllowanceMs,
      claudeProcess,
      handlers: {
        onThinkingDelta: (thinkingText) => foldOutput(live, [['thinking_delta', { text: thinkingText }]]),
        onThinkingDone: (durationMs) => foldOutput(live, [['thinking_done', { durationMs }]]),
        onText: (replyText) => {
          if (live.firstTextMs === null) live.firstTextMs = Date.now() - startedAt;
          foldOutput(live, pairParser.push(replyText));
        },
        onRetry: (retry) => {
          live.notice = { kind: 'retry', ...retry };
          tell(live, 'retry', retry);
        },
        onFallback: (fallback) => {
          live.notice = { kind: 'fallback', ...fallback };
          tell(live, 'fallback', fallback);
        },
        onResultMessage: (resultOutputTokens) => {
          noteClaudeResult();
          foldOutput(live, pairParser.finish());
          live.outputTokens = resultOutputTokens;
        },
        onDone: () => finishJob(live, 'done'),
        onError: (error, failureText, failureDetailLines) => finishJob(live, 'error', error, failureText, failureDetailLines),
      },
    });
    return id;
  }

  // The snapshot is built and the watcher added in one synchronous step, so no event falls between them: Node handles
  // one claude stdout chunk at a time, and live.output is folded from exactly the events sent.
  function watch(res: ServerResponse, translationId: number, isReattach: boolean): void {
    // A page that closed its POST /translate while the body was being read: its 'close' has fired already, so it would
    // stay in the set until the job ends.
    if (res.destroyed) return;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const live = liveTranslations.get(translationId);
    if (live === undefined) {
      sendEvent(res, 'finished', {});
      res.end();
      return;
    }
    const elapsedMs = Date.now() - live.startedAt;
    sendEvent(res, 'snapshot', { translation: translationOf(live), notice: live.notice, elapsedMs });
    live.watchers.add(res);
    // Closing a stream only stops watching; the job runs on. Not logged: the closing line's `unread` gives the end
    // state, and a later `watch` shows the page came back (docs/server-log-design.md §10).
    res.on('close', () => live.watchers.delete(res));
    if (!isReattach) return;
    const blockText = formatCountOf(live.output.blocks.length, 'block');
    const watchLine = `history ${live.id}  at ${formatSeconds(elapsedMs)}  ${blockText}  ${live.watchers.size} watching`;
    log('info', live.requestNumber, 'watch', watchLine);
  }

  function cancel(translationId: number, cause: CancelCause): boolean {
    const live = liveTranslations.get(translationId);
    if (live === undefined) return false;
    // Stopped first, so the run reports nothing more and finishJob has the last word.
    live.run?.stop();
    finishJob(live, 'cancelled', null, `by ${cause}`);
    return true;
  }

  return { start, isFull, isLive, liveIds, watch, cancel };
}
