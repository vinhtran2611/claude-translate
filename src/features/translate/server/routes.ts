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
  model_id: string;
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

let translate_request_count = 0;

function spawnTranslateProcess({ model_id, effort, sourceFormat }: TranslateSettings): ClaudeProcess {
  return spawnClaudeProcess({ model_id, effort, system_prompt: systemPromptOf(sourceFormat) });
}

// A fact the request never reached (null, or no tokens) is left out. 10, 6 and 6 fit 'Sonnet 5.5', 'medium' and
// '144.5s', so model, effort and duration line up across closing lines.
function formatRequestSummary({
  outcome, model_label, effort, duration_ms, failure_text, first_text_ms, thinking_duration_ms, block_count,
  outside_char_count, output_tokens, history_id,
}: {
  outcome: Outcome; model_label: string; effort: Effort; duration_ms: number; failure_text: string; first_text_ms: number | null;
  thinking_duration_ms: number | null; block_count: number; outside_char_count: number; output_tokens: number | null;
  history_id: number | null;
}): string {
  const fields = [model_label.padEnd(10), effort.padEnd(6), formatSeconds(duration_ms).padStart(6)];
  if (failure_text !== '') fields.push(failure_text);
  if (first_text_ms !== null) fields.push(`first text ${formatSeconds(first_text_ms)}`);
  if (thinking_duration_ms !== null) fields.push(`thought ${formatSeconds(thinking_duration_ms)}`);
  if (block_count > 0 || outcome === 'done') fields.push(`${formatCount(block_count)} ${block_count === 1 ? 'block' : 'blocks'}`);
  if (outside_char_count > 0) fields.push(`${formatCount(outside_char_count)} chars outside blocks`);
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
let spare_settings: TranslateSettings = { model_id: DEFAULT_MODEL_ID, effort: DEFAULT_EFFORT, sourceFormat: DEFAULT_SOURCE_FORMAT };
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

// The model, effort and source format (its system prompt) are fixed at spawn, so a spare started for other settings is replaced,
// not used: only the first translation after a change starts cold.
function takeClaudeProcess(settings: TranslateSettings): { claude_process: ClaudeProcess; is_cold_start: boolean } {
  const is_spare_usable = spare_process !== null && spare_process.exitCode === null && spare_process.signalCode === null &&
    spare_settings.model_id === settings.model_id && spare_settings.effort === settings.effort && spare_settings.sourceFormat === settings.sourceFormat;
  const claude_process = is_spare_usable && spare_process !== null ? spare_process : spawnTranslateProcess(settings);
  if (!is_spare_usable) spare_process?.kill();
  spawnSpareProcess(settings);
  return { claude_process, is_cold_start: !is_spare_usable };
}

// The spare's prompt was read at its spawn, so without this a prompt edit lands one translation late.
function watchPromptFiles(): void {
  for (const prompt_path of PROMPT_PATHS) {
    watchFile(prompt_path, { interval: 1000 }, () => {
      spare_process?.kill();
      spawnSpareProcess(spare_settings);
      log('info', null, 'prompt', `${basename(prompt_path)} changed; spare restarted`);
    });
  }
}

function rejectBadRequest(res: ServerResponse, reason: string): void {
  log('warn', null, 'http', `400 POST /translate: ${reason}`);
  res.writeHead(400).end(reason);
}

// Why the body is not a translate request, or null when it is one.
function translateRequestProblem(body: Partial<TranslateRequest>): string | null {
  const is_valid_direction =
    (body.sourceLanguage === 'en' && body.targetLanguage === 'vi') ||
    (body.sourceLanguage === 'vi' && body.targetLanguage === 'en');
  if (!is_valid_direction) return 'Direction must be en->vi or vi->en';
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
function closingLogLevel(outcome: Outcome, block_count: number, outside_char_count: number): LogLevel {
  if (outcome === 'error') return 'error';
  const is_block_format_broken = outcome === 'done' && (block_count === 0 || outside_char_count > 0);
  if (is_block_format_broken) return 'warn';
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
  const { sourceLanguage: source_language, targetLanguage: target_language, sourceText: text, modelId: requested_model_id, effort, sourceFormat } = body as TranslateRequest;

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
  const translation_output: { blocks: TranslatedBlock[]; text_outside_blocks: string; thinking_text: string; thinking_duration_ms: number | null } =
    { blocks: [], text_outside_blocks: '', thinking_text: '', thinking_duration_ms: null };
  // null while running; the outcome once the request ended. Written only by finishTranslation.
  let finished_outcome: Outcome | null = null;
  // The run is saved as it starts (the spec's run rules), so a failure or a cancel is kept too. null when the save
  // failed; the page then has no entry to mark as open.
  let history_id: number | null = null;
  try {
    history_id = history_store.startTranslation({
      sourceLanguage: source_language,
      targetLanguage: target_language,
      sourceFormat,
      sourceText: text,
      requestedModelId: requested_model_id,
      effort,
      startedAt: new Date(started_at).toISOString(),
    });
  } catch (save_error) {
    log('error', request_number, 'history', `save failed: ${(save_error as Error).message}`);
  }
  // null until the run gets that far.
  let first_text_ms: number | null = null;
  let output_tokens: number | null = null;
  const pair_parser = createPairStreamParser();
  const sendOutputEvents = (output_events: StreamEvent[]): void => {
    for (const output_event of output_events) {
      const [event_name, data] = output_event;
      if (event_name === 'block_start') {
        const { blockType, level, marker } = data;
        translation_output.blocks[data.blockIndex] = { blockType, level, marker, sourceText: '', translatedText: '' };
      } else if (event_name === 'source_delta') {
        translation_output.blocks[data.blockIndex].sourceText += data.text;
      } else if (event_name === 'translation_delta') {
        translation_output.blocks[data.blockIndex].translatedText += data.text;
      } else if (event_name === 'outside_text_delta') {
        translation_output.text_outside_blocks += data.text;
      } else if (event_name === 'thinking_delta') {
        translation_output.thinking_text += data.text;
      } else if (event_name === 'thinking_done') {
        translation_output.thinking_duration_ms = data.durationMs;
      }
      sendEvent(res, ...output_event);
    }
  };

  // The one place a translate request ends: saves how it ended with what the model produced, logs the closing line,
  // then sends the closing event. When outcome is 'error', error = { errorCode, message } goes to the page and the
  // saved run, and failure_text (one line) and failure_detail_lines (e.g. a stderr tail) go to the log only.
  function finishTranslation(
    outcome: Outcome, error: { errorCode: CliErrorCode; message: string } | null = null, failure_text = '', failure_detail_lines: string[] = [],
  ): void {
    if (finished_outcome !== null) return;
    finished_outcome = outcome;
    const served_model_id = servedModelId();
    const duration_ms = Date.now() - started_at;
    const block_count = translation_output.blocks.length;
    const outside_char_count = translation_output.text_outside_blocks.length;
    let text_outside_blocks = translation_output.text_outside_blocks;
    if (text_outside_blocks.trim() === '') text_outside_blocks = '';
    if (history_id !== null) {
      try {
        history_store.finishTranslation(history_id, {
          status: RUN_STATUS_OF_OUTCOME[outcome],
          blocks: translation_output.blocks,
          textOutsideBlocks: text_outside_blocks,
          servedModelId: served_model_id,
          thinkingText: translation_output.thinking_text,
          thinkingMs: translation_output.thinking_duration_ms,
          errorCode: error?.errorCode ?? null,
          errorMessage: error?.message ?? null,
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
      failure_text: error === null ? '' : `${error.errorCode}: ${failure_text}`,
      first_text_ms,
      thinking_duration_ms: translation_output.thinking_duration_ms,
      block_count,
      outside_char_count,
      output_tokens,
      history_id,
    });
    const log_level = closingLogLevel(outcome, block_count, outside_char_count);
    log(log_level, request_number, outcome, summary, failure_detail_lines);
    if (outcome === 'cancelled') return;
    const is_fallback = served_model_id !== requested_model_id;
    if (outcome === 'done') sendEvent(res, 'done', { durationMs: duration_ms, servedModelId: served_model_id, effort, isFallback: is_fallback, translationId: history_id });
    else if (error !== null) sendEvent(res, 'error', { ...error, servedModelId: served_model_id, effort, isFallback: is_fallback, translationId: history_id });
    res.end();
  }

  const { claude_process, is_cold_start } = takeClaudeProcess({ model_id: requested_model_id, effort, sourceFormat });
  const cold_start_note = is_cold_start ? '  cold start' : '';
  const request_line = `${formatCount(text.length)} chars  ${modelLabelOf(requested_model_id)} ${effort}  ${sourceFormat}`;
  log('info', request_number, 'start', `${source_language}->${target_language}  ${request_line}${cold_start_note}`);
  run = runClaude({
    request_number,
    settings: { model_id: requested_model_id, effort, system_prompt: systemPromptOf(sourceFormat) },
    user_message: `${direction_line}\n\n<input_text>\n${text}\n</input_text>`,
    first_token_allowance_ms,
    claude_process,
    handlers: {
      onThinkingDelta: (thinking_text) => sendOutputEvents([['thinking_delta', { text: thinking_text }]]),
      onThinkingDone: (duration_ms) => sendOutputEvents([['thinking_done', { durationMs: duration_ms }]]),
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

// What the page offers in its settings menus. quotaWarning: the latest reply's rate limit when it is a warning or a
// rejection, else null (also before the first reply since the server started).
function translationOptionsResponse(): TranslationOptions {
  const { status, rateLimitType, utilization, resetsAt } = lastRateLimitInfo() ?? {};
  const is_quota_warning = status === 'allowed_warning' || status === 'rejected';
  let quota_warning: TranslationOptions['quotaWarning'] = null;
  if (is_quota_warning) quota_warning = { status, rateLimitType, utilization, resetsAt };
  return {
    models: MODEL_OPTIONS.map(({ modelId, label, shortLabel, description }) => ({ modelId, label, shortLabel, description })),
    efforts: EFFORT_OPTIONS,
    sourceFormats: SOURCE_FORMAT_OPTIONS.map(({ sourceFormat, label, description }) => ({ sourceFormat, label, description })),
    defaultModelId: DEFAULT_MODEL_ID,
    defaultEffort: DEFAULT_EFFORT,
    defaultSourceFormat: DEFAULT_SOURCE_FORMAT,
    quotaWarning: quota_warning,
  };
}

export function createTranslateFeature({ database_path }: { database_path: string }): Feature {
  // Throws on a migration problem, so a damaged or newer database stops the server at startup, not mid-request.
  const history_store = openHistoryStore(database_path);
  const interrupted_count = history_store.failInterruptedTranslations();
  if (interrupted_count > 0) log('warn', null, 'history', `${interrupted_count} translation(s) were interrupted by a restart`);
  watchPromptFiles();

  async function handle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
    const history_entry_match = HISTORY_ENTRY_PATH.exec(pathname);
    if (req.method === 'GET' && pathname === '/') {
      await sendFile(res, PAGE_PATH, 'text/html; charset=utf-8');
    } else if (req.method === 'GET' && pathname === '/translation-options') {
      sendJson(res, 200, translationOptionsResponse());
    } else if (req.method === 'POST' && pathname === '/translate') {
      await handleTranslate(req, res, history_store);
    } else if (req.method === 'GET' && pathname === '/history') {
      sendJson(res, 200, history_store.listTranslations());
    } else if (req.method === 'GET' && history_entry_match) {
      const translation = history_store.readTranslation(Number(history_entry_match[1]));
      if (translation) sendJson(res, 200, translation);
      else res.writeHead(404).end('No such history entry');
    } else if (req.method === 'DELETE' && history_entry_match) {
      const is_deleted = history_store.deleteTranslation(Number(history_entry_match[1]));
      res.writeHead(is_deleted ? 204 : 404).end();
    } else {
      return false;
    }
    return true;
  }

  // Once the server listens, a spare process starts for the default settings.
  function start(): void {
    spawnSpareProcess(spare_settings);
  }

  return { name: 'translate', handle, start };
}

