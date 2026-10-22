// The HTTP API types more than one feature uses: the model and effort options, the error kinds of a `claude -p` run,
// the translated pair the Markdown renderer draws, and the one error shape of a JSON API. Types only: every file
// imports it with `import type`, so it is erased before anything runs and never reaches the browser.

export type Effort = 'low' | 'medium' | 'high';
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
