import { mkdirSync, readdirSync, watchFile } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { basename, dirname, join } from 'node:path';
import type {
  Effort, ErrorKind, HistoryEntry, Language, Mode, Outcome, Pair, StreamEvent, TranslateRequest, TranslationOptions,
} from '../shared/api.ts';
import {
  DEFAULT_EFFORT, DEFAULT_MODEL_ID, EFFORT_OPTIONS, isEffort, lastRateLimitInfo, MODEL_OPTIONS, modelLabelOf, modelOptionOf, runClaude, spawnClaudeProcess,
  type ClaudeProcess, type Run,
} from '../shared/server/claude-runner.ts';
import { readJsonBody, sendError, sendFile, sendJson, sendModule, type Feature } from '../shared/server/http.ts';
import { configureLogFile, formatCount, formatSeconds, lastLines, log, LOG_DETAIL_MAX_LINES, type LogLevel } from '../shared/server/log.ts';
import { APP_DIRECTORY, DATA_DIRECTORY, SHARED_DIRECTORY } from '../shared/server/paths.ts';
import { backupDaily } from '../shared/server/sqlite.ts';
import { createPracticeFeature } from '../features/practice/server/routes.ts';
import { openHistoryStore, type HistoryStore } from './history-store.ts';
import { createPairStreamParser } from './pair-stream-parser.ts';
import { DEFAULT_MODE, isMode, MODE_OPTIONS, PROMPT_PATHS, systemPromptOf } from './translate-prompt.ts';

const WEB_DIRECTORY = join(APP_DIRECTORY, 'web');
const SHARED_WEB_DIRECTORY = join(SHARED_DIRECTORY, 'web');
const INDEX_HTML_PATH = join(WEB_DIRECTORY, 'index.html');
const FAVICON_PATH = join(WEB_DIRECTORY, 'favicon.svg');
const HISTORY_DATABASE_PATH = process.env.HISTORY_DATABASE_PATH ?? join(DATA_DIRECTORY, 'history.sqlite');
const PRACTICE_DATABASE_PATH = process.env.PRACTICE_DATABASE_PATH ?? join(DATA_DIRECTORY, 'practice-v2.sqlite');
// Next to the database by default, so a test server on a scratch database never writes into the real log.
const SERVER_LOG_PATH = process.env.SERVER_LOG_PATH ?? join(dirname(HISTORY_DATABASE_PATH), 'server.log');
const BACKUPS_DIRECTORY = join(dirname(HISTORY_DATABASE_PATH), 'backups');
// Each database gets one copy a day; the check runs at start and then hourly, so a server left running past
// midnight still makes the next day's copy.
const DAILY_BACKUPS = [{ path: HISTORY_DATABASE_PATH, name: 'history' }, { path: PRACTICE_DATABASE_PATH, name: 'practice-v2' }];
const BACKUP_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const PORT = Number(process.env.PORT ?? 8787);

