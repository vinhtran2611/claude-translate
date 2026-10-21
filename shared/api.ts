// The HTTP contract between server/server.ts and web/app.ts (see README "API"), and the data model's shared types
// (docs/data-model-proposal.md §3.3). Types only: both sides import it with `import type`, so it is erased before
// anything runs and never reaches the browser.

// ---- Shared types of the data model ----

// ISO 8601 UTC with milliseconds, as Date.prototype.toISOString writes it: "2026-10-21T08:30:00.000Z".
export type Timestamp = string;
export type Language = 'en' | 'vi';
// Every value the CLI takes; a page offers only some of them (EFFORT_OPTIONS in shared/server/claude-runner.ts).
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
// "claude-sonnet-5-5"
export type ModelId = string;
// Sets the size limit of an answer.
export type TextLength = 'sentence' | 'paragraph' | 'multi_paragraph';

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

// Why a `claude -p` run failed, as shared/server/claude-runner.ts reports it.
export type ErrorKind = 'start_failed' | 'no_response' | 'stalled' | 'output_limit' | 'exited' | 'claude_error';

export type RunErrorCode =
  | ErrorKind
  // The model answered with no text.
  | 'empty_reply'
  // English check: the reply had no check block.
  | 'no_check_block'
  // The server stopped during the run.
  | 'interrupted';

// One call to a model. A Grading, a Translation and an EnglishCheck each hold one, as `run`.
// The rules (the same for every run):
//   running:           finishedAt null, no error, the output is not there yet or is partial;
//   succeeded:         finishedAt set, no error, the output is complete;
//   failed, cancelled: finishedAt set, errorCode and errorMessage set for failed only, the output is missing or partial.
// The row is saved when the run starts and updated when it ends. When the server starts, every running row becomes
// failed with 'interrupted'.
export interface ModelRun {
  status: RunStatus;
  // null only for an EnglishCheck: the app does not choose the model there.
  requestedModelId: ModelId | null;
  // Differs from the requested one after a fallback; null while it is not known yet.
  servedModelId: ModelId | null;
  // null only for an EnglishCheck.
  effort: Effort | null;
  // null when the model did not think.
  thinkingText: string | null;
  thinkingMs: number | null;
  errorCode: RunErrorCode | null;
  errorMessage: string | null;
  startedAt: Timestamp;
  finishedAt: Timestamp | null;
}

// ---- Translate: the live request and its stream ----

export type Mode = 'translate' | 'translate_markdown';
export type Outcome = 'done' | 'error' | 'cancelled';
export type PairType = 'heading' | 'paragraph' | 'list_item' | 'table' | 'code' | 'quote' | 'other';

// One unit of the input and its translation, as the model streams it. Stored, it becomes a TranslatedBlock.
export interface Pair {
  pair_type: PairType;
  level: number;
  marker: string;
  source_text: string;
  translation_text: string;
}

export interface ModelOption {
  model_id: string;
  label: string;
  short_label: string;
  description: string;
}

export interface EffortOption {
  effort: Effort;
  label: string;
  description: string;
}

export interface ModeOption {
  mode: Mode;
  label: string;
  description: string;
}

// The latest reply's rate limit, when it warns or rejects.
export interface QuotaWarning {
  status: string;
  rate_limit_type: string | undefined;
  utilization: number | undefined;
  resets_at: number | undefined;
}

// GET /translation-options
export interface TranslationOptions {
  models: ModelOption[];
  efforts: EffortOption[];
  modes: ModeOption[];
  default_model_id: string;
  default_effort: Effort;
  default_mode: Mode;
  quota_warning: QuotaWarning | null;
}

// POST /translate body.
export interface TranslateRequest {
  source_language: Language;
  target_language: Language;
  text: string;
  model_id: string;
  effort: Effort;
  mode: Mode;
}

// POST /translate response: one Server-Sent Event per entry, `event: <name>` and `data: <JSON>`.
export interface StreamEvents {
  pair_start: { pair_index: number; pair_type: PairType; level: number; marker: string };
  source_delta: { pair_index: number; text: string };
  translation_delta: { pair_index: number; text: string };
  // Reply text outside any pair.
  unpaired_delta: { text: string };
  retry: { attempt: number; max_retries: number; error: string };
  thinking_delta: { text: string };
  thinking_done: { duration_ms: number };
  fallback: { from_model_id: string; to_model_id: string };
  done: { duration_ms: number; served_model_id: string; effort: Effort; is_fallback: boolean; history_id: number | null };
  error: {
    error_kind: ErrorKind; message: string; served_model_id: string; effort: Effort; is_fallback: boolean; history_id: number | null;
  };
}

export type StreamEventName = keyof StreamEvents;

// One event as [name, data], with data typed by name: switching on the name narrows the data.
export type StreamEvent = { [Name in StreamEventName]: [Name, StreamEvents[Name]] }[StreamEventName];

// GET /history, newest first. effort is a string: the database accepts every CLI effort, not only the offered ones.
export interface HistorySummary {
  id: number;
  created_at: string;
  source_language: Language;
  target_language: Language;
  outcome: Outcome;
  served_model_id: string;
  requested_model_id: string;
  effort: string;
  mode: Mode;
  input_preview: string;
  output_preview: string;
}

// GET /history/:id. input_text is what was pasted; in mode translate_markdown pairs[].source_text is the tidied form.
export interface HistoryEntry extends Omit<HistorySummary, 'input_preview' | 'output_preview'> {
  input_text: string;
  pairs: Pair[];
  unpaired_text: string;
  duration_ms: number;
  is_fallback: boolean;
  // '' and null when the model did not think.
  thinking_text: string;
  thinking_duration_ms: number | null;
}

// One problem of a rejected request. path is a JSON Pointer into the body ("/exercises/5/content/options"), "?name" for a
// query parameter, "#key" for the key in the URL. code is stable: programs switch on it.
export interface ApiProblem {
  path: string;
  code: string;
  message: string;
}

// The body of every non-2xx JSON API answer (docs/practice-api-design.md §3.3). problems is only there for code "invalid".
export interface ApiErrorBody {
  error: { code: string; message: string; problems?: ApiProblem[] };
}
