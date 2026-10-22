// Runs one `claude -p` request for any feature: the safe flags, the stream-json reading, first-token fallback,
// stall timeout, API retries and quota logging. What the reply text means is the caller's business.
import { spawn, type ChildProcess } from 'node:child_process';
import type { Effort, EffortOption, CliErrorCode, ModelOption } from '../api-types.ts';
import { formatCount, formatSeconds, formatWeekdayTime, lastLines, log, LOG_DETAIL_MAX_LINES, type LogLevel } from './log.ts';
import { APP_DIRECTORY } from './paths.ts';

// fallbackModelId: the model a first run hands over to when this one sends no token within SWITCH_TO_FALLBACK_AFTER_MS;
// null: the run waits LAST_MODEL_FIRST_TOKEN_TIMEOUT_MS, then fails.
export interface ModelConfig extends ModelOption {
  fallbackModelId: string | null;
}

// Menu order.
export const MODEL_OPTIONS: ModelConfig[] = [
  { modelId: 'claude-opus-5-5', label: 'Opus 5.5', shortLabel: 'Opus', description: "Best nuance and tone · 2× Sonnet's usage", fallbackModelId: 'claude-sonnet-5-5' },
  { modelId: 'claude-sonnet-5-5', label: 'Sonnet 5.5', shortLabel: 'Sonnet', description: 'Natural and quick for everyday text', fallbackModelId: 'claude-haiku-5-5' },
  { modelId: 'claude-haiku-5-5', label: 'Haiku 5.5', shortLabel: 'Haiku', description: 'Fastest · a fraction of the usage', fallbackModelId: null },
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
  modelId: string;
  effort: Effort;
  systemPrompt: string;
}

// The rateLimitInfo a stream-json reply carries.
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
let lastLoggedQuotaKey = 'allowed';
// The latest rateLimitInfo any reply carried; null until the first reply.
let latestRateLimitInfo: RateLimitInfo | null = null;

export function lastRateLimitInfo(): RateLimitInfo | null {
  return latestRateLimitInfo;
}

// undefined for an id no longer offered (a history row can name one).
export function modelOptionOf(modelId: string | undefined): ModelConfig | undefined {
  return MODEL_OPTIONS.find((option) => option.modelId === modelId);
}

export function modelLabelOf(modelId: string): string {
  return modelOptionOf(modelId)?.label ?? modelId;
}

export function isEffort(effort: unknown): effort is Effort {
  return EFFORT_OPTIONS.some((option) => option.effort === effort);
}

// Two rateLimitInfo values with the same key read the same in the log; while allowed, utilization is ignored.
function quotaLogKey(rateLimitInfo: RateLimitInfo): string {
  const { status, rateLimitType, utilization, isUsingOverage } = rateLimitInfo;
  if (status === 'allowed') return status;
  return `${status} ${rateLimitType} ${Math.floor(((utilization ?? 0) * 100) / QUOTA_LOG_STEP_PERCENT)} ${isUsingOverage}`;
}

function formatQuota(rateLimitInfo: RateLimitInfo): string {
  const { status, rateLimitType, utilization, resetsAt, isUsingOverage } = rateLimitInfo;
  const windowLabel = rateLimitType === undefined ? 'window unknown' : QUOTA_WINDOW_LABELS[rateLimitType] ?? rateLimitType;
  const percentText = typeof utilization === 'number' ? `${Math.round(utilization * 100)}%` : 'usage unknown';
  const fields = [`${windowLabel} ${percentText} (${QUOTA_STATUS_LABELS[status] ?? status})`];
  if (typeof resetsAt === 'number') fields.push(`resets ${formatWeekdayTime(new Date(resetsAt * 1000))}`);
  if (isUsingOverage === true) fields.push('overage in use');
  return fields.join(', ');
}

// The kind of a stream-json line, for the log: 'system/init', 'content_block_delta:text_delta', 'message_start'.
function eventKindOf(message: ClaudeMessage): string {
  if (message.subtype) return `${message.type}/${message.subtype}`;
  const streamEvent = message.type === 'stream_event' ? message.event : undefined;
  const deltaType = streamEvent?.type === 'content_block_delta' ? streamEvent.delta?.type : undefined;
  if (deltaType) return `${streamEvent?.type}:${deltaType}`;
  return message.event?.type ?? message.type;
}

