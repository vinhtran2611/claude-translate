// The SQL side of the shared data model (docs/data-model-proposal.md §3.3 and §4): the CHECK of a time column, the
// run_* columns that store a ModelRun, and the mapping between those columns and a ModelRun. Every feature's store
// uses these, so a run is stored the same way everywhere.
import type { Effort, ModelRun, RunErrorCode, RunStatus } from '../api-types.ts';

export const RUN_STATUSES: RunStatus[] = ['running', 'succeeded', 'failed', 'cancelled'];
export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
export const RUN_ERROR_CODES: RunErrorCode[] = [
  'start_failed', 'no_response', 'stalled', 'output_limit', 'exited', 'claude_error', 'empty_reply', 'no_check_block', 'interrupted',
];

// "('a', 'b')": a list of texts for an IN (...) check. The values are the code's own constants, never user input.
export function sqlList(values: readonly string[]): string {
  const quoted = values.map((value) => `'${value}'`);
  return `(${quoted.join(', ')})`;
}

// The CHECK of a time column: ISO 8601 UTC, as new Date().toISOString() writes it. A nullable column may also be NULL.
export function timeCheck(column: string, isNullable = false): string {
  const format = `${column} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*Z'`;
  if (isNullable) return `CHECK (${column} IS NULL OR ${format})`;
  return `CHECK (${format})`;
}

// The columns every entity has: when it was made and when it was last written.
export const TIME_COLUMNS = `
    created_at TEXT NOT NULL ${timeCheck('created_at')},
    updated_at TEXT NOT NULL ${timeCheck('updated_at')}`;

// The run rules (ModelRun in shared/api-types.ts) as CHECKs. They are table constraints, so a CREATE TABLE puts them after
// all of its columns.
export const RUN_CHECKS = `
    CHECK ((run_status = 'running') = (run_finished_at IS NULL)),
    CHECK ((run_status = 'failed') = (run_error_code IS NOT NULL)),
    CHECK ((run_error_code IS NULL) = (run_error_message IS NULL))`;

// The run_* columns of a table that holds a ModelRun (with RUN_CHECKS after the table's columns). is_model_chosen: the
// app picks the model and effort (a translation), so they are never NULL; false for an English check (Claude Code picks
// them) and for a grading (old gradings may not know them).
export function runColumns(isModelChosen: boolean): string {
  const chosen = isModelChosen ? 'NOT NULL' : '';
  return `
    run_status             TEXT    NOT NULL CHECK (run_status IN ${sqlList(RUN_STATUSES)}),
    run_requested_model_id TEXT    ${chosen},
    run_served_model_id    TEXT,
    run_effort             TEXT    ${chosen} CHECK (run_effort IS NULL OR run_effort IN ${sqlList(EFFORTS)}),
    run_thinking_text      TEXT    CHECK (run_thinking_text IS NULL OR run_thinking_text <> ''),
    run_thinking_ms        INTEGER CHECK (run_thinking_ms IS NULL OR run_thinking_ms >= 0),
    run_error_code         TEXT    CHECK (run_error_code IS NULL OR run_error_code IN ${sqlList(RUN_ERROR_CODES)}),
    run_error_message      TEXT,
    run_started_at         TEXT    NOT NULL ${timeCheck('run_started_at')},
    run_finished_at        TEXT    ${timeCheck('run_finished_at', true)}`;
}

// The run_* columns as a row holds them.
export interface RunRow {
  run_status: RunStatus;
  run_requested_model_id: string | null;
  run_served_model_id: string | null;
  run_effort: Effort | null;
  run_thinking_text: string | null;
  run_thinking_ms: number | null;
  run_error_code: RunErrorCode | null;
  run_error_message: string | null;
  run_started_at: string;
  run_finished_at: string | null;
}

export function runOf(row: RunRow): ModelRun {
  return {
    status: row.run_status,
    requestedModelId: row.run_requested_model_id,
    servedModelId: row.run_served_model_id,
    effort: row.run_effort,
    thinkingText: row.run_thinking_text,
    thinkingMs: row.run_thinking_ms,
    errorCode: row.run_error_code,
    errorMessage: row.run_error_message,
    startedAt: row.run_started_at,
    finishedAt: row.run_finished_at,
  };
}

// A run as the named parameters of an INSERT or UPDATE ($run_status, $run_started_at...).
export function runRowOf(run: ModelRun): RunRow {
  return {
    run_status: run.status,
    run_requested_model_id: run.requestedModelId,
    run_served_model_id: run.servedModelId,
    run_effort: run.effort,
    run_thinking_text: run.thinkingText,
    run_thinking_ms: run.thinkingMs,
    run_error_code: run.errorCode,
    run_error_message: run.errorMessage,
    run_started_at: run.startedAt,
    run_finished_at: run.finishedAt,
  };
}

// The column list and the matching $parameters of the run_* columns, for an INSERT.
export const RUN_COLUMN_NAMES = [
  'run_status', 'run_requested_model_id', 'run_served_model_id', 'run_effort', 'run_thinking_text', 'run_thinking_ms',
  'run_error_code', 'run_error_message', 'run_started_at', 'run_finished_at',
];
export const RUN_INSERT_COLUMNS = RUN_COLUMN_NAMES.join(', ');
export const RUN_INSERT_VALUES = RUN_COLUMN_NAMES.map((name) => `$${name}`).join(', ');

// "run_status = $run_status, ...": an UPDATE's SET list for the parts of a run that change when it ends.
export const RUN_FINISH_SET = [
  'run_status', 'run_served_model_id', 'run_thinking_text', 'run_thinking_ms', 'run_error_code', 'run_error_message', 'run_finished_at',
].map((name) => `${name} = $${name}`).join(', ');

// An empty thinking summary is stored as NULL ("the model did not think").
export function thinkingTextOf(text: string): string | null {
  if (text === '') return null;
  return text;
}
