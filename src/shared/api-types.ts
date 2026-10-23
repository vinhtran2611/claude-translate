// The HTTP API types more than one feature uses: the data model's shared types and the model run
// (docs/data-model-proposal.md §3.3), the model and effort options, the error kinds of a `claude -p` run, the translated
// pair the Markdown renderer draws, and the one error shape of a JSON API. Types only: every file imports it with
// `import type`, so it is erased before anything runs and never reaches the browser.

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
export type CliErrorCode = 'start_failed' | 'no_response' | 'stalled' | 'output_limit' | 'exited' | 'claude_error';

export type RunErrorCode =
  | CliErrorCode
  // The model answered with no text.
  | 'empty_reply'
  // English check: the reply had no check block.
  | 'no_check_block'
  // Practice generation: the reply was not the JSON asked for, or too few of its exercises passed the check.
  | 'invalid_reply'
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

// ---- Options, pairs and errors ----

export type BlockType = 'heading' | 'paragraph' | 'list_item' | 'table' | 'code' | 'quote' | 'other';

// One heading, paragraph or list item next to its translation (docs/data-model-proposal.md §3.5), as the model returns it
// and as a Translation stores it. Shared because the Markdown renderer draws it.
export interface TranslatedBlock {
  blockType: BlockType;
  // Heading or list depth; 0 when none.
  level: number;
  // A list marker: "-", "1.".
  marker: string | null;
  // With the 'markdown' source format, the repaired text.
  sourceText: string;
  translatedText: string;
}

// ---- Practice from a translation (docs/practice-from-translation-design.md) ----
// Shared because two features read them: the Translate page sends the request, the Practice server answers it.

// One block of the post: the English and the owner's Vietnamese.
export interface GenerationBlock {
  sourceText: string;
  translatedText: string;
}

// POST /api/practice/generations: make a Practice project from a finished en->vi translation.
export interface GenerationRequest {
  // The translation's id in Translate's history.
  translationId: number;
  title: string;
  // Only 'en' is accepted.
  sourceLanguage: Language;
  blocks: GenerationBlock[];
}

// One generation: a model run that writes a project from a post. Its post is kept on the server, for Try again.
export interface GenerationDetail {
  id: number;
  translationId: number;
  title: string;
  // The number of exercises asked for.
  targetCount: number;
  // The project it made: null until it succeeds, and again once that project is deleted.
  projectKey: string | null;
  // The exercises left out because they failed the check; null until it succeeds.
  droppedCount: number | null;
  run: ModelRun;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface ModelOption {
  modelId: string;
  label: string;
  shortLabel: string;
  description: string;
}

export interface EffortOption {
  effort: Effort;
  label: string;
  description: string;
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
