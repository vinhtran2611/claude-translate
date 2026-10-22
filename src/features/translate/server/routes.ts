// Translate's routes: the page at /, the settings menus, POST /translate (one `claude -p` run streamed back as
// Server-Sent Events) and the history.
import { watchFile } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, join } from 'node:path';
import type { Effort, CliErrorCode, TranslatedBlock } from '../../../shared/api-types.ts';
import {
  DEFAULT_EFFORT, DEFAULT_MODEL_ID, EFFORT_OPTIONS, isEffort, lastRateLimitInfo, MODEL_OPTIONS, modelLabelOf, modelOptionOf, runClaude, spawnClaudeProcess,
  type ClaudeProcess, type Run,
} from '../../../shared/server/claude-runner.ts';
import { readJsonBody, sendFile, sendJson, type Feature } from '../../../shared/server/http.ts';
import { formatCount, formatSeconds, lastLines, log, LOG_DETAIL_MAX_LINES, type LogLevel } from '../../../shared/server/log.ts';
import { FEATURES_DIRECTORY } from '../../../shared/server/paths.ts';
import type {
  Language, Outcome, SourceFormat, StreamEvent, TranslateRequest, TranslationOptions,
} from '../api-types.ts';
import { openHistoryStore, type HistoryStore } from './history-store.ts';
import { createPairStreamParser } from './pair-stream-parser.ts';
import { DEFAULT_SOURCE_FORMAT, isSourceFormat, PROMPT_PATHS, SOURCE_FORMAT_OPTIONS, systemPromptOf } from './translate-prompt.ts';

// What a translate process is started with; all three are fixed for its lifetime.
interface TranslateSettings {
  modelId: string;
  effort: Effort;
  sourceFormat: SourceFormat;
}

// Output is the ceiling, not input: the reply restates the source and adds the translation, ~1.05 output tokens per
// source char (measured en->vi), so 100k chars leaves ~20k of MAX_OUTPUT_TOKENS for thinking.
const MAX_TEXT_CHARS = 100_000;
// Measured on Claude's tokenizer from a 19.5k-char en->vi run: English ~4 chars per token, Vietnamese ~1.3.
const CHARS_PER_TOKEN: Record<Language, number> = { en: 4, vi: 1.3 };
// Arbitrary: reading a long input delays the first token; 1s per 10k input tokens keeps a 77k-token input from
// being mistaken for a silent model.
const FIRST_TOKEN_MS_PER_INPUT_TOKEN = 0.1;
const LANGUAGE_NAMES: Record<Language, string> = { en: 'English', vi: 'Vietnamese' };
const RUN_STATUS_OF_OUTCOME = { done: 'succeeded', error: 'failed', cancelled: 'cancelled' } as const;

const HISTORY_ENTRY_PATH = /^\/history\/(\d+)$/;
// The page, at /. Its modules and stylesheet are served by the entry file, at their path under src/.
const PAGE_PATH = join(FEATURES_DIRECTORY, 'translate', 'web', 'translate.html');

let translateRequestCount = 0;

function spawnTranslateProcess({ modelId, effort, sourceFormat }: TranslateSettings): ClaudeProcess {
  return spawnClaudeProcess({ modelId, effort, systemPrompt: systemPromptOf(sourceFormat) });
}

// A fact the request never reached (null, or no tokens) is left out. 10, 6 and 6 fit 'Sonnet 5.5', 'medium' and
// '144.5s', so model, effort and duration line up across closing lines.
function formatRequestSummary({
  outcome, modelLabel, effort, durationMs, failureText, firstTextMs, thinkingDurationMs, blockCount,
  outsideCharCount, outputTokens, historyId,
}: {
  outcome: Outcome; modelLabel: string; effort: Effort; durationMs: number; failureText: string; firstTextMs: number | null;
  thinkingDurationMs: number | null; blockCount: number; outsideCharCount: number; outputTokens: number | null;
  historyId: number | null;
}): string {
  const fields = [modelLabel.padEnd(10), effort.padEnd(6), formatSeconds(durationMs).padStart(6)];
  if (failureText !== '') fields.push(failureText);
  if (firstTextMs !== null) fields.push(`first text ${formatSeconds(firstTextMs)}`);
  if (thinkingDurationMs !== null) fields.push(`thought ${formatSeconds(thinkingDurationMs)}`);
  if (blockCount > 0 || outcome === 'done') fields.push(`${formatCount(blockCount)} ${blockCount === 1 ? 'block' : 'blocks'}`);
  if (outsideCharCount > 0) fields.push(`${formatCount(outsideCharCount)} chars outside blocks`);
  if (outputTokens !== null && outputTokens > 0) fields.push(`${formatCount(outputTokens)} tokens`);
  if (historyId !== null) fields.push(`history ${historyId}`);
  return fields.join('  ');
}

