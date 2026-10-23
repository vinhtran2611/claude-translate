// The HTTP contract between server/routes.ts and web/translate.ts (see docs/translate-internals.md "API"), and the stored
// Translation (docs/data-model-proposal.md §3.5). Types only: both sides import it with `import type`, so it is erased
// before anything runs and never reaches the browser.
import type {
  BlockType, CliErrorCode, Effort, EffortOption, Language, ModelOption, ModelRun, Timestamp, TranslatedBlock,
} from '../../shared/api-types.ts';

// Language and TranslatedBlock are shared types of the data model; they are named here too, where Translate's files look.
export type { Language, TranslatedBlock };
export type Outcome = 'done' | 'error' | 'cancelled';

// 'markdown' also repairs broken layout before it translates; 'plain_text' keeps the text as pasted.
export type SourceFormat = 'plain_text' | 'markdown';

// One choice of the source format menu.
export interface SourceFormatOption {
  sourceFormat: SourceFormat;
  label: string;
  description: string;
}

// The latest reply's rate limit, when it warns or rejects.
export interface QuotaWarning {
  status: string;
  rateLimitType: string | undefined;
  utilization: number | undefined;
  resetsAt: number | undefined;
}

// GET /translation-options
export interface TranslationOptions {
  models: ModelOption[];
  efforts: EffortOption[];
  sourceFormats: SourceFormatOption[];
  defaultModelId: string;
  defaultEffort: Effort;
  defaultSourceFormat: SourceFormat;
  quotaWarning: QuotaWarning | null;
}

// POST /translate body.
export interface TranslateRequest {
  sourceLanguage: Language;
  targetLanguage: Language;
  sourceText: string;
  modelId: string;
  effort: Effort;
  sourceFormat: SourceFormat;
}

// POST /translate response: one Server-Sent Event per entry, `event: <name>` and `data: <JSON>`. Event names are lowercase
// snake_case values; their data is camelCase, in the words of the stored Translation (a block, its blockIndex...).
// translationId names the saved Translation (saved when the run starts); null only when saving it failed.
export interface StreamEvents {
  block_start: { blockIndex: number; blockType: BlockType; level: number; marker: string | null };
  source_delta: { blockIndex: number; text: string };
  translation_delta: { blockIndex: number; text: string };
  // Reply text outside any block: it becomes the Translation's textOutsideBlocks.
  outside_text_delta: { text: string };
  retry: { attempt: number; maxRetries: number; error: string };
  thinking_delta: { text: string };
  thinking_done: { durationMs: number };
  fallback: { fromModelId: string; toModelId: string };
  done: { durationMs: number; servedModelId: string; effort: Effort; isFallback: boolean; translationId: number | null };
  error: {
    errorCode: CliErrorCode; message: string; servedModelId: string; effort: Effort; isFallback: boolean; translationId: number | null;
  };
}

export type StreamEventName = keyof StreamEvents;

// One event as [name, data], with data typed by name: switching on the name narrows the data.
export type StreamEvent = { [Name in StreamEventName]: [Name, StreamEvents[Name]] }[StreamEventName];

// ---- The stored translation ----

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

// GET /history, newest first: a translation without its texts, with a preview of each side (worked out when read).
export interface TranslationSummary extends Omit<Translation, 'sourceText' | 'blocks' | 'textOutsideBlocks'> {
  sourcePreview: string;
  outputPreview: string;
}
