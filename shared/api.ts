// The HTTP contract between server/server.ts and web/app.ts (see README "API"). Types only: both sides import it with
// `import type`, so it is erased before anything runs and never reaches the browser.

export type Language = 'en' | 'vi';
export type Effort = 'low' | 'medium' | 'high';
export type Mode = 'translate' | 'translate_markdown';
export type Outcome = 'done' | 'error' | 'cancelled';
export type PairType = 'heading' | 'paragraph' | 'list_item' | 'table' | 'code' | 'quote' | 'other';
export type ErrorKind = 'no_response' | 'stalled' | 'claude_error' | 'output_limit' | 'start_failed' | 'exited';

// One unit of the input and its translation, as the model returned it.
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