// --setting-sources "" keeps ~/.claude/CLAUDE.md, skills and plugins out of the
// context (measured 5982 -> 666 input tokens); --bare would also do that but drops the subscription login.
export function spawnClaudeProcess({ modelId, effort, systemPrompt }: ClaudeSettings) {
  return spawn(
    'claude',
    [
      '-p',
      '--model', modelId,
      '--effort', effort,
      '--tools', '',
      '--setting-sources', '',
      '--disable-slash-commands',
      '--strict-mcp-config',
      '--no-session-persistence',
      '--system-prompt', systemPrompt,
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

export function stopProcess(claudeProcess: ChildProcess): void {
  if (claudeProcess.exitCode !== null || claudeProcess.signalCode !== null) return;
  claudeProcess.kill('SIGINT');
  // A process stuck on the network may ignore SIGINT; without this it would linger forever.
  setTimeout(() => {
    if (claudeProcess.exitCode === null && claudeProcess.signalCode === null) claudeProcess.kill('SIGKILL');
  }, 3000);
}

export interface RunError {
  errorCode: CliErrorCode;
  message: string;
}

// What a run reports. After onDone or onError nothing more arrives.
export interface RunHandlers {
  onThinkingDelta?(text: string): void;
  onThinkingDone?(durationMs: number): void;
  onText?(text: string): void;
  onRetry?(retry: { attempt: number; maxRetries: number; error: string }): void;
  onFallback?(fallback: { fromModelId: string; toModelId: string }): void;
  // The result message arrived, just before onDone or onError; outputTokens is null when it named none.
  onResultMessage?(outputTokens: number | null): void;
  onDone(replyText: string): void;
  // error goes to the page; failureText (one line) and failureDetailLines (e.g. a stderr tail) go to the log only.
  onError(error: RunError, failureText: string, failureDetailLines: string[]): void;
}

export interface RunOptions {
  // The log's request number; null for a line that belongs to no request.
  requestNumber: number | null;
  settings: ClaudeSettings;
  userMessage: string;
  // Added to both first-token limits: reading a long input delays the first token.
  firstTokenAllowanceMs?: number;
  // A warm spare started with the same settings; otherwise a new process starts.
  claudeProcess?: ClaudeProcess;
  handlers: RunHandlers;
}

export interface Run {
  // The model of the run that reports: the requested one, or its fallback.
  servedModelId(): string;
  // Ends the run without another report; the process is stopped unless its result already arrived.
  stop(): void;
}

// One request: the requested model, and at most one hand-over to the next model down when it sends no first token.
export function runClaude({ requestNumber, settings, userMessage, firstTokenAllowanceMs = 0, claudeProcess, handlers }: RunOptions): Run {
  const { effort, systemPrompt } = settings;
  const userMessageLine = `${JSON.stringify({ type: 'user', message: { role: 'user', content: userMessage } })}\n`;
  // Only the run in currentProcess may report; a superseded run's late output is dropped.
  let currentProcess: ClaudeProcess | null = null;
  let servedModelId = settings.modelId;
  let hasResult = false;
  let isFinished = false;
  let replyText = '';

  const finishDone = (): void => {
    if (isFinished) return;
    isFinished = true;
    handlers.onDone(replyText);
  };
  // A timeout leaves the process running, so it is stopped here, not left to the caller.
  const finishError = (error: RunError, failureText: string, failureDetailLines: string[] = []): void => {
    if (isFinished) return;
    isFinished = true;
    if (!hasResult && currentProcess !== null) stopProcess(currentProcess);
    handlers.onError(error, failureText, failureDetailLines);
  };

  // isFirstRun: the run for the requested model; only it may hand over, so a request switches model at most once.
  function runModel(modelId: string, runProcess: ClaudeProcess, isFirstRun: boolean): void {
    currentProcess = runProcess;
    servedModelId = modelId;
    const fallbackModelId = isFirstRun ? modelOptionOf(modelId)?.fallbackModelId ?? null : null;
    const isCurrent = () => currentProcess === runProcess && !isFinished;
    // The content-block index of the thinking block being streamed; null when none is open.
    let openThinkingBlockIndex: number | null = null;
    let thinkingStartedAt = 0;
    // The last kind of event this run produced, e.g. 'system/init' or 'message_start'.
    // A timeout log shows it, telling "claude never reached the API" apart from "the API sent nothing back".
    let lastEventKind = 'none';
    // The CLI answers a 'max_tokens' stop by asking the model to continue, up to 3 times, then ends with a success (if
    // only thinking was cut) or a generic error; only the last API message's stop_reason says the reply was cut off.
    let lastStopReason: string | null = null;
    let stdoutBuffer = '';
    let stderrText = '';

    // The caller picks its wording from errorCode.
    const stopForTimeout = (errorKind: CliErrorCode, reason: string): void => {
      if (!isCurrent()) return;
      finishError({ errorCode: errorKind, message: `${modelLabelOf(modelId)} ${reason}.` }, `${reason}, last_event=${lastEventKind}`);
    };
    const switchToFallback = (): void => {
      if (!isCurrent() || fallbackModelId === null) return;
      log(
        'warn', requestNumber, 'fallback',
        `${modelLabelOf(modelId)} sent no token within ${formatSeconds(switchToFallbackAfterMs)}, last_event=${lastEventKind} ` +
          `-> ${modelLabelOf(fallbackModelId)}`,
      );
      handlers.onFallback?.({ fromModelId: modelId, toModelId: fallbackModelId });
      stopProcess(runProcess);
      // The same effort: falling back is about getting an answer at all, not about how deeply to think.
      runModel(fallbackModelId, spawnClaudeProcess({ modelId: fallbackModelId, effort, systemPrompt }), false);
    };
    // The one timer of a run: until the first token it decides fallback, or failure when there is nothing to fall
    // back to; after that, every token re-arms it as a stall timeout.
    const switchToFallbackAfterMs = SWITCH_TO_FALLBACK_AFTER_MS + firstTokenAllowanceMs;
    const lastModelFirstTokenTimeoutMs = LAST_MODEL_FIRST_TOKEN_TIMEOUT_MS + firstTokenAllowanceMs;
    const failForNoToken = (): void => {
      stopForTimeout('no_response', `sent nothing within ${formatSeconds(lastModelFirstTokenTimeoutMs)}`);
    };
    let tokenTimer: ReturnType<typeof setTimeout>;
    if (fallbackModelId === null) tokenTimer = setTimeout(failForNoToken, lastModelFirstTokenTimeoutMs);
    else tokenTimer = setTimeout(switchToFallback, switchToFallbackAfterMs);
    const clearTimers = () => clearTimeout(tokenTimer);

    // A write to a process that just died raises EPIPE here; 'close' below reports the failure.
    runProcess.stdin.on('error', () => {});
    runProcess.stdin.end(userMessageLine);

    // The process takes ~1.5s more to exit after its result; the run ends without waiting.
    const handleResult = (message: ClaudeMessage): void => {
      hasResult = true;
      clearTimers();
      handlers.onResultMessage?.(message.usage?.output_tokens ?? null);
      if (lastStopReason === 'max_tokens') {
        const limitMessage = `The reply reached the ${formatCount(MAX_OUTPUT_TOKENS)}-token output limit and was cut off.`;
        finishError({ errorCode: 'output_limit', message: limitMessage }, `stop_reason=max_tokens after claude's continuations`);
      } else if (message.is_error) {
        const resultText = String(message.result ?? message.subtype);
        const statusNote = message.api_error_status ? ` (${message.api_error_status})` : '';
        finishError({ errorCode: 'claude_error', message: resultText }, `${resultText}${statusNote}`);
      } else {
        finishDone();
      }
    };

    const logRetry = (message: ClaudeMessage): void => {
      const statusNote = message.error_status ? ` (${message.error_status})` : '';
      const nextNote = `next in ${formatSeconds(message.retry_delay_ms ?? 0)}`;
      log('warn', requestNumber, 'retry', `${message.attempt}/${message.max_retries} ${message.error}${statusNote}, ${nextNote}`);
    };

    // Every reply repeats the rate-limit state; a line is logged only when it reads differently.
    const noteRateLimit = (rateLimitInfo: RateLimitInfo): void => {
      latestRateLimitInfo = rateLimitInfo;
      const quotaKey = quotaLogKey(rateLimitInfo);
      if (quotaKey === lastLoggedQuotaKey) return;
      lastLoggedQuotaKey = quotaKey;
      log(QUOTA_STATUS_LOG_LEVELS[rateLimitInfo.status] ?? 'warn', null, 'quota', formatQuota(rateLimitInfo));
    };

    const handleMessage = (message: ClaudeMessage): void => {
      const streamEvent = message.type === 'stream_event' ? message.event : undefined;
      const streamEventType = streamEvent?.type;
      // deltaType: 'thinking_delta' | 'signature_delta' | 'text_delta', or undefined for any other event.
      const deltaType = streamEventType === 'content_block_delta' ? streamEvent?.delta?.type : undefined;
      const isThinkingStart = streamEventType === 'content_block_start' && streamEvent?.content_block?.type === 'thinking';
      lastEventKind = eventKindOf(message);
      if (deltaType !== undefined || isThinkingStart) {
        // A token: from now on, the timer waits for the next one.
        clearTimeout(tokenTimer);
        const stallReason = `stopped streaming for ${STREAM_STALL_TIMEOUT_MS / 1000}s`;
        tokenTimer = setTimeout(() => stopForTimeout('stalled', stallReason), STREAM_STALL_TIMEOUT_MS);
      }

      if (isThinkingStart) {
        openThinkingBlockIndex = streamEvent?.index ?? null;
        thinkingStartedAt = Date.now();
      } else if (deltaType === 'thinking_delta' && streamEvent?.delta?.thinking) {
        handlers.onThinkingDelta?.(streamEvent.delta.thinking);
      } else if (streamEventType === 'content_block_stop' && streamEvent?.index === openThinkingBlockIndex) {
        openThinkingBlockIndex = null;
        handlers.onThinkingDone?.(Date.now() - thinkingStartedAt);
      } else if (deltaType === 'text_delta') {
        const text = streamEvent?.delta?.text ?? '';
        replyText += text;
        handlers.onText?.(text);
      } else if (streamEventType === 'message_delta') {
        lastStopReason = streamEvent?.delta?.stop_reason ?? null;
      } else if (message.type === 'user' && lastStopReason === 'max_tokens') {
        const limitText = `${formatCount(MAX_OUTPUT_TOKENS)} output tokens`;
        log('warn', requestNumber, 'continue', `${modelLabelOf(modelId)} hit ${limitText}; claude asked it to continue`);
      } else if (message.type === 'system' && message.subtype === 'api_retry') {
        logRetry(message);
        handlers.onRetry?.({ attempt: message.attempt ?? 0, maxRetries: message.max_retries ?? 0, error: message.error ?? '' });
      } else if (message.type === 'rate_limit_event' && message.rate_limit_info !== undefined) {
        noteRateLimit(message.rate_limit_info);
      } else if (message.type === 'result') {
        handleResult(message);
      }
    };

    runProcess.stderr.on('data', (chunk) => {
      stderrText += chunk;
    });
    // stdout is one JSON message per line; a chunk can end in the middle of a line.
    runProcess.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim() === '' || !isCurrent()) continue;
        let message: ClaudeMessage;
        try {
          message = JSON.parse(line) as ClaudeMessage;
        } catch {
          log('warn', requestNumber, 'stdout', `not JSON: ${line}`);
          continue;
        }
        handleMessage(message);
      }
    });

    runProcess.on('error', (error) => {
      clearTimers();
      if (!isCurrent()) return;
      finishError({ errorCode: 'start_failed', message: `Cannot start claude: ${error.message}` }, error.message);
    });
    runProcess.on('close', (exitCode, signal) => {
      clearTimers();
      if (!isCurrent() || hasResult) return;
      finishError(
        { errorCode: 'exited', message: stderrText.trim() || `claude exited with code ${exitCode}` },
        `${signal ? `killed by ${signal}` : `exit code ${exitCode}`}, last_event=${lastEventKind}`,
        lastLines(stderrText, LOG_DETAIL_MAX_LINES),
      );
    });
  }

  runModel(settings.modelId, claudeProcess ?? spawnClaudeProcess(settings), true);

  return {
    servedModelId: () => servedModelId,
    stop() {
      isFinished = true;
      if (!hasResult && currentProcess !== null) stopProcess(currentProcess);
    },
  };
}