function sendEvent(res: ServerResponse, ...[eventName, data]: StreamEvent): void {
  if (res.destroyed || res.writableEnded) return;
  res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
}

// One started-up process always waits for the next request, hiding ~1.5s of startup (measured: first text 2.2s
// cold vs 1.0s warm). Each process translates once, so no context carries over.
let spareProcess: ClaudeProcess | null = null;
// The settings spareProcess was started with: the last request's. Written only by spawnSpareProcess.
let spareSettings: TranslateSettings = { modelId: DEFAULT_MODEL_ID, effort: DEFAULT_EFFORT, sourceFormat: DEFAULT_SOURCE_FORMAT };
// Set when a waiting spare dies, cleared by any result: a CLI that cannot start warns once, not once per request.
let isSpareFailing = false;

function spawnSpareProcess(settings: TranslateSettings): void {
  const claudeProcess = spawnTranslateProcess(settings);
  let startErrorMessage: string | null = null;
  let stderrText = '';
  claudeProcess.stderr.on('data', (chunk) => { stderrText += chunk; });
  claudeProcess.on('error', (error) => { startErrorMessage = error.message; });
  // 'close', not 'exit': it also follows a spawn error, and it fires only after stderr has been read.
  claudeProcess.on('close', (exitCode, signal) => {
    if (spareProcess !== claudeProcess) return;
    spareProcess = null;
    if (isSpareFailing) return;
    isSpareFailing = true;
    const exitText = startErrorMessage ?? (signal ? `killed by ${signal}` : `exit code ${exitCode}`);
    log('warn', null, 'spare', `failed before use: ${exitText}`, lastLines(stderrText, LOG_DETAIL_MAX_LINES));
  });
  spareProcess = claudeProcess;
  spareSettings = settings;
}

// The model, effort and source format (its system prompt) are fixed at spawn, so a spare started for other settings is replaced,
// not used: only the first translation after a change starts cold.
function takeClaudeProcess(settings: TranslateSettings): { claudeProcess: ClaudeProcess; isColdStart: boolean } {
  const isSpareUsable = spareProcess !== null && spareProcess.exitCode === null && spareProcess.signalCode === null &&
    spareSettings.modelId === settings.modelId && spareSettings.effort === settings.effort && spareSettings.sourceFormat === settings.sourceFormat;
  const claudeProcess = isSpareUsable && spareProcess !== null ? spareProcess : spawnTranslateProcess(settings);
  if (!isSpareUsable) spareProcess?.kill();
  spawnSpareProcess(settings);
  return { claudeProcess, isColdStart: !isSpareUsable };
}

// The spare's prompt was read at its spawn, so without this a prompt edit lands one translation late.
function watchPromptFiles(): void {
  for (const promptPath of PROMPT_PATHS) {
    watchFile(promptPath, { interval: 1000 }, () => {
      spareProcess?.kill();
      spawnSpareProcess(spareSettings);
      log('info', null, 'prompt', `${basename(promptPath)} changed; spare restarted`);
    });
  }
}

function rejectBadRequest(res: ServerResponse, reason: string): void {
  log('warn', null, 'http', `400 POST /translate: ${reason}`);
  res.writeHead(400).end(reason);
}

