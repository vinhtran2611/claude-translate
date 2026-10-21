// Runs one `claude -p` request for any feature: the safe flags, the stream-json reading, first-token fallback,
// stall timeout, API retries and quota logging. What the reply text means is the caller's business.
import { spawn, type ChildProcess } from 'node:child_process';
import type { Effort, EffortOption, ErrorKind, ModelOption } from '../api.ts';
import { formatCount, formatSeconds, formatWeekdayTime, lastLines, log, LOG_DETAIL_MAX_LINES, type LogLevel } from './log.ts';
import { APP_DIRECTORY } from './paths.ts';

// fallback_model_id: the model a first run hands over to when this one sends no token within SWITCH_TO_FALLBACK_AFTER_MS;
// null: the run waits LAST_MODEL_FIRST_TOKEN_TIMEOUT_MS, then fails.
export interface ModelConfig extends ModelOption {
  fallback_model_id: string | null;
}

// Menu order.
export const MODEL_OPTIONS: ModelConfig[] = [
  { model_id: 'claude-opus-5-5', label: 'Opus 5.5', short_label: 'Opus', description: "Best nuance and tone · 2× Sonnet's usage", fallback_model_id: 'claude-sonnet-5-5' },
  { model_id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', short_label: 'Sonnet', description: 'Natural and quick for everyday text', fallback_model_id: 'claude-haiku-5-5' },
  { model_id: 'claude-haiku-5-5', label: 'Haiku 5.5', short_label: 'Haiku', description: 'Fastest · a fraction of the usage', fallback_model_id: null },
];
// xhigh and max are left out: translation gains little from them, and they think longest and use the most.
export const EFFORT_OPTIONS: EffortOption[] = [
  { effort: 'low', label: 'Low', description: 'Thinks only when needed. Fastest.' },
  { effort: 'medium', label: 'Medium', description: 'Thinks through tricky passages.' },
  { effort: 'high', label: 'High', description: 'Thinks longest. Slowest, uses the most.' },
];
// What a page starts with before the person picks: the same for every feature.
export const DEFAULT_MODEL_ID = 'claude-sonnet-5-5';
export const DEFAULT_EFFORT: Effort = 'low';
export const MAX_OUTPUT_TOKENS = 128_000;
// A token is the start of a thinking block or any content delta. Even at --effort low the model may think first, for
// seconds on a long input, and its first summarized thinking_delta lags the block start by 1.4-1.9s (measured); only
// "no token at all" means stuck. The warm first token arrives in ~1-2s, so 10s without one hands over to the next
// model down.
const SWITCH_TO_FALLBACK_AFTER_MS = 10_000;
// Longer: the model taking over starts cold (~1.3s more), and nothing is left to fall back to.
const LAST_MODEL_FIRST_TOKEN_TIMEOUT_MS = 30_000;
// Arbitrary: a live reply never pauses this long between tokens, whether it is thinking or writing.
const STREAM_STALL_TIMEOUT_MS = 60_000;
// Arbitrary: a 5-point step shows the climb towards the limit without a quota line on every request.
const QUOTA_LOG_STEP_PERCENT = 5;
const QUOTA_WINDOW_LABELS: Record<string, string> = { five_hour: '5h', seven_day: '7d' };
const QUOTA_STATUS_LABELS: Record<string, string> = { allowed: 'ok', allowed_warning: 'warning', rejected: 'rejected' };
const QUOTA_STATUS_LOG_LEVELS: Record<string, LogLevel> = { allowed: 'info', allowed_warning: 'warn', rejected: 'error' };

// What a claude process is started with; all three are fixed for its lifetime.
export interface ClaudeSettings {
  model_id: string;
  effort: Effort;
  system_prompt: string;
}

// The rate_limit_info a stream-json reply carries.
export interface RateLimitInfo {
  status: string;
  rateLimitType?: string;
  utilization?: number;
  resetsAt?: number;
  isUsingOverage?: boolean;
}

// The stream-json lines claude prints, only as far as this runner reads them.
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

// Every reply repeats the rate-limit state, so only a change of quotaLogKey is worth a line.
let last_logged_quota_key = 'allowed';
// The latest rate_limit_info any reply carried; null until the first reply.
let last_rate_limit_info: RateLimitInfo | null = null;

export function lastRateLimitInfo(): RateLimitInfo | null {
  return last_rate_limit_info;
}

// undefined for an id no longer offered (a history row can name one).
export function modelOptionOf(model_id: string | undefined): ModelConfig | undefined {
  return MODEL_OPTIONS.find((option) => option.model_id === model_id);
}

export function modelLabelOf(model_id: string): string {
  return modelOptionOf(model_id)?.label ?? model_id;
}

export function isEffort(effort: unknown): effort is Effort {
  return EFFORT_OPTIONS.some((option) => option.effort === effort);
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

// The kind of a stream-json line, for the log: 'system/init', 'content_block_delta:text_delta', 'message_start'.
function eventKindOf(message: ClaudeMessage): string {
  if (message.subtype) return `${message.type}/${message.subtype}`;
  const stream_event = message.type === 'stream_event' ? message.event : undefined;
  const delta_type = stream_event?.type === 'content_block_delta' ? stream_event.delta?.type : undefined;
  if (delta_type) return `${stream_event?.type}:${delta_type}`;
  return message.event?.type ?? message.type;
}

// --setting-sources "" keeps ~/.claude/CLAUDE.md, skills and plugins out of the
// context (measured 5982 -> 666 input tokens); --bare would also do that but drops the subscription login.
export function spawnClaudeProcess({ model_id, effort, system_prompt }: ClaudeSettings) {
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
      '--system-prompt', system_prompt,
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

export type ClaudeProcess = ReturnType<typeof spawnClaudeProcess>;

export function stopProcess(claude_process: ChildProcess): void {
  if (claude_process.exitCode !== null || claude_process.signalCode !== null) return;
  claude_process.kill('SIGINT');
  // A process stuck on the network may ignore SIGINT; without this it would linger forever.
  setTimeout(() => {
    if (claude_process.exitCode === null && claude_process.signalCode === null) claude_process.kill('SIGKILL');
  }, 3000);
}

export interface RunError {
  error_kind: ErrorKind;
  message: string;
}

// What a run reports. After onDone or onError nothing more arrives.
export interface RunHandlers {
  onThinkingDelta?(text: string): void;
  onThinkingDone?(duration_ms: number): void;
  onText?(text: string): void;
  onRetry?(retry: { attempt: number; max_retries: number; error: string }): void;
  onFallback?(fallback: { from_model_id: string; to_model_id: string }): void;
  // The result message arrived, just before onDone or onError; output_tokens is null when it named none.
  onResultMessage?(output_tokens: number | null): void;
  onDone(reply_text: string): void;
  // error goes to the page; failure_text (one line) and failure_detail_lines (e.g. a stderr tail) go to the log only.
  onError(error: RunError, failure_text: string, failure_detail_lines: string[]): void;
}

export interface RunOptions {
  // The log's request number; null for a line that belongs to no request.
  request_number: number | null;
  settings: ClaudeSettings;
  user_message: string;
  // Added to both first-token limits: reading a long input delays the first token.
  first_token_allowance_ms?: number;
  // A warm spare started with the same settings; otherwise a new process starts.
  claude_process?: ClaudeProcess;
  handlers: RunHandlers;
}

export interface Run {
  // The model of the run that reports: the requested one, or its fallback.
  served_model_id(): string;
  // Ends the run without another report; the process is stopped unless its result already arrived.
  stop(): void;
}

// One request: the requested model, and at most one hand-over to the next model down when it sends no first token.
export function runClaude({ request_number, settings, user_message, first_token_allowance_ms = 0, claude_process, handlers }: RunOptions): Run {
  const { effort, system_prompt } = settings;
  const user_message_line = `${JSON.stringify({ type: 'user', message: { role: 'user', content: user_message } })}\n`;
  // Only the run in current_process may report; a superseded run's late output is dropped.
  let current_process: ClaudeProcess | null = null;
  let served_model_id = settings.model_id;
  let has_result = false;
  let is_finished = false;
  let reply_text = '';

  const finishDone = (): void => {
    if (is_finished) return;
    is_finished = true;
    handlers.onDone(reply_text);
  };
  // A timeout leaves the process running, so it is stopped here, not left to the caller.
  const finishError = (error: RunError, failure_text: string, failure_detail_lines: string[] = []): void => {
    if (is_finished) return;
    is_finished = true;
    if (!has_result && current_process !== null) stopProcess(current_process);
    handlers.onError(error, failure_text, failure_detail_lines);
  };

  // is_first_run: the run for the requested model; only it may hand over, so a request switches model at most once.
  function runModel(model_id: string, run_process: ClaudeProcess, is_first_run: boolean): void {
    current_process = run_process;
    served_model_id = model_id;
    const fallback_model_id = is_first_run ? modelOptionOf(model_id)?.fallback_model_id ?? null : null;
    const isCurrent = () => current_process === run_process && !is_finished;
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

    // The caller picks its wording from error_kind.
    const stopForTimeout = (error_kind: ErrorKind, reason: string): void => {
      if (!isCurrent()) return;
      finishError({ error_kind, message: `${modelLabelOf(model_id)} ${reason}.` }, `${reason}, last_event=${last_event_kind}`);
    };
    const switchToFallback = (): void => {
      if (!isCurrent() || fallback_model_id === null) return;
      log(
        'warn', request_number, 'fallback',
        `${modelLabelOf(model_id)} sent no token within ${formatSeconds(switch_to_fallback_after_ms)}, last_event=${last_event_kind} ` +
          `-> ${modelLabelOf(fallback_model_id)}`,
      );
      handlers.onFallback?.({ from_model_id: model_id, to_model_id: fallback_model_id });
      stopProcess(run_process);
      // The same effort: falling back is about getting an answer at all, not about how deeply to think.
      runModel(fallback_model_id, spawnClaudeProcess({ model_id: fallback_model_id, effort, system_prompt }), false);
    };
    // The one timer of a run: until the first token it decides fallback, or failure when there is nothing to fall
    // back to; after that, every token re-arms it as a stall timeout.
    const switch_to_fallback_after_ms = SWITCH_TO_FALLBACK_AFTER_MS + first_token_allowance_ms;
    const last_model_first_token_timeout_ms = LAST_MODEL_FIRST_TOKEN_TIMEOUT_MS + first_token_allowance_ms;
    const failForNoToken = (): void => {
      stopForTimeout('no_response', `sent nothing within ${formatSeconds(last_model_first_token_timeout_ms)}`);
    };
    let token_timer: ReturnType<typeof setTimeout>;
    if (fallback_model_id === null) token_timer = setTimeout(failForNoToken, last_model_first_token_timeout_ms);
    else token_timer = setTimeout(switchToFallback, switch_to_fallback_after_ms);
    const clearTimers = () => clearTimeout(token_timer);

    // A write to a process that just died raises EPIPE here; 'close' below reports the failure.
    run_process.stdin.on('error', () => {});
    run_process.stdin.end(user_message_line);

    // The process takes ~1.5s more to exit after its result; the run ends without waiting.
    const handleResult = (message: ClaudeMessage): void => {
      has_result = true;
      clearTimers();
      handlers.onResultMessage?.(message.usage?.output_tokens ?? null);
      if (last_stop_reason === 'max_tokens') {
        const limit_message = `The reply reached the ${formatCount(MAX_OUTPUT_TOKENS)}-token output limit and was cut off.`;
        finishError({ error_kind: 'output_limit', message: limit_message }, `stop_reason=max_tokens after claude's continuations`);
      } else if (message.is_error) {
        const result_text = String(message.result ?? message.subtype);
        const status_note = message.api_error_status ? ` (${message.api_error_status})` : '';
        finishError({ error_kind: 'claude_error', message: result_text }, `${result_text}${status_note}`);
      } else {
        finishDone();
      }
    };

    const logRetry = (message: ClaudeMessage): void => {
      const status_note = message.error_status ? ` (${message.error_status})` : '';
      const next_note = `next in ${formatSeconds(message.retry_delay_ms ?? 0)}`;
      log('warn', request_number, 'retry', `${message.attempt}/${message.max_retries} ${message.error}${status_note}, ${next_note}`);
    };

    // Every reply repeats the rate-limit state; a line is logged only when it reads differently.
    const noteRateLimit = (rate_limit_info: RateLimitInfo): void => {
      last_rate_limit_info = rate_limit_info;
      const quota_key = quotaLogKey(rate_limit_info);
      if (quota_key === last_logged_quota_key) return;
      last_logged_quota_key = quota_key;
      log(QUOTA_STATUS_LOG_LEVELS[rate_limit_info.status] ?? 'warn', null, 'quota', formatQuota(rate_limit_info));
    };

    const handleMessage = (message: ClaudeMessage): void => {
      const stream_event = message.type === 'stream_event' ? message.event : undefined;
      const stream_event_type = stream_event?.type;
      // delta_type: 'thinking_delta' | 'signature_delta' | 'text_delta', or undefined for any other event.
      const delta_type = stream_event_type === 'content_block_delta' ? stream_event?.delta?.type : undefined;
      const is_thinking_start = stream_event_type === 'content_block_start' && stream_event?.content_block?.type === 'thinking';
      last_event_kind = eventKindOf(message);
      if (delta_type !== undefined || is_thinking_start) {
        // A token: from now on, the timer waits for the next one.
        clearTimeout(token_timer);
        const stall_reason = `stopped streaming for ${STREAM_STALL_TIMEOUT_MS / 1000}s`;
        token_timer = setTimeout(() => stopForTimeout('stalled', stall_reason), STREAM_STALL_TIMEOUT_MS);
      }

      if (is_thinking_start) {
        open_thinking_block_index = stream_event?.index ?? null;
        thinking_started_at = Date.now();
      } else if (delta_type === 'thinking_delta' && stream_event?.delta?.thinking) {
        handlers.onThinkingDelta?.(stream_event.delta.thinking);
      } else if (stream_event_type === 'content_block_stop' && stream_event?.index === open_thinking_block_index) {
        open_thinking_block_index = null;
        handlers.onThinkingDone?.(Date.now() - thinking_started_at);
      } else if (delta_type === 'text_delta') {
        const text = stream_event?.delta?.text ?? '';
        reply_text += text;
        handlers.onText?.(text);
      } else if (stream_event_type === 'message_delta') {
        last_stop_reason = stream_event?.delta?.stop_reason ?? null;
      } else if (message.type === 'user' && last_stop_reason === 'max_tokens') {
        const limit_text = `${formatCount(MAX_OUTPUT_TOKENS)} output tokens`;
        log('warn', request_number, 'continue', `${modelLabelOf(model_id)} hit ${limit_text}; claude asked it to continue`);
      } else if (message.type === 'system' && message.subtype === 'api_retry') {
        logRetry(message);
        handlers.onRetry?.({ attempt: message.attempt ?? 0, max_retries: message.max_retries ?? 0, error: message.error ?? '' });
      } else if (message.type === 'rate_limit_event' && message.rate_limit_info !== undefined) {
        noteRateLimit(message.rate_limit_info);
      } else if (message.type === 'result') {
        handleResult(message);
      }
    };

    run_process.stderr.on('data', (chunk) => {
      stderr_text += chunk;
    });
    // stdout is one JSON message per line; a chunk can end in the middle of a line.
    run_process.stdout.on('data', (chunk) => {
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
        handleMessage(message);
      }
    });

    run_process.on('error', (error) => {
      clearTimers();
      if (!isCurrent()) return;
      finishError({ error_kind: 'start_failed', message: `Cannot start claude: ${error.message}` }, error.message);
    });
    run_process.on('close', (exit_code, signal) => {
      clearTimers();
      if (!isCurrent() || has_result) return;
      finishError(
        { error_kind: 'exited', message: stderr_text.trim() || `claude exited with code ${exit_code}` },
        `${signal ? `killed by ${signal}` : `exit code ${exit_code}`}, last_event=${last_event_kind}`,
        lastLines(stderr_text, LOG_DETAIL_MAX_LINES),
      );
    });
  }

  runModel(settings.model_id, claude_process ?? spawnClaudeProcess(settings), true);

  return {
    served_model_id: () => served_model_id,
    stop() {
      is_finished = true;
      if (!has_result && current_process !== null) stopProcess(current_process);
    },
  };
}
