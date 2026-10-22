// The HTTP contract between server/routes.ts and web/translate.ts (see docs/translate-internals.md "API"), and the stored
// Translation (docs/data-model-proposal.md §3.5). Types only: both sides import it with `import type`, so it is erased
// before anything runs and never reaches the browser.
import type {
  Effort, EffortOption, ErrorKind, Language, ModelOption, ModelRun, PairType, Timestamp,
} from '../../shared/api-types.ts';

// Language is one of the data model's shared types; it is named here too, where Translate's files look for it.
export type { Language };
export type Mode = 'translate' | 'translate_markdown';
export type Outcome = 'done' | 'error' | 'cancelled';

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

// POST /translate response: one Server-Sent Event per entry, `event: <name>` and `data: <JSON>`. The live stream keeps its
// snake_case fields: it is the protocol of a running request, not the stored model.
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

// ---- The stored translation ----

// 'markdown' also repairs broken layout (the 'translate_markdown' mode); 'plain_text' keeps the text as pasted.
export type SourceFormat = 'plain_text' | 'markdown';
export type BlockType = PairType;

// One translate run. The row is saved when the run starts and updated when it ends, whatever the outcome.
export interface Translation {
  id: number;
  sourceLanguage: Language;
  targetLanguage: Language;
  sourceFormat: SourceFormat;
  // Exactly what was pasted.
  sourceText: string;
  // The output.
  blocks: TranslatedBlock[];
  // Reply text the model put in no block.
  textOutsideBlocks: string | null;
  run: ModelRun;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// One heading, paragraph or list item next to its translation.
export interface TranslatedBlock {
  blockType: BlockType;
  // Heading or list depth; 0 when none.
  level: number;
  // A list marker: "-", "1.".
  marker: string | null;
  // With 'markdown', the repaired text.
  sourceText: string;
  translatedText: string;
}

// GET /history, newest first: a translation without its texts, with a preview of each side (worked out when read).
export interface TranslationSummary extends Omit<Translation, 'sourceText' | 'blocks' | 'textOutsideBlocks'> {
  sourcePreview: string;
  outputPreview: string;
}