// Why the body is not a translate request, or null when it is one.
function translateRequestProblem(body: Partial<TranslateRequest>): string | null {
  const isValidDirection =
    (body.sourceLanguage === 'en' && body.targetLanguage === 'vi') ||
    (body.sourceLanguage === 'vi' && body.targetLanguage === 'en');
  if (!isValidDirection) return 'Direction must be en->vi or vi->en';
  if (typeof body.sourceText !== 'string' || body.sourceText.trim() === '' || body.sourceText.length > MAX_TEXT_CHARS) {
    return `sourceText must be a non-empty string of at most ${MAX_TEXT_CHARS} chars`;
  }
  // Checked here because the CLI does not: an unknown --effort only prints a warning and runs at its default.
  if (modelOptionOf(body.modelId) === undefined) {
    return `modelId must be one of ${MODEL_OPTIONS.map((option) => option.modelId).join(', ')}`;
  }
  if (!isEffort(body.effort)) return `effort must be one of ${EFFORT_OPTIONS.map((option) => option.effort).join(', ')}`;
  if (!isSourceFormat(body.sourceFormat)) {
    return `sourceFormat must be one of ${SOURCE_FORMAT_OPTIONS.map((option) => option.sourceFormat).join(', ')}`;
  }
  return null;
}

// The closing log line is a warning when the model ignored the block format, an error when the run failed.
function closingLogLevel(outcome: Outcome, blockCount: number, outsideCharCount: number): LogLevel {
  if (outcome === 'error') return 'error';
  const isBlockFormatBroken = outcome === 'done' && (blockCount === 0 || outsideCharCount > 0);
  if (isBlockFormatBroken) return 'warn';
  return 'info';
}

