import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, watchFile } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  Effort, EffortOption, ErrorKind, HistoryEntry, Language, Mode, ModelOption, ModeOption, Outcome, Pair, PairType, StreamEvent,
  TranslateRequest, TranslationOptions,
} from '../shared/api.ts';
import { openHistoryStore, type HistoryStore } from './history-store.ts';

// The project root: this file is server/server.ts.
const APP_DIRECTORY = dirname(dirname(fileURLToPath(import.meta.url)));
const PROMPTS_DIRECTORY = join(APP_DIRECTORY, 'prompts');
const WEB_DIRECTORY = join(APP_DIRECTORY, 'web');
// The system prompt, in order: these shared parts (glossary.tsv is data: it replaces {{glossary}} in the style part), then the mode's source part.
const SHARED_PROMPT_PATHS = ['core.md', 'style-vi.md', 'style-en.md'].map((name) => join(PROMPTS_DIRECTORY, name));
const GLOSSARY_PATH = join(PROMPTS_DIRECTORY, 'glossary.tsv');
const INDEX_HTML_PATH = join(WEB_DIRECTORY, 'index.html');
const FAVICON_PATH = join(WEB_DIRECTORY, 'favicon.svg');
// The page's modules, served as JavaScript with their types stripped, so the browser runs the same files tsc checks.
const WEB_MODULE_PATHS = new Map(['app.ts', 'markdown.ts', 'source-check.ts'].map((name) => [`/${name}`, join(WEB_DIRECTORY, name)]));
const HISTORY_DATABASE_PATH = process.env.HISTORY_DATABASE_PATH ?? join(APP_DIRECTORY, 'data', 'history.sqlite');
// Next to the database by default, so a test server on a scratch database never writes into the real log.
const SERVER_LOG_PATH = process.env.SERVER_LOG_PATH ?? join(dirname(HISTORY_DATABASE_PATH), 'server.log');
const PORT = Number(process.env.PORT ?? 8787);
// fallback_model_id: the model a first run hands over to when this one sends no token within SWITCH_TO_FALLBACK_AFTER_MS;
// null: the run waits LAST_MODEL_FIRST_TOKEN_TIMEOUT_MS, then fails.
interface ModelConfig extends ModelOption {
  fallback_model_id: string | null;
}

// source_prompt_path: the mode's "# Source" section, the last part of the system prompt.
interface ModeConfig extends ModeOption {
  source_prompt_path: string;
}

// What a claude process is started with; all three are fixed for its lifetime.
interface ClaudeSettings {
  model_id: string;
  effort: Effort;
  mode: Mode;
}

// The rate_limit_info a stream-json reply carries.
interface RateLimitInfo {
  status: string;
  rateLimitType?: string;
  utilization?: number;
  resetsAt?: number;
  isUsingOverage?: boolean;
}

// The stream-json lines claude prints, only as far as this server reads them.
interface ClaudeMessage {
  type: string;
  subtype?: string;
  event?: {
    type: string;
    index?: number;
    content_block?: { type: string };
    delta?: { type?: string; thinking?: string; text?: string; stop_reason?: string };
  };
  attempt?: number;
  max_retries?: number;
  error?: string;
  error_status?: number;
  retry_delay_ms?: number;
  rate_limit_info?: RateLimitInfo;
  is_error?: boolean;
  result?: string;
  api_error_status?: number;
  usage?: { output_tokens?: number };
}

type LogLevel = 'info' | 'warn' | 'error';