// What a translate process is started with; all three are fixed for its lifetime.
interface TranslateSettings {
  model_id: string;
  effort: Effort;
  mode: Mode;
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

let translate_request_count = 0;

// Every .ts file under directory, by the URL it is served at: url_prefix, then its path inside directory.
function modulePathsUnder(directory: string, url_prefix: string): Map<string, string> {
  const module_paths = new Map<string, string>();
  for (const name of readdirSync(directory, { recursive: true, encoding: 'utf8' })) {
    if (name.endsWith('.ts')) module_paths.set(`${url_prefix}${name}`, join(directory, name));
  }
  return module_paths;
}

function spawnTranslateProcess({ model_id, effort, mode }: TranslateSettings): ClaudeProcess {
  return spawnClaudeProcess({ model_id, effort, system_prompt: systemPromptOf(mode) });
}

// A fact the request never reached (null, or no tokens) is left out. 10, 6 and 6 fit 'Sonnet 5.5', 'medium' and
// '144.5s', so model, effort and duration line up across closing lines.
function formatRequestSummary({
  outcome, model_label, effort, duration_ms, failure_text, first_text_ms, thinking_duration_ms, pair_count,
  unpaired_char_count, output_tokens, history_id,
}: {
  outcome: Outcome; model_label: string; effort: Effort; duration_ms: number; failure_text: string; first_text_ms: number | null;
  thinking_duration_ms: number | null; pair_count: number; unpaired_char_count: number; output_tokens: number | null;
  history_id: number | null;
}): string {
  const fields = [model_label.padEnd(10), effort.padEnd(6), formatSeconds(duration_ms).padStart(6)];
  if (failure_text !== '') fields.push(failure_text);
  if (first_text_ms !== null) fields.push(`first text ${formatSeconds(first_text_ms)}`);
  if (thinking_duration_ms !== null) fields.push(`thought ${formatSeconds(thinking_duration_ms)}`);
  if (pair_count > 0 || outcome === 'done') fields.push(`${formatCount(pair_count)} ${pair_count === 1 ? 'pair' : 'pairs'}`);
  if (unpaired_char_count > 0) fields.push(`${formatCount(unpaired_char_count)} unpaired chars`);
  if (output_tokens !== null && output_tokens > 0) fields.push(`${formatCount(output_tokens)} tokens`);
  if (history_id !== null) fields.push(`history ${history_id}`);
  return fields.join('  ');
}

function sendEvent(res: ServerResponse, ...[event_name, data]: StreamEvent): void {
  if (res.destroyed || res.writableEnded) return;
  res.write(`event: ${event_name}\ndata: ${JSON.stringify(data)}\n\n`);
}

// One started-up process always waits for the next request, hiding ~1.5s of startup (measured: first text 2.2s
// cold vs 1.0s warm). Each process translates once, so no context carries over.
let spare_process: ClaudeProcess | null = null;
// The settings spare_process was started with: the last request's. Written only by spawnSpareProcess.
let spare_settings: TranslateSettings = { model_id: DEFAULT_MODEL_ID, effort: DEFAULT_EFFORT, mode: DEFAULT_MODE };
// Set when a waiting spare dies, cleared by any result: a CLI that cannot start warns once, not once per request.
let is_spare_failing = false;

function spawnSpareProcess(settings: TranslateSettings): void {
  const claude_process = spawnTranslateProcess(settings);
  let start_error_message: string | null = null;
  let stderr_text = '';
  claude_process.stderr.on('data', (chunk) => { stderr_text += chunk; });
  claude_process.on('error', (error) => { start_error_message = error.message; });
  // 'close', not 'exit': it also follows a spawn error, and it fires only after stderr has been read.
  claude_process.on('close', (exit_code, signal) => {
    if (spare_process !== claude_process) return;
    spare_process = null;
    if (is_spare_failing) return;
    is_spare_failing = true;
    const exit_text = start_error_message ?? (signal ? `killed by ${signal}` : `exit code ${exit_code}`);
    log('warn', null, 'spare', `failed before use: ${exit_text}`, lastLines(stderr_text, LOG_DETAIL_MAX_LINES));
  });
  spare_process = claude_process;
  spare_settings = settings;
}

// The model, effort and mode (its system prompt) are fixed at spawn, so a spare started for other settings is replaced,
// not used: only the first translation after a change starts cold.
function takeClaudeProcess(settings: TranslateSettings): { claude_process: ClaudeProcess; is_cold_start: boolean } {
  const is_spare_usable = spare_process !== null && spare_process.exitCode === null && spare_process.signalCode === null &&
    spare_settings.model_id === settings.model_id && spare_settings.effort === settings.effort && spare_settings.mode === settings.mode;
  const claude_process = is_spare_usable && spare_process !== null ? spare_process : spawnTranslateProcess(settings);
  if (!is_spare_usable) spare_process?.kill();
  spawnSpareProcess(settings);
  return { claude_process, is_cold_start: !is_spare_usable };
}

// The spare's prompt was read at its spawn, so without this a prompt edit lands one translation late.
for (const prompt_path of PROMPT_PATHS) {
  watchFile(prompt_path, { interval: 1000 }, () => {
    spare_process?.kill();
    spawnSpareProcess(spare_settings);
    log('info', null, 'prompt', `${basename(prompt_path)} changed; spare restarted`);
  });
}

function rejectBadRequest(res: ServerResponse, reason: string): void {
  log('warn', null, 'http', `400 POST /translate: ${reason}`);
  res.writeHead(400).end(reason);
}

// Why the body is not a translate request, or null when it is one.
function translateRequestProblem(body: Partial<TranslateRequest>): string | null {
  const is_valid_direction =
    (body.source_language === 'en' && body.target_language === 'vi') ||
    (body.source_language === 'vi' && body.target_language === 'en');
  if (!is_valid_direction) return 'Direction must be en->vi or vi->en';
  if (typeof body.text !== 'string' || body.text.trim() === '' || body.text.length > MAX_TEXT_CHARS) {
    return `text must be a non-empty string of at most ${MAX_TEXT_CHARS} chars`;
  }
  // Checked here because the CLI does not: an unknown --effort only prints a warning and runs at its default.
  if (modelOptionOf(body.model_id) === undefined) {
    return `model_id must be one of ${MODEL_OPTIONS.map((option) => option.model_id).join(', ')}`;
  }
  if (!isEffort(body.effort)) return `effort must be one of ${EFFORT_OPTIONS.map((option) => option.effort).join(', ')}`;
  if (!isMode(body.mode)) return `mode must be one of ${MODE_OPTIONS.map((option) => option.mode).join(', ')}`;
  return null;
}

// The closing log line is a warning when the model ignored the pair format, an error when the run failed.
function closingLogLevel(outcome: Outcome, pair_count: number, unpaired_char_count: number): LogLevel {
  if (outcome === 'error') return 'error';
  const is_pair_format_broken = outcome === 'done' && (pair_count === 0 || unpaired_char_count > 0);
  if (is_pair_format_broken) return 'warn';
  return 'info';
}

async function handleTranslate(req: IncomingMessage, res: ServerResponse, history_store: HistoryStore): Promise<void> {
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
  const { source_language, target_language, text, model_id: requested_model_id, effort, mode } = body as TranslateRequest;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const request_number = ++translate_request_count;
  const started_at = Date.now();
  const direction_line = `Translate from ${LANGUAGE_NAMES[source_language]} into ${LANGUAGE_NAMES[target_language]}.`;
  const first_token_allowance_ms = Math.round((text.length / CHARS_PER_TOKEN[source_language]) * FIRST_TOKEN_MS_PER_INPUT_TOKEN);
  // null until runClaude returns; its served_model_id is the requested model, or its fallback.
  let run: Run | null = null;
  const servedModelId = (): string => run?.served_model_id() ?? requested_model_id;
  // What the model has produced so far, in the shape history stores; written only by sendOutputEvents.
  // thinking_duration_ms stays null unless a thinking block closed.
  const translation_output: { pairs: Pair[]; unpaired_text: string; thinking_text: string; thinking_duration_ms: number | null } =
    { pairs: [], unpaired_text: '', thinking_text: '', thinking_duration_ms: null };
  // null while running; the outcome once the request ended. Written only by finishTranslation.
  let finished_outcome: Outcome | null = null;
  // null until the run gets that far.
  let first_text_ms: number | null = null;
  let output_tokens: number | null = null;
  const pair_parser = createPairStreamParser();
  const sendOutputEvents = (output_events: StreamEvent[]): void => {
    for (const output_event of output_events) {
      const [event_name, data] = output_event;
      if (event_name === 'pair_start') {
        const { pair_type, level, marker } = data;
        translation_output.pairs[data.pair_index] = { pair_type, level, marker, source_text: '', translation_text: '' };
      } else if (event_name === 'source_delta') {
        translation_output.pairs[data.pair_index].source_text += data.text;
      } else if (event_name === 'translation_delta') {
        translation_output.pairs[data.pair_index].translation_text += data.text;
      } else if (event_name === 'unpaired_delta') {
        translation_output.unpaired_text += data.text;
      } else if (event_name === 'thinking_delta') {
        translation_output.thinking_text += data.text;
      } else if (event_name === 'thinking_done') {
        translation_output.thinking_duration_ms = data.duration_ms;
      }
      sendEvent(res, ...output_event);
    }
  };

  // The one place a translate request ends: saves it to history when the model produced anything, logs the closing
  // line, then sends the closing event. When outcome is 'error', error = { error_kind, message } goes to the page and
  // failure_text (one line) and failure_detail_lines (e.g. a stderr tail) go to the log only.
  function finishTranslation(
    outcome: Outcome, error: { error_kind: ErrorKind; message: string } | null = null, failure_text = '', failure_detail_lines: string[] = [],
  ): void {
    if (finished_outcome !== null) return;
    finished_outcome = outcome;
    const served_model_id = servedModelId();
    const duration_ms = Date.now() - started_at;
    const pair_count = translation_output.pairs.length;
    const unpaired_char_count = translation_output.unpaired_text.length;
    const has_output = pair_count > 0 || translation_output.unpaired_text.trim() !== '';
    // null when nothing was saved (no output, or the save failed); the page then has no entry to mark as open.
    let history_id: number | null = null;
    if (has_output) {
      try {
        history_id = history_store.saveEntry({
          created_at: new Date(started_at).toISOString(), source_language, target_language, input_text: text,
          pairs: translation_output.pairs, unpaired_text: translation_output.unpaired_text,
          thinking_text: translation_output.thinking_text, thinking_duration_ms: translation_output.thinking_duration_ms,
          outcome, served_model_id, requested_model_id, effort, mode, duration_ms,
        });
      } catch (save_error) {
        log('error', request_number, 'history', `save failed: ${(save_error as Error).message}`);
      }
    }
    const summary = formatRequestSummary({
      outcome,
      model_label: modelLabelOf(served_model_id),
      effort,
      duration_ms,
      failure_text: error === null ? '' : `${error.error_kind}: ${failure_text}`,
      first_text_ms,
      thinking_duration_ms: translation_output.thinking_duration_ms,
      pair_count,
      unpaired_char_count,
      output_tokens,
      history_id,
    });
    const log_level = closingLogLevel(outcome, pair_count, unpaired_char_count);
    log(log_level, request_number, outcome, summary, failure_detail_lines);
    if (outcome === 'cancelled') return;
    const is_fallback = served_model_id !== requested_model_id;
    if (outcome === 'done') sendEvent(res, 'done', { duration_ms, served_model_id, effort, is_fallback, history_id });
    else if (error !== null) sendEvent(res, 'error', { ...error, served_model_id, effort, is_fallback, history_id });
    res.end();
  }

  const { claude_process, is_cold_start } = takeClaudeProcess({ model_id: requested_model_id, effort, mode });
  const cold_start_note = is_cold_start ? '  cold start' : '';
  const request_line = `${formatCount(text.length)} chars  ${modelLabelOf(requested_model_id)} ${effort}  ${mode}`;
  log('info', request_number, 'start', `${source_language}->${target_language}  ${request_line}${cold_start_note}`);
  run = runClaude({
    request_number,
    settings: { model_id: requested_model_id, effort, system_prompt: systemPromptOf(mode) },
    user_message: `${direction_line}\n\n<input_text>\n${text}\n</input_text>`,
    first_token_allowance_ms,
    claude_process,
    handlers: {
      onThinkingDelta: (thinking_text) => sendOutputEvents([['thinking_delta', { text: thinking_text }]]),
      onThinkingDone: (duration_ms) => sendOutputEvents([['thinking_done', { duration_ms }]]),
      onText: (reply_text) => {
        if (first_text_ms === null) first_text_ms = Date.now() - started_at;
        sendOutputEvents(pair_parser.push(reply_text));
      },
      onRetry: (retry) => sendEvent(res, 'retry', retry),
      onFallback: (fallback) => sendEvent(res, 'fallback', fallback),
      onResultMessage: (result_output_tokens) => {
        is_spare_failing = false;
        sendOutputEvents(pair_parser.finish());
        output_tokens = result_output_tokens;
      },
      onDone: () => finishTranslation('done'),
      onError: (error, failure_text, failure_detail_lines) => finishTranslation('error', error, failure_text, failure_detail_lines),
    },
  });

  // Watch res, not req: req emits 'close' as soon as the body has been read.
  res.on('close', () => {
    finishTranslation('cancelled');
    run?.stop();
  });
}

function runDailyBackups(): void {
  for (const { path, name } of DAILY_BACKUPS) {
    try {
      const backup_path = backupDaily(path, BACKUPS_DIRECTORY, name);
      if (backup_path !== null) log('info', null, 'backup', backup_path);
    } catch (error) {
      log('error', null, 'backup', `${name} failed: ${(error as Error).message}`);
    }
  }
}

function toHistoryResponse(entry: Omit<HistoryEntry, 'is_fallback'>): HistoryEntry {
  return { ...entry, is_fallback: entry.served_model_id !== entry.requested_model_id };
}

// What the page offers in its settings menus. quota_warning: the latest reply's rate limit when it is a warning or a
// rejection, else null (also before the first reply since the server started).
function translationOptionsResponse(): TranslationOptions {
  const { status, rateLimitType, utilization, resetsAt } = lastRateLimitInfo() ?? {};
  const is_quota_warning = status === 'allowed_warning' || status === 'rejected';
  return {
    models: MODEL_OPTIONS.map(({ model_id, label, short_label, description }) => ({ model_id, label, short_label, description })),
    efforts: EFFORT_OPTIONS,
    modes: MODE_OPTIONS.map(({ mode, label, description }) => ({ mode, label, description })),
    default_model_id: DEFAULT_MODEL_ID,
    default_effort: DEFAULT_EFFORT,
    default_mode: DEFAULT_MODE,
    quota_warning: is_quota_warning ? { status, rate_limit_type: rateLimitType, utilization, resets_at: resetsAt } : null,
  };
}

// Throws on a migration problem, so a damaged or newer database stops the server at startup, not mid-request.
mkdirSync(dirname(SERVER_LOG_PATH), { recursive: true });
configureLogFile(SERVER_LOG_PATH);
const history_store = openHistoryStore(HISTORY_DATABASE_PATH);
// Every feature but translate, which is still served from server/ and web/ (see docs/practice-proposal.md §6).
const features: Feature[] = [createPracticeFeature({ database_path: PRACTICE_DATABASE_PATH })];
// URLs mirror the folders, so a page module's relative import of shared/web/ui.ts resolves the same for tsc and the browser.
const SHARED_WEB_FILES = new Map([
  ['/shared/web/base.css', { path: join(SHARED_WEB_DIRECTORY, 'base.css'), content_type: 'text/css; charset=utf-8' }],
]);
// The page's modules, served as JavaScript with their types stripped, so the browser runs the same files tsc checks.
const WEB_MODULE_PATHS = modulePathsUnder(WEB_DIRECTORY, '/');
const SHARED_WEB_MODULE_PATHS = modulePathsUnder(SHARED_WEB_DIRECTORY, '/shared/web/');
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const HISTORY_ENTRY_PATH = /^\/history\/(\d+)$/;
// A rebinding page can retry without end; one line per Host names it without flooding the log.
const logged_forbidden_hosts = new Set<string>();

const server = createServer(async (req, res) => {
  // Loopback binding alone does not stop DNS rebinding: a page on another site whose name resolves to
  // 127.0.0.1 would otherwise read /history as same-origin. Its requests carry that site's Host header.
  const host = req.headers.host ?? '';
  if (!ALLOWED_HOSTS.has(host)) {
    if (!logged_forbidden_hosts.has(host)) {
      logged_forbidden_hosts.add(host);
      log('warn', null, 'http', `403 ${req.method} ${req.url} from Host ${JSON.stringify(host)}`);
    }
    res.writeHead(403).end('Forbidden host');
    return;
  }
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  const history_entry_match = HISTORY_ENTRY_PATH.exec(pathname);
  try {
    if (req.method === 'GET' && pathname === '/') {
      await sendFile(res, INDEX_HTML_PATH, 'text/html; charset=utf-8');
    } else if (req.method === 'GET' && WEB_MODULE_PATHS.has(pathname)) {
      await sendModule(res, WEB_MODULE_PATHS.get(pathname) as string);
    } else if (req.method === 'GET' && SHARED_WEB_MODULE_PATHS.has(pathname)) {
      await sendModule(res, SHARED_WEB_MODULE_PATHS.get(pathname) as string);
    } else if (req.method === 'GET' && SHARED_WEB_FILES.has(pathname)) {
      const { path, content_type } = SHARED_WEB_FILES.get(pathname) as { path: string; content_type: string };
      await sendFile(res, path, content_type);
    } else if (req.method === 'GET' && (pathname === '/favicon.svg' || pathname === '/favicon.ico')) {
      await sendFile(res, FAVICON_PATH, 'image/svg+xml');
    } else if (req.method === 'GET' && pathname === '/translation-options') {
      sendJson(res, 200, translationOptionsResponse());
    } else if (req.method === 'POST' && pathname === '/translate') {
      await handleTranslate(req, res, history_store);
    } else if (req.method === 'GET' && pathname === '/history') {
      sendJson(res, 200, history_store.listEntries());
    } else if (req.method === 'GET' && history_entry_match) {
      const entry = history_store.readEntry(Number(history_entry_match[1]));
      if (entry) sendJson(res, 200, toHistoryResponse(entry));
      else res.writeHead(404).end('No such history entry');
    } else if (req.method === 'DELETE' && history_entry_match) {
      const is_deleted = history_store.deleteEntry(Number(history_entry_match[1]));
      res.writeHead(is_deleted ? 204 : 404).end();
    } else {
      let is_handled = false;
      for (const feature of features) {
        is_handled = await feature.handle(req, res, pathname);
        if (is_handled) break;
      }
      // A JSON API answers in its one error shape; anything else stays a bare 404.
      if (!is_handled && pathname.startsWith('/api/')) sendError(res, 404, 'not_found', `Nothing at ${pathname}.`);
      else if (!is_handled) res.writeHead(404).end();
    }
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    const stack_frame_lines = String(failure.stack ?? '').split('\n').slice(1, 1 + LOG_DETAIL_MAX_LINES)
      .map((line) => line.replaceAll(`file://${APP_DIRECTORY}/`, ''));
    log('error', null, 'http', `500 ${req.method} ${pathname}: ${failure.message}`, stack_frame_lines);
    if (res.headersSent) res.end();
    else if (pathname.startsWith('/api/')) sendError(res, 500, 'internal', 'Internal error: the details are in the server log.');
    else res.writeHead(500).end('Internal error');
  }
});

// Bound to loopback only: anyone who can reach this port spends your Claude subscription.
server.listen(PORT, '127.0.0.1', () => {
  log('info', null, 'ready', `http://localhost:${PORT}  (Ctrl-C stops)`);
  spawnSpareProcess(spare_settings);
  runDailyBackups();
  setInterval(runDailyBackups, BACKUP_CHECK_INTERVAL_MS).unref();
});