async function handleTranslate(req: IncomingMessage, res: ServerResponse, historyStore: HistoryStore): Promise<void> {
  let body: Partial<TranslateRequest>;
  try {
    body = (await readJsonBody(req)) as Partial<TranslateRequest>;
  } catch {
    rejectBadRequest(res, 'Body must be JSON');
    return;
  }
  const problem = translateRequestProblem(body);
  if (problem !== null) {
    rejectBadRequest(res, problem);
    return;
  }
  const { sourceLanguage, targetLanguage, sourceText: text, modelId: requestedModelId, effort, sourceFormat } = body as TranslateRequest;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const requestNumber = ++translateRequestCount;
  const startedAt = Date.now();
  const directionLine = `Translate from ${LANGUAGE_NAMES[sourceLanguage]} into ${LANGUAGE_NAMES[targetLanguage]}.`;
  const firstTokenAllowanceMs = Math.round((text.length / CHARS_PER_TOKEN[sourceLanguage]) * FIRST_TOKEN_MS_PER_INPUT_TOKEN);
  // null until runClaude returns; its servedModelId is the requested model, or its fallback.
  let run: Run | null = null;
  const currentServedModelId = (): string => run?.servedModelId() ?? requestedModelId;
  // What the model has produced so far, in the shape history stores; written only by sendOutputEvents.
  // thinkingDurationMs stays null unless a thinking block closed.
  const translationOutput: { blocks: TranslatedBlock[]; textOutsideBlocks: string; thinkingText: string; thinkingDurationMs: number | null } =
    { blocks: [], textOutsideBlocks: '', thinkingText: '', thinkingDurationMs: null };
  // null while running; the outcome once the request ended. Written only by finishTranslation.
  let finishedOutcome: Outcome | null = null;
  // The run is saved as it starts (the spec's run rules), so a failure or a cancel is kept too. null when the save
  // failed; the page then has no entry to mark as open.
  let historyId: number | null = null;
  try {
    historyId = historyStore.startTranslation({
      sourceLanguage,
      targetLanguage,
      sourceFormat,
      sourceText: text,
      requestedModelId,
      effort,
      startedAt: new Date(startedAt).toISOString(),
    });
  } catch (saveError) {
    log('error', requestNumber, 'history', `save failed: ${(saveError as Error).message}`);
  }
  // null until the run gets that far.
  let firstTextMs: number | null = null;
  let outputTokens: number | null = null;
  const pairParser = createPairStreamParser();
  const sendOutputEvents = (outputEvents: StreamEvent[]): void => {
    for (const outputEvent of outputEvents) {
      const [eventName, data] = outputEvent;
      if (eventName === 'block_start') {
        const { blockType, level, marker } = data;
        translationOutput.blocks[data.blockIndex] = { blockType, level, marker, sourceText: '', translatedText: '' };
      } else if (eventName === 'source_delta') {
        translationOutput.blocks[data.blockIndex].sourceText += data.text;
      } else if (eventName === 'translation_delta') {
        translationOutput.blocks[data.blockIndex].translatedText += data.text;
      } else if (eventName === 'outside_text_delta') {
        translationOutput.textOutsideBlocks += data.text;
      } else if (eventName === 'thinking_delta') {
        translationOutput.thinkingText += data.text;
      } else if (eventName === 'thinking_done') {
        translationOutput.thinkingDurationMs = data.durationMs;
      }
      sendEvent(res, ...outputEvent);
    }
  };

  // The one place a translate request ends: saves how it ended with what the model produced, logs the closing line,
  // then sends the closing event. When outcome is 'error', error = { errorCode, message } goes to the page and the
  // saved run, and failureText (one line) and failureDetailLines (e.g. a stderr tail) go to the log only.
  function finishTranslation(
    outcome: Outcome, error: { errorCode: CliErrorCode; message: string } | null = null, failureText = '', failureDetailLines: string[] = [],
  ): void {
    if (finishedOutcome !== null) return;
    finishedOutcome = outcome;
    const servedModelId = currentServedModelId();
    const durationMs = Date.now() - startedAt;
    const blockCount = translationOutput.blocks.length;
    const outsideCharCount = translationOutput.textOutsideBlocks.length;
    let textOutsideBlocks = translationOutput.textOutsideBlocks;
    if (textOutsideBlocks.trim() === '') textOutsideBlocks = '';
    if (historyId !== null) {
      try {
        historyStore.finishTranslation(historyId, {
          status: RUN_STATUS_OF_OUTCOME[outcome],
          blocks: translationOutput.blocks,
          textOutsideBlocks,
          servedModelId,
          thinkingText: translationOutput.thinkingText,
          thinkingMs: translationOutput.thinkingDurationMs,
          errorCode: error?.errorCode ?? null,
          errorMessage: error?.message ?? null,
        });
      } catch (saveError) {
        log('error', requestNumber, 'history', `save failed: ${(saveError as Error).message}`);
      }
    }
    const summary = formatRequestSummary({
      outcome,
      modelLabel: modelLabelOf(servedModelId),
      effort,
      durationMs,
      failureText: error === null ? '' : `${error.errorCode}: ${failureText}`,
      firstTextMs,
      thinkingDurationMs: translationOutput.thinkingDurationMs,
      blockCount,
      outsideCharCount,
      outputTokens,
      historyId,
    });
    const logLevel = closingLogLevel(outcome, blockCount, outsideCharCount);
    log(logLevel, requestNumber, outcome, summary, failureDetailLines);
    if (outcome === 'cancelled') return;
    const isFallback = servedModelId !== requestedModelId;
    if (outcome === 'done') sendEvent(res, 'done', { durationMs, servedModelId, effort, isFallback, translationId: historyId });
    else if (error !== null) sendEvent(res, 'error', { ...error, servedModelId, effort, isFallback, translationId: historyId });
    res.end();
  }

  const { claudeProcess, isColdStart } = takeClaudeProcess({ modelId: requestedModelId, effort, sourceFormat });
  const coldStartNote = isColdStart ? '  cold start' : '';
  const requestLine = `${formatCount(text.length)} chars  ${modelLabelOf(requestedModelId)} ${effort}  ${sourceFormat}`;
  log('info', requestNumber, 'start', `${sourceLanguage}->${targetLanguage}  ${requestLine}${coldStartNote}`);
  run = runClaude({
    requestNumber,
    settings: { modelId: requestedModelId, effort, systemPrompt: systemPromptOf(sourceFormat) },
    userMessage: `${directionLine}\n\n<input_text>\n${text}\n</input_text>`,
    firstTokenAllowanceMs,
    claudeProcess,
    handlers: {
      onThinkingDelta: (thinkingText) => sendOutputEvents([['thinking_delta', { text: thinkingText }]]),
      onThinkingDone: (durationMs) => sendOutputEvents([['thinking_done', { durationMs }]]),
      onText: (replyText) => {
        if (firstTextMs === null) firstTextMs = Date.now() - startedAt;
        sendOutputEvents(pairParser.push(replyText));
      },
      onRetry: (retry) => sendEvent(res, 'retry', retry),
      onFallback: (fallback) => sendEvent(res, 'fallback', fallback),
      onResultMessage: (resultOutputTokens) => {
        isSpareFailing = false;
        sendOutputEvents(pairParser.finish());
        outputTokens = resultOutputTokens;
      },
      onDone: () => finishTranslation('done'),
      onError: (error, failureText, failureDetailLines) => finishTranslation('error', error, failureText, failureDetailLines),
    },
  });

  // Watch res, not req: req emits 'close' as soon as the body has been read.
  res.on('close', () => {
    finishTranslation('cancelled');
    run?.stop();
  });
}