// Menu order.
const MODEL_OPTIONS: ModelConfig[] = [
  { model_id: 'claude-opus-5-5', label: 'Opus 5.5', short_label: 'Opus', description: "Best nuance and tone · 2× Sonnet's usage", fallback_model_id: 'claude-sonnet-5-5' },
  { model_id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', short_label: 'Sonnet', description: 'Natural and quick for everyday text', fallback_model_id: 'claude-haiku-5-5' },
  { model_id: 'claude-haiku-5-5', label: 'Haiku 5.5', short_label: 'Haiku', description: 'Fastest · a fraction of the usage', fallback_model_id: null },
];
// xhigh and max are left out: translation gains little from them, and they think longest and use the most.
const EFFORT_OPTIONS: EffortOption[] = [
  { effort: 'low', label: 'Low', description: 'Thinks only when needed. Fastest.' },
  { effort: 'medium', label: 'Medium', description: 'Thinks through tricky passages.' },
  { effort: 'high', label: 'High', description: 'Thinks longest. Slowest, uses the most.' },
];
// Menu order.
const MODE_OPTIONS: ModeConfig[] = [
  { mode: 'translate', label: 'As pasted', description: 'Keeps your text exactly as pasted.', source_prompt_path: join(PROMPTS_DIRECTORY, 'source-translate.md') },
  { mode: 'translate_markdown', label: 'Markdown', description: 'Tidies pasted text into headings, lists and paragraphs, then translates. Words never change.', source_prompt_path: join(PROMPTS_DIRECTORY, 'source-translate_markdown.md') },
];
const DEFAULT_MODEL_ID = 'claude-sonnet-5-5';
const DEFAULT_EFFORT: Effort = 'low';
const DEFAULT_MODE: Mode = 'translate';
// Output is the ceiling, not input: the reply restates the source and adds the translation, ~1.05 output tokens per
// source char (measured en->vi), so 100k chars leaves ~20k of MAX_OUTPUT_TOKENS for thinking.
const MAX_TEXT_CHARS = 100_000;
// Measured on Claude's tokenizer from a 19.5k-char en->vi run: English ~4 chars per token, Vietnamese ~1.3.
const CHARS_PER_TOKEN: Record<Language, number> = { en: 4, vi: 1.3 };
// Arbitrary: reading a long input delays the first token; 1s per 10k input tokens keeps a 77k-token input from
// being mistaken for a silent model.
const FIRST_TOKEN_MS_PER_INPUT_TOKEN = 0.1;
const MAX_OUTPUT_TOKENS = 128_000;
// A token is the start of a thinking block or any content delta. Even at --effort low the model may think first, for
// seconds on a long input, and its first summarized thinking_delta lags the block start by 1.4-1.9s (measured); only
// "no token at all" means stuck. The warm first token arrives in ~1-2s, so 10s without one hands over to the next
// model down.
const SWITCH_TO_FALLBACK_AFTER_MS = 10_000;
// Longer: the model taking over starts cold (~1.3s more), and nothing is left to fall back to.
const LAST_MODEL_FIRST_TOKEN_TIMEOUT_MS = 30_000;
// Arbitrary: a live reply never pauses this long between tokens, whether it is thinking or writing.
const STREAM_STALL_TIMEOUT_MS = 60_000;
const LANGUAGE_NAMES: Record<Language, string> = { en: 'English', vi: 'Vietnamese' };
// Arbitrary: enough of a stderr tail or a stack to name the problem without burying the lines after it.
const LOG_DETAIL_MAX_LINES = 6;
// Arbitrary: room for a whole error sentence; a raw blob is cut instead of flooding the terminal.
const LOG_MESSAGE_MAX_CHARS = 300;
// Arbitrary: a 5-point step shows the climb towards the limit without a quota line on every request.
const QUOTA_LOG_STEP_PERCENT = 5;
const QUOTA_WINDOW_LABELS: Record<string, string> = { five_hour: '5h', seven_day: '7d' };
const QUOTA_STATUS_LABELS: Record<string, string> = { allowed: 'ok', allowed_warning: 'warning', rejected: 'rejected' };
const QUOTA_STATUS_LOG_LEVELS: Record<string, LogLevel> = { allowed: 'info', allowed_warning: 'warn', rejected: 'error' };
const LOG_LEVEL_MARKERS: Record<LogLevel, string> = { info: '', warn: 'WARN', error: 'ERROR' };
const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ANSI_DIM = '\x1b[2m';
const ANSI_YELLOW = '\x1b[33m';
const ANSI_BOLD_RED = '\x1b[1;31m';
const ANSI_RESET = '\x1b[0m';
const LOG_LEVEL_COLORS: Record<LogLevel, string> = { info: '', warn: ANSI_YELLOW, error: ANSI_BOLD_RED };
// hasColors() already honours NO_COLOR and TERM=dumb; a pipe or a file is not a TTY and gets plain text.
const IS_COLOR_LOG = process.stdout.isTTY === true && process.stdout.hasColors();

let translate_request_count = 0;
// Every reply repeats the rate-limit state, so only a change of quotaLogKey is worth a line.
let last_logged_quota_key = 'allowed';
let last_logged_date_text: string | null = null;
// The latest rate_limit_info any reply carried; null until the first reply. Written only by the stdout handler.
let last_rate_limit_info: RateLimitInfo | null = null;
// Set by the first failed write to SERVER_LOG_PATH, so the terminal warns once instead of on every line.
let is_log_file_failing = false;

// undefined for an id no longer offered (a history row can name one).
function modelOptionOf(model_id: string | undefined): ModelConfig | undefined {
  return MODEL_OPTIONS.find((option) => option.model_id === model_id);
}

function modeOptionOf(mode: string | undefined): ModeConfig | undefined {
  return MODE_OPTIONS.find((option) => option.mode === mode);
}

function isEffort(effort: unknown): effort is Effort {
  return EFFORT_OPTIONS.some((option) => option.effort === effort);
}

function isMode(mode: unknown): mode is Mode {
  return modeOptionOf(mode as string) !== undefined;
}

// Read at every spawn, so a prompt edit reaches the next process without a restart.
function systemPromptOf(mode: Mode): string {
  const { source_prompt_path } = modeOptionOf(mode) as ModeConfig;
  const glossary_lines = readFileSync(GLOSSARY_PATH, 'utf8').split('\n').filter((line) => line.trim() !== '' && !line.startsWith('#'));
  const glossary_block = `<glossary>\nEnglish term -> form to use in Vietnamese ("keep" = leave the English term):\n${
    glossary_lines.map((line) => line.replace(/\t+/g, ' -> ').trim()).join('\n')}\n</glossary>`;
  const parts = SHARED_PROMPT_PATHS.map((path) => readFileSync(path, 'utf8').trim().replace('{{glossary}}', () => glossary_block));
  return `${parts.join('\n\n')}\n\n${readFileSync(source_prompt_path, 'utf8').trim()}\n`;
}

function modelLabelOf(model_id: string): string {
  return modelOptionOf(model_id)?.label ?? model_id;
}

function padTwoDigits(number: number): string {
  return String(number).padStart(2, '0');
}

function formatClockTime(date: Date): string {
  return `${padTwoDigits(date.getHours())}:${padTwoDigits(date.getMinutes())}:${padTwoDigits(date.getSeconds())}`;
}

function formatDateText(date: Date): string {
  return `${WEEKDAY_NAMES[date.getDay()]} ${date.getFullYear()}-${padTwoDigits(date.getMonth() + 1)}-${padTwoDigits(date.getDate())}`;
}

function formatWeekdayTime(date: Date): string {
  return `${WEEKDAY_NAMES[date.getDay()]} ${padTwoDigits(date.getHours())}:${padTwoDigits(date.getMinutes())}`;
}

function formatSeconds(duration_ms: number): string {
  return `${(duration_ms / 1000).toFixed(1)}s`;
}

function formatCount(count: number): string {
  return count.toLocaleString('en-US');
}

function toOneLine(text: string, max_chars: number): string {
  const one_line_text = String(text).replace(/\s*[\r\n]+\s*/g, ' ').trim();
  return one_line_text.length > max_chars ? `${one_line_text.slice(0, max_chars - 3)}...` : one_line_text;
}

function lastLines(text: string, line_count: number): string[] {
  return text.split('\n').map((line) => line.trimEnd()).filter((line) => line !== '').slice(-line_count);
}

function paint(text: string, ansi_color: string, is_color: boolean): string {
  return is_color && ansi_color !== '' ? `${ansi_color}${text}${ANSI_RESET}` : text;
}

// 5, 4 and 9 fit 'ERROR', '#999' and 'cancelled', the widest values, so the columns line up.
function formatLogLine(
  date: Date, level: LogLevel, request_number: number | null, event_name: string, message: string, detail_lines: string[], is_color: boolean,
): string {
  const time_text = formatClockTime(date);
  const level_text = LOG_LEVEL_MARKERS[level].padEnd(5);
  const request_text = (request_number === null ? '' : `#${request_number}`).padEnd(4);
  const event_text = event_name.padEnd(9);
  const level_color = LOG_LEVEL_COLORS[level];
  const head = [
    paint(time_text, ANSI_DIM, is_color), paint(level_text, level_color, is_color), request_text, paint(event_text, level_color, is_color),
  ].join(' ');
  const detail_indent = ' '.repeat([time_text, level_text, request_text, event_text].join(' ').length + 1);
  return [
    `${head} ${toOneLine(message, LOG_MESSAGE_MAX_CHARS)}`,
    ...detail_lines.map((line) => `${detail_indent}| ${toOneLine(line, LOG_MESSAGE_MAX_CHARS)}`),
  ].join('\n');
}

// level: 'info' | 'warn' | 'error'; request_number is null for a line that belongs to no request.
// message is cut to one line; detail_lines (a stderr tail, a stack) print under it, indented to its column.
// Writes the terminal (coloured when it can) and appends the same lines, uncoloured, to SERVER_LOG_PATH.
function log(level: LogLevel, request_number: number | null, event_name: string, message: string, detail_lines: string[] = []): void {
  const now = new Date();
  const date_text = formatDateText(now);
  let terminal_text = '';
  let file_text = '';
  if (date_text !== last_logged_date_text) {
    last_logged_date_text = date_text;
    terminal_text += `${paint(`--- ${date_text} ---`, ANSI_DIM, IS_COLOR_LOG)}\n`;
    file_text += `--- ${date_text} ---\n`;
  }
  terminal_text += formatLogLine(now, level, request_number, event_name, message, detail_lines, IS_COLOR_LOG);
  file_text += `${formatLogLine(now, level, request_number, event_name, message, detail_lines, false)}\n`;
  console.log(terminal_text);
  try {
    appendFileSync(SERVER_LOG_PATH, file_text);
  } catch (error) {
    // A throw here would escape a stream handler and stop the server; a log file that cannot be written must not.
    if (!is_log_file_failing) console.log(formatLogLine(now, 'warn', null, 'log', `cannot write ${SERVER_LOG_PATH}: ${(error as Error).message}`, [], IS_COLOR_LOG));
    is_log_file_failing = true;
  }
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

// Two rate_limit_info values with the same key read the same in the log; while allowed, utilization is ignored.
function quotaLogKey(rate_limit_info: RateLimitInfo): string {
  const { status, rateLimitType, utilization, isUsingOverage } = rate_limit_info;
  if (status === 'allowed') return status;
  return `${status} ${rateLimitType} ${Math.floor(((utilization ?? 0) * 100) / QUOTA_LOG_STEP_PERCENT)} ${isUsingOverage}`;
}

function formatQuota(rate_limit_info: RateLimitInfo): string {
  const { status, rateLimitType, utilization, resetsAt, isUsingOverage } = rate_limit_info;
  const window_label = rateLimitType === undefined ? 'window unknown' : QUOTA_WINDOW_LABELS[rateLimitType] ?? rateLimitType;
  const percent_text = typeof utilization === 'number' ? `${Math.round(utilization * 100)}%` : 'usage unknown';
  const fields = [`${window_label} ${percent_text} (${QUOTA_STATUS_LABELS[status] ?? status})`];
  if (typeof resetsAt === 'number') fields.push(`resets ${formatWeekdayTime(new Date(resetsAt * 1000))}`);
  if (isUsingOverage === true) fields.push('overage in use');
  return fields.join(', ');
}

function sendEvent(res: ServerResponse, ...[event_name, data]: StreamEvent): void {
  if (res.destroyed || res.writableEnded) return;
  res.write(`event: ${event_name}\ndata: ${JSON.stringify(data)}\n\n`);
}

const PAIR_TYPES = new Set<string>(['heading', 'paragraph', 'list_item', 'table', 'code', 'quote', 'other']);
const PAIR_OPEN_TAG = /<pair\b([^>]*)>/;
type PairParserState = 'between_pairs' | 'in_pair' | 'in_source' | 'in_translation';
const PAIR_FIELD_OPEN_TAGS: Record<string, PairParserState> = { '<source>': 'in_source', '<translation>': 'in_translation' };

function parsePairAttributes(attribute_text: string): { pair_type: PairType; level: number; marker: string } {
  const attributes: Record<string, string | undefined> = Object.fromEntries([...attribute_text.matchAll(/(\w+)="([^"]*)"/g)].map((match) => [match[1], match[2]]));
  return {
    pair_type: attributes.type !== undefined && PAIR_TYPES.has(attributes.type) ? attributes.type as PairType : 'other',
    level: Number.parseInt(attributes.level ?? '', 10) || 0,
    marker: attributes.marker ?? '',
  };
}

// Index from which text could still be the start of closing_tag; text.length when no suffix can be.
function heldTailStart(text: string, closing_tag: string): number {
  for (let index = Math.max(0, text.length - closing_tag.length + 1); index < text.length; index++) {
    if (closing_tag.startsWith(text.slice(index))) return index;
  }
  return text.length;
}

// Turns the model's <pair><source/><translation/></pair> stream into [event_name, data] tuples as text arrives.
// Text outside any pair becomes unpaired_delta, which is how a reply that ignores the format still reaches the page.
function createPairStreamParser(): { push(text: string): StreamEvent[]; finish(): StreamEvent[] } {
  let buffer = '';
  let state: PairParserState = 'between_pairs';
  let pair_index = -1;
  let is_field_start = false;
  // The delta event for text inside the field being read.
  const fieldDelta = (text: string): StreamEvent =>
    state === 'in_source' ? ['source_delta', { pair_index, text }] : ['translation_delta', { pair_index, text }];

  function push(text: string): StreamEvent[] {
    buffer += text;
    const events: StreamEvent[] = [];
    while (buffer !== '') {
      if (state === 'between_pairs') {
        const open_match = PAIR_OPEN_TAG.exec(buffer);
        if (open_match) {
          const unpaired_text = buffer.slice(0, open_match.index);
          if (unpaired_text.trim() !== '') events.push(['unpaired_delta', { text: unpaired_text }]);
          pair_index += 1;
          events.push(['pair_start', { pair_index, ...parsePairAttributes(open_match[1]) }]);
          buffer = buffer.slice(open_match.index + open_match[0].length);
          state = 'in_pair';
          continue;
        }
        const last_open_bracket = buffer.lastIndexOf('<');
        const is_tag_pending = last_open_bracket !== -1 && buffer.indexOf('>', last_open_bracket) === -1;
        const flush_end = is_tag_pending ? last_open_bracket : buffer.length;
        const unpaired_text = buffer.slice(0, flush_end);
        if (unpaired_text.trim() !== '') events.push(['unpaired_delta', { text: unpaired_text }]);
        buffer = buffer.slice(flush_end);
        break;
      }

      if (state === 'in_pair') {
        buffer = buffer.trimStart();
        const field_tag = Object.keys(PAIR_FIELD_OPEN_TAGS).find((tag) => buffer.startsWith(tag));
        if (field_tag !== undefined) {
          state = PAIR_FIELD_OPEN_TAGS[field_tag];
          buffer = buffer.slice(field_tag.length);
          is_field_start = true;
          continue;
        }
        if (buffer.startsWith('</pair>')) {
          state = 'between_pairs';
          buffer = buffer.slice('</pair>'.length);
          continue;
        }
        const is_tag_prefix = [...Object.keys(PAIR_FIELD_OPEN_TAGS), '</pair>'].some((tag) => tag.startsWith(buffer));
        if (is_tag_prefix) break;
        const next_bracket = buffer.indexOf('<', 1);
        buffer = next_bracket === -1 ? '' : buffer.slice(next_bracket);
        continue;
      }

      const field_name = state === 'in_source' ? 'source' : 'translation';
      const closing_tag = `</${field_name}>`;
      if (is_field_start) {
        if (buffer.startsWith('\n')) buffer = buffer.slice(1);
        is_field_start = false;
        if (buffer === '') break;
      }
      const close_index = buffer.indexOf(closing_tag);
      if (close_index !== -1) {
        const field_text = buffer.slice(0, close_index).replace(/\n$/, '');
        if (field_text !== '') events.push(fieldDelta(field_text));
        buffer = buffer.slice(close_index + closing_tag.length);
        state = 'in_pair';
        continue;
      }
      // Holds a trailing newline too: it belongs to the field only if more text follows before the closing tag.
      let hold_from = heldTailStart(buffer, closing_tag);
      if (hold_from > 0 && buffer[hold_from - 1] === '\n') hold_from -= 1;
      const field_text = buffer.slice(0, hold_from);
      if (field_text !== '') events.push(fieldDelta(field_text));
      buffer = buffer.slice(hold_from);
      break;
    }
    return events;
  }

  function finish(): StreamEvent[] {
    const events: StreamEvent[] = [];
    if ((state === 'in_source' || state === 'in_translation') && buffer.replace(/\n$/, '') !== '') {
      events.push(fieldDelta(buffer.replace(/\n$/, '')));
    } else if (state === 'between_pairs' && buffer.trim() !== '') {
      events.push(['unpaired_delta', { text: buffer }]);
    }
    buffer = '';
    return events;
  }

  return { push, finish };
}

// --setting-sources "" keeps ~/.claude/CLAUDE.md, skills and plugins out of the
// context (measured 5982 -> 666 input tokens); --bare would also do that but drops the subscription login.
function spawnClaudeProcess({ model_id, effort, mode }: ClaudeSettings) {
  return spawn(
    'claude',
    [
      '-p',
      '--model', model_id,
      '--effort', effort,
      '--tools', '',
      '--setting-sources', '',
      '--disable-slash-commands',
      '--strict-mcp-config',
      '--no-session-persistence',
      '--system-prompt', systemPromptOf(mode),
      // Lets a spare wait for input indefinitely; text input gives up after 3s without stdin.
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      // Hidden flag (absent from `claude --help` on 2.1.301): without it every thinking_delta.thinking is ''.
      '--thinking-display', 'summarized',
    ],
    {
      cwd: APP_DIRECTORY,
      // The CLI's default output cap is below what a long input needs (3.5k chars en->vi measured 6.2k output
      // tokens); a value above the model's maximum is clamped by the CLI, not rejected.
      env: { ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(MAX_OUTPUT_TOKENS) },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
}

type ClaudeProcess = ReturnType<typeof spawnClaudeProcess>;

function stopProcess(claude_process: ChildProcess): void {
  if (claude_process.exitCode !== null || claude_process.signalCode !== null) return;
  claude_process.kill('SIGINT');
  // A process stuck on the network may ignore SIGINT; without this it would linger forever.
  setTimeout(() => {
    if (claude_process.exitCode === null && claude_process.signalCode === null) claude_process.kill('SIGKILL');
  }, 3000);
}

// One started-up process always waits for the next request, hiding ~1.5s of startup (measured: first text 2.2s
// cold vs 1.0s warm). Each process translates once, so no context carries over.
let spare_process: ClaudeProcess | null = null;
// The settings spare_process was started with: the last request's. Written only by spawnSpareProcess.
let spare_settings: ClaudeSettings = { model_id: DEFAULT_MODEL_ID, effort: DEFAULT_EFFORT, mode: DEFAULT_MODE };
// Set when a waiting spare dies, cleared by any result: a CLI that cannot start warns once, not once per request.
let is_spare_failing = false;

function spawnSpareProcess(settings: ClaudeSettings): void {
  const claude_process = spawnClaudeProcess(settings);
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
function takeClaudeProcess(settings: ClaudeSettings): { claude_process: ClaudeProcess; is_cold_start: boolean } {
  const is_spare_usable = spare_process !== null && spare_process.exitCode === null && spare_process.signalCode === null &&
    spare_settings.model_id === settings.model_id && spare_settings.effort === settings.effort && spare_settings.mode === settings.mode;
  const claude_process = is_spare_usable && spare_process !== null ? spare_process : spawnClaudeProcess(settings);
  if (!is_spare_usable) spare_process?.kill();
  spawnSpareProcess(settings);
  return { claude_process, is_cold_start: !is_spare_usable };
}

// The spare's prompt was read at its spawn, so without this a prompt edit lands one translation late.
for (const prompt_path of [...SHARED_PROMPT_PATHS, GLOSSARY_PATH, ...MODE_OPTIONS.map((option) => option.source_prompt_path)]) {
  watchFile(prompt_path, { interval: 1000 }, () => {
    spare_process?.kill();
    spawnSpareProcess(spare_settings);
    log('info', null, 'prompt', `${basename(prompt_path)} changed; spare restarted`);
  });
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return JSON.parse(body);
}

function rejectBadRequest(res: ServerResponse, reason: string): void {
  log('warn', null, 'http', `400 POST /translate: ${reason}`);
  res.writeHead(400).end(reason);
}

async function handleTranslate(req: IncomingMessage, res: ServerResponse, history_store: HistoryStore): Promise<void> {
  let body: Partial<TranslateRequest>;
  try {
    body = (await readJsonBody(req)) as Partial<TranslateRequest>;
  } catch {
    rejectBadRequest(res, 'Body must be JSON');
    return;
  }
  const isValidDirection =
    (body.source_language === 'en' && body.target_language === 'vi') ||
    (body.source_language === 'vi' && body.target_language === 'en');
  if (!isValidDirection) {
    rejectBadRequest(res, 'Direction must be en->vi or vi->en');
    return;
  }
  if (typeof body.text !== 'string' || body.text.trim() === '' || body.text.length > MAX_TEXT_CHARS) {
    rejectBadRequest(res, `text must be a non-empty string of at most ${MAX_TEXT_CHARS} chars`);
    return;
  }
  // Checked here because the CLI does not: an unknown --effort only prints a warning and runs at its default.
  if (modelOptionOf(body.model_id) === undefined) {
    rejectBadRequest(res, `model_id must be one of ${MODEL_OPTIONS.map((option) => option.model_id).join(', ')}`);
    return;
  }
  if (!isEffort(body.effort)) {
    rejectBadRequest(res, `effort must be one of ${EFFORT_OPTIONS.map((option) => option.effort).join(', ')}`);
    return;
  }
  if (!isMode(body.mode)) {
    rejectBadRequest(res, `mode must be one of ${MODE_OPTIONS.map((option) => option.mode).join(', ')}`);
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
  const user_message_line = `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: `${direction_line}\n\n<input_text>\n${text}\n</input_text>` },
  })}\n`;

  // Only the run in current_process may write to res; a superseded run's late output is dropped.
  let current_process: ClaudeProcess | null = null;
  // The model of the run that writes to res: requested_model_id, or its fallback. Written only by runModel.
  let served_model_id = requested_model_id;
  let has_result = false;
  const first_token_allowance_ms = Math.round((text.length / CHARS_PER_TOKEN[source_language]) * FIRST_TOKEN_MS_PER_INPUT_TOKEN);
  // What the model has produced so far, in the shape history stores; written only by sendOutputEvents.
  // thinking_duration_ms stays null unless a thinking block closed.
  const translation_output: { pairs: Pair[]; unpaired_text: string; thinking_text: string; thinking_duration_ms: number | null } =
    { pairs: [], unpaired_text: '', thinking_text: '', thinking_duration_ms: null };
  // null while running; the outcome once the request ended. Written only by finishTranslation.
  let finished_outcome: Outcome | null = null;
  // null until the run gets that far.
  let first_text_ms: number | null = null;
  let output_tokens: number | null = null;

  // The one place a translate request ends: saves it to history when the model produced anything, logs the closing
  // line, then sends the closing event. When outcome is 'error', error = { error_kind, message } goes to the page and
  // failure_text (one line) and failure_detail_lines (e.g. a stderr tail) go to the log only.
  function finishTranslation(
    outcome: Outcome, error: { error_kind: ErrorKind; message: string } | null = null, failure_text = '', failure_detail_lines: string[] = [],
  ): void {
    if (finished_outcome !== null) return;
    finished_outcome = outcome;
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
    const is_pair_format_broken = outcome === 'done' && (pair_count === 0 || unpaired_char_count > 0);
    log(
      outcome === 'error' ? 'error' : is_pair_format_broken ? 'warn' : 'info',
      request_number,
      outcome,
      formatRequestSummary({
        outcome, model_label: modelLabelOf(served_model_id), effort, duration_ms,
        failure_text: error === null ? '' : `${error.error_kind}: ${failure_text}`,
        first_text_ms, thinking_duration_ms: translation_output.thinking_duration_ms, pair_count, unpaired_char_count,
        output_tokens, history_id,
      }),
      failure_detail_lines,
    );
    if (outcome === 'cancelled') return;
    const is_fallback = served_model_id !== requested_model_id;
    if (outcome === 'done') sendEvent(res, 'done', { duration_ms, served_model_id, effort, is_fallback, history_id });
    else if (error !== null) sendEvent(res, 'error', { ...error, served_model_id, effort, is_fallback, history_id });
    res.end();
  }

  // is_first_run: the run for the requested model; only it may hand over, so a request switches model at most once.
  function runModel(model_id: string, claude_process: ClaudeProcess, is_first_run: boolean): void {
    current_process = claude_process;
    served_model_id = model_id;
    const fallback_model_id = is_first_run ? modelOptionOf(model_id)?.fallback_model_id ?? null : null;
    const isCurrent = () => current_process === claude_process && !res.writableEnded && !res.destroyed;
    // The content-block index of the thinking block being streamed; null when none is open.
    let open_thinking_block_index: number | null = null;
    let thinking_started_at = 0;
    // The last kind of event this run produced, e.g. 'system/init' or 'message_start'.
    // A timeout log shows it, telling "claude never reached the API" apart from "the API sent nothing back".
    let last_event_kind = 'none';
    // The CLI answers a 'max_tokens' stop by asking the model to continue, up to 3 times, then ends with a success (if
    // only thinking was cut) or a generic error; only the last API message's stop_reason says the reply was cut off.
    let last_stop_reason: string | null = null;
    let stdout_buffer = '';
    let stderr_text = '';
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

    // The page picks its wording from error_kind.
    const stopForTimeout = (error_kind: ErrorKind, reason: string): void => {
      if (!isCurrent()) return;
      finishTranslation('error', { error_kind, message: `${modelLabelOf(model_id)} ${reason}.` }, `${reason}, last_event=${last_event_kind}`);
    };
    const switchToFallback = (): void => {
      if (!isCurrent() || fallback_model_id === null) return;
      log(
        'warn', request_number, 'fallback',
        `${modelLabelOf(model_id)} sent no token within ${formatSeconds(switch_to_fallback_after_ms)}, last_event=${last_event_kind} ` +
          `-> ${modelLabelOf(fallback_model_id)}`,
      );
      sendEvent(res, 'fallback', { from_model_id: model_id, to_model_id: fallback_model_id });
      stopProcess(claude_process);
      // The same effort: falling back is about getting an answer at all, not about how deeply to think.
      runModel(fallback_model_id, spawnClaudeProcess({ model_id: fallback_model_id, effort, mode }), false);
    };
    // The one timer of a run: until the first token it decides fallback, or failure when there is nothing to fall
    // back to; after that, every token re-arms it as a stall timeout.
    const switch_to_fallback_after_ms = SWITCH_TO_FALLBACK_AFTER_MS + first_token_allowance_ms;
    const last_model_first_token_timeout_ms = LAST_MODEL_FIRST_TOKEN_TIMEOUT_MS + first_token_allowance_ms;
    let token_timer = fallback_model_id === null
      ? setTimeout(
        () => stopForTimeout('no_response', `sent nothing within ${formatSeconds(last_model_first_token_timeout_ms)}`),
        last_model_first_token_timeout_ms,
      )
      : setTimeout(switchToFallback, switch_to_fallback_after_ms);
    const clearTimers = () => clearTimeout(token_timer);

    // A write to a process that just died raises EPIPE here; 'close' below reports the failure.
    claude_process.stdin.on('error', () => {});
    claude_process.stdin.end(user_message_line);

    claude_process.stderr.on('data', (chunk) => { stderr_text += chunk; });
    claude_process.stdout.on('data', (chunk) => {
      stdout_buffer += chunk;
      const lines = stdout_buffer.split('\n');
      stdout_buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim() === '' || !isCurrent()) continue;
        let message: ClaudeMessage;
        try {
          message = JSON.parse(line) as ClaudeMessage;
        } catch {
          log('warn', request_number, 'stdout', `not JSON: ${line}`);
          continue;
        }
        const stream_event = message.type === 'stream_event' ? message.event : undefined;
        const stream_event_type = stream_event?.type;
        // delta_type: 'thinking_delta' | 'signature_delta' | 'text_delta', or undefined for any other event.
        const delta_type = stream_event_type === 'content_block_delta' ? stream_event?.delta?.type : undefined;
        const is_thinking_start = stream_event_type === 'content_block_start' && stream_event?.content_block?.type === 'thinking';
        last_event_kind = message.subtype ? `${message.type}/${message.subtype}`
          : delta_type ? `${stream_event_type}:${delta_type}`
          : message.event?.type ?? message.type;
        if (delta_type !== undefined || is_thinking_start) {
          clearTimeout(token_timer);
          token_timer = setTimeout(() => stopForTimeout('stalled', `stopped streaming for ${STREAM_STALL_TIMEOUT_MS / 1000}s`), STREAM_STALL_TIMEOUT_MS);
        }
        if (is_thinking_start) {
          open_thinking_block_index = stream_event?.index ?? null;
          thinking_started_at = Date.now();
        } else if (delta_type === 'thinking_delta' && stream_event?.delta?.thinking) {
          sendOutputEvents([['thinking_delta', { text: stream_event.delta.thinking }]]);
        } else if (stream_event_type === 'content_block_stop' && stream_event?.index === open_thinking_block_index) {
          open_thinking_block_index = null;
          const thinking_duration_ms = Date.now() - thinking_started_at;
          sendOutputEvents([['thinking_done', { duration_ms: thinking_duration_ms }]]);
        } else if (delta_type === 'text_delta') {
          if (first_text_ms === null) first_text_ms = Date.now() - started_at;
          sendOutputEvents(pair_parser.push(stream_event?.delta?.text ?? ''));
        } else if (stream_event_type === 'message_delta') {
          last_stop_reason = stream_event?.delta?.stop_reason ?? null;
        } else if (message.type === 'user' && last_stop_reason === 'max_tokens') {
          log('warn', request_number, 'continue', `${modelLabelOf(model_id)} hit ${formatCount(MAX_OUTPUT_TOKENS)} output tokens; claude asked it to continue`);
        } else if (message.type === 'system' && message.subtype === 'api_retry') {
          log(
            'warn', request_number, 'retry',
            `${message.attempt}/${message.max_retries} ${message.error}${message.error_status ? ` (${message.error_status})` : ''}, ` +
              `next in ${formatSeconds(message.retry_delay_ms ?? 0)}`,
          );
          sendEvent(res, 'retry', { attempt: message.attempt ?? 0, max_retries: message.max_retries ?? 0, error: message.error ?? '' });
        } else if (message.type === 'rate_limit_event' && message.rate_limit_info !== undefined) {
          last_rate_limit_info = message.rate_limit_info;
          if (quotaLogKey(message.rate_limit_info) !== last_logged_quota_key) {
            last_logged_quota_key = quotaLogKey(message.rate_limit_info);
            log(QUOTA_STATUS_LOG_LEVELS[message.rate_limit_info.status] ?? 'warn', null, 'quota', formatQuota(message.rate_limit_info));
          }
        } else if (message.type === 'result') {
          has_result = true;
          is_spare_failing = false;
          clearTimers();
          sendOutputEvents(pair_parser.finish());
          output_tokens = message.usage?.output_tokens ?? null;
          // The process takes ~1.5s more to exit after its result; finishTranslation ends the response without waiting.
          if (last_stop_reason === 'max_tokens') {
            finishTranslation(
              'error',
              { error_kind: 'output_limit', message: `The reply reached the ${formatCount(MAX_OUTPUT_TOKENS)}-token output limit and was cut off.` },
              `stop_reason=max_tokens after claude's continuations`,
            );
          } else if (message.is_error) {
            const result_text = String(message.result ?? message.subtype);
            finishTranslation(
              'error', { error_kind: 'claude_error', message: result_text },
              `${result_text}${message.api_error_status ? ` (${message.api_error_status})` : ''}`,
            );
          } else {
            finishTranslation('done');
          }
        }
      }
    });

    claude_process.on('error', (error) => {
      clearTimers();
      if (!isCurrent()) return;
      finishTranslation('error', { error_kind: 'start_failed', message: `Cannot start claude: ${error.message}` }, error.message);
    });
    claude_process.on('close', (exit_code, signal) => {
      clearTimers();
      if (!isCurrent() || has_result) return;
      finishTranslation(
        'error', { error_kind: 'exited', message: stderr_text.trim() || `claude exited with code ${exit_code}` },
        `${signal ? `killed by ${signal}` : `exit code ${exit_code}`}, last_event=${last_event_kind}`,
        lastLines(stderr_text, LOG_DETAIL_MAX_LINES),
      );
    });
  }

  const { claude_process, is_cold_start } = takeClaudeProcess({ model_id: requested_model_id, effort, mode });
  log(
    'info', request_number, 'start',
    `${source_language}->${target_language}  ${formatCount(text.length)} chars  ${modelLabelOf(requested_model_id)} ${effort}  ${mode}` +
      `${is_cold_start ? '  cold start' : ''}`,
  );
  runModel(requested_model_id, claude_process, true);

  // Watch res, not req: req emits 'close' as soon as the body has been read. This is also what stops the process
  // after a timeout error: finishTranslation ends res, and that close lands here.
  res.on('close', () => {
    finishTranslation('cancelled');
    if (!has_result && current_process !== null) stopProcess(current_process);
  });
}

function sendJson(res: ServerResponse, status_code: number, body: unknown): void {
  res.writeHead(status_code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function toHistoryResponse(entry: Omit<HistoryEntry, 'is_fallback'>): HistoryEntry {
  return { ...entry, is_fallback: entry.served_model_id !== entry.requested_model_id };
}

// What the page offers in its settings menus. quota_warning: the latest reply's rate limit when it is a warning or a
// rejection, else null (also before the first reply since the server started).
function translationOptionsResponse(): TranslationOptions {
  const { status, rateLimitType, utilization, resetsAt } = last_rate_limit_info ?? {};
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
const history_store = openHistoryStore(HISTORY_DATABASE_PATH);
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
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(await readFile(INDEX_HTML_PATH));
    } else if (req.method === 'GET' && WEB_MODULE_PATHS.has(pathname)) {
      const module_path = WEB_MODULE_PATHS.get(pathname) as string;
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(stripTypeScriptTypes(await readFile(module_path, 'utf8')));
    } else if (req.method === 'GET' && (pathname === '/favicon.svg' || pathname === '/favicon.ico')) {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache' });
      res.end(await readFile(FAVICON_PATH));
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
      res.writeHead(404).end();
    }
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    const stack_frame_lines = String(failure.stack ?? '').split('\n').slice(1, 1 + LOG_DETAIL_MAX_LINES)
      .map((line) => line.replaceAll(`file://${APP_DIRECTORY}/`, ''));
    log('error', null, 'http', `500 ${req.method} ${pathname}: ${failure.message}`, stack_frame_lines);
    if (!res.headersSent) res.writeHead(500).end('Internal error');
    else res.end();
  }
});

// Bound to loopback only: anyone who can reach this port spends your Claude subscription.
server.listen(PORT, '127.0.0.1', () => {
  log('info', null, 'ready', `http://localhost:${PORT}  (Ctrl-C stops)`);
  spawnSpareProcess(spare_settings);
});
