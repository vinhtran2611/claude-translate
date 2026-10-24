// Translate's routes: the page at /, the settings menus, POST /translate (starts a run as a job, translation-jobs.ts,
// and streams it back as Server-Sent Events), a run's events and cancel, and the history.
import { watchFile } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, join } from 'node:path';
import {
  DEFAULT_EFFORT, DEFAULT_MODEL_ID, EFFORT_OPTIONS, isEffort, lastRateLimitInfo, MODEL_OPTIONS, modelOptionOf, spawnClaudeProcess,
  type ClaudeProcess,
} from '../../../shared/server/claude-runner.ts';
import { readJsonBody, sendFile, sendJson, type Feature } from '../../../shared/server/http.ts';
import { lastLines, log, LOG_DETAIL_MAX_LINES } from '../../../shared/server/log.ts';
import { FEATURES_DIRECTORY } from '../../../shared/server/paths.ts';
import type { TranslateRequest, TranslationOptions } from '../api-types.ts';
import { openHistoryStore } from './history-store.ts';
import { DEFAULT_SOURCE_FORMAT, isSourceFormat, PROMPT_PATHS, SOURCE_FORMAT_OPTIONS, systemPromptOf } from './translate-prompt.ts';
import {
  createTranslationJobs, formatInterruptedLine, formatRunningCount, MAX_RUNNING_TRANSLATIONS, type TranslateSettings, type TranslationJobs,
} from './translation-jobs.ts';

// Output is the ceiling, not input: the reply restates the source and adds the translation, ~1.05 output tokens per
// source char (measured en->vi), so 100k chars leaves ~20k of MAX_OUTPUT_TOKENS for thinking.
const MAX_TEXT_CHARS = 100_000;

const HISTORY_ENTRY_PATH = /^\/history\/(\d+)$/;
const HISTORY_EVENTS_PATH = /^\/history\/(\d+)\/events$/;
const HISTORY_CANCEL_PATH = /^\/history\/(\d+)\/cancel$/;
const HISTORY_READ_PATH = /^\/history\/(\d+)\/read$/;
// The page, at /. Its modules and stylesheet are served by the entry file, at their path under src/.
const PAGE_PATH = join(FEATURES_DIRECTORY, 'translate', 'web', 'translate.html');
const TOO_MANY_RUNNING_TEXT = `${MAX_RUNNING_TRANSLATIONS} translations are already running. Wait for one to finish, or cancel one.`;

function spawnTranslateProcess({ modelId, effort, sourceFormat }: TranslateSettings): ClaudeProcess {
  return spawnClaudeProcess({ modelId, effort, systemPrompt: systemPromptOf(sourceFormat) });
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

// Any result shows the CLI starts, so the next spare that dies warns again.
function noteClaudeResult(): void {
  isSpareFailing = false;
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

// Checks the body and the limit before any header is written, then starts the job and watches it on the same response,
// so a new run and a re-attached one stream the same way: snapshot (naming the new row), events, closing event.
async function handleTranslate(req: IncomingMessage, res: ServerResponse, jobs: TranslationJobs): Promise<void> {
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
  if (jobs.isFull()) {
    const liveIds = jobs.liveIds();
    log('warn', null, 'http', `429 POST /translate: ${formatRunningCount(liveIds.length)} (history ${liveIds.join(', ')})`);
    res.writeHead(429).end(TOO_MANY_RUNNING_TEXT);
    return;
  }
  // A row that cannot be saved throws before anything starts; the entry file answers 500 and logs it.
  const translationId = jobs.start(body as TranslateRequest);
  jobs.watch(res, translationId, false);
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
  const interrupted = historyStore.failInterruptedTranslations();
  if (interrupted.length > 0) log('warn', null, 'history', formatInterruptedLine(interrupted));
  watchPromptFiles();
  const jobs = createTranslationJobs({ historyStore, takeClaudeProcess, noteClaudeResult });

  async function handle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
    const historyEntryMatch = HISTORY_ENTRY_PATH.exec(pathname);
    const historyEventsMatch = HISTORY_EVENTS_PATH.exec(pathname);
    const historyCancelMatch = HISTORY_CANCEL_PATH.exec(pathname);
    const historyReadMatch = HISTORY_READ_PATH.exec(pathname);
    if (req.method === 'GET' && pathname === '/') {
      await sendFile(res, PAGE_PATH, 'text/html; charset=utf-8');
    } else if (req.method === 'GET' && pathname === '/translation-options') {
      sendJson(res, 200, translationOptionsResponse());
    } else if (req.method === 'POST' && pathname === '/translate') {
      await handleTranslate(req, res, jobs);
    } else if (req.method === 'GET' && pathname === '/history') {
      sendJson(res, 200, historyStore.listTranslations());
    } else if (req.method === 'GET' && historyEntryMatch) {
      const translation = historyStore.readTranslation(Number(historyEntryMatch[1]));
      if (translation) sendJson(res, 200, translation);
      else res.writeHead(404).end('No such history entry');
    } else if (req.method === 'GET' && historyEventsMatch) {
      // An unknown id is not live either: it gets `finished`, and GET /history/:id then answers 404.
      jobs.watch(res, Number(historyEventsMatch[1]), true);
    } else if (req.method === 'POST' && historyCancelMatch) {
      const translationId = Number(historyCancelMatch[1]);
      const isCancelled = jobs.cancel(translationId, 'cancel');
      if (isCancelled) {
        res.writeHead(204).end();
      } else {
        // Logged because a Cancel the page sent did nothing, which the user may report.
        log('warn', null, 'http', `409 POST /history/${translationId}/cancel: not running`);
        res.writeHead(409).end('not_running');
      }
    } else if (req.method === 'POST' && historyReadMatch) {
      // A POST, not part of GET /history/:id: reading an entry from a script or an agent must not clear the mark.
      const isMarked = historyStore.markRead(Number(historyReadMatch[1]));
      res.writeHead(isMarked ? 204 : 404).end();
    } else if (req.method === 'DELETE' && historyEntryMatch) {
      const translationId = Number(historyEntryMatch[1]);
      // A live run is stopped first, so no job is left writing to a row that is gone.
      jobs.cancel(translationId, 'delete');
      const isDeleted = historyStore.deleteTranslation(translationId);
      if (isDeleted) log('info', null, 'history', `${translationId} deleted`);
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