// What the page offers in its settings menus. quotaWarning: the latest reply's rate limit when it is a warning or a
// rejection, else null (also before the first reply since the server started).
function translationOptionsResponse(): TranslationOptions {
  const { status, rateLimitType, utilization, resetsAt } = lastRateLimitInfo() ?? {};
  const isQuotaWarning = status === 'allowed_warning' || status === 'rejected';
  let quotaWarning: TranslationOptions['quotaWarning'] = null;
  if (isQuotaWarning) quotaWarning = { status, rateLimitType, utilization, resetsAt };
  return {
    models: MODEL_OPTIONS.map(({ modelId, label, shortLabel, description }) => ({ modelId, label, shortLabel, description })),
    efforts: EFFORT_OPTIONS,
    sourceFormats: SOURCE_FORMAT_OPTIONS.map(({ sourceFormat, label, description }) => ({ sourceFormat, label, description })),
    defaultModelId: DEFAULT_MODEL_ID,
    defaultEffort: DEFAULT_EFFORT,
    defaultSourceFormat: DEFAULT_SOURCE_FORMAT,
    quotaWarning,
  };
}

export function createTranslateFeature({ databasePath }: { databasePath: string }): Feature {
  // Throws on a migration problem, so a damaged or newer database stops the server at startup, not mid-request.
  const historyStore = openHistoryStore(databasePath);
  const interruptedCount = historyStore.failInterruptedTranslations();
  if (interruptedCount > 0) log('warn', null, 'history', `${interruptedCount} translation(s) were interrupted by a restart`);
  watchPromptFiles();

  async function handle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
    const historyEntryMatch = HISTORY_ENTRY_PATH.exec(pathname);
    if (req.method === 'GET' && pathname === '/') {
      await sendFile(res, PAGE_PATH, 'text/html; charset=utf-8');
    } else if (req.method === 'GET' && pathname === '/translation-options') {
      sendJson(res, 200, translationOptionsResponse());
    } else if (req.method === 'POST' && pathname === '/translate') {
      await handleTranslate(req, res, historyStore);
    } else if (req.method === 'GET' && pathname === '/history') {
      sendJson(res, 200, historyStore.listTranslations());
    } else if (req.method === 'GET' && historyEntryMatch) {
      const translation = historyStore.readTranslation(Number(historyEntryMatch[1]));
      if (translation) sendJson(res, 200, translation);
      else res.writeHead(404).end('No such history entry');
    } else if (req.method === 'DELETE' && historyEntryMatch) {
      const isDeleted = historyStore.deleteTranslation(Number(historyEntryMatch[1]));
      res.writeHead(isDeleted ? 204 : 404).end();
    } else {
      return false;
    }
    return true;
  }

  // Once the server listens, a spare process starts for the default settings.
  function start(): void {
    spawnSpareProcess(spareSettings);
  }

  return { name: 'translate', handle, start };
}

