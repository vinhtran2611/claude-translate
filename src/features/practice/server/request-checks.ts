// Small helpers the Practice routes share: reading a JSON body, checking query parameters, and the error answers.
// Each check adds what is wrong to a list of problems, so one answer can name every problem at once.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readRequestJson, sendError } from '../../../shared/server/http.ts';
import { KEY_PATTERN, type Problem } from '../import-check.ts';

// A PUT of one exercise or project, or a rename or move; the longest exercise is far below it.
export const MAX_EXERCISE_BODY_BYTES = 200_000;
// ?dry_run=false or ?dry_run=true.
export const DRY_RUN = ['false', 'true'] as const;

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isWholeNumber(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 0;
}

// 400 invalid with every problem.
export function sendProblems(res: ServerResponse, problems: Problem[]): void {
  const message = problems.length === 1 ? 'The request has 1 problem.' : `The request has ${problems.length} problems.`;
  sendError(res, 400, 'invalid', message, problems);
}

export function notFound(res: ServerResponse, what: string): void {
  sendError(res, 404, 'not_found', `No such ${what}.`);
}

// 409 key_taken: a rename or a move would give a key that is already used.
export function keyTaken(res: ServerResponse, message: string): void {
  sendError(res, 409, 'key_taken', message);
}

// The body as an object, or null with the error already sent. fields: the ones it may have; any other is a problem.
export async function readObjectBody(
  req: IncomingMessage, res: ServerResponse, max_bytes: number, fields?: string[],
): Promise<Record<string, unknown> | null> {
  const body = await readRequestJson(req, res, max_bytes);
  if (body === undefined) return null;
  if (!isObject(body)) {
    sendProblems(res, [{ path: '', code: 'wrong_type', message: 'The body must be a JSON object.' }]);
    return null;
  }
  const unknown_fields = fields === undefined ? [] : Object.keys(body).filter((key) => !fields.includes(key));
  if (unknown_fields.length === 0) return body;
  const problems = unknown_fields.map((key) => ({ path: `/${key}`, code: 'unknown_field', message: `${key} is not a known field.` }));
  sendProblems(res, problems);
  return null;
}

// The body of a rename or a move: an object with one field that holds a key. null with the error already sent.
// problems: the ones found before the body (a bad query), sent together with the body's.
export async function readKeyBody(req: IncomingMessage, res: ServerResponse, field: string, problems: Problem[]): Promise<string | null> {
  const body = await readObjectBody(req, res, MAX_EXERCISE_BODY_BYTES, [field]);
  if (body === null) return null;
  const value = body[field];
  const path = `/${field}`;
  if (value === undefined) {
    problems.push({ path, code: 'required', message: `${field} is missing.` });
  } else if (typeof value !== 'string') {
    problems.push({ path, code: 'wrong_type', message: `${field} must be a key, like m1-day-01.` });
  } else if (!KEY_PATTERN.test(value)) {
    problems.push({ path, code: 'bad_key', message: `${field} must be 1 to 64 of a-z, 0-9 and -, not starting with -.` });
  }
  if (problems.length > 0) {
    sendProblems(res, problems);
    return null;
  }
  return value as string;
}

// ?name as one of `values` (its first when it is left out); a problem otherwise.
export function choiceParam<Value extends string>(query: URLSearchParams, name: string, values: readonly Value[], problems: Problem[]): Value {
  const value = query.get(name) ?? values[0];
  if (values.includes(value as Value)) return value as Value;
  problems.push({ path: `?${name}`, code: 'not_allowed', message: `${name} must be one of: ${values.join(', ')}.` });
  return values[0];
}

// Every query parameter the route does not take, as a problem: an agent's typo is never silently ignored.
export function unknownParameterProblems(query: URLSearchParams, parameters: string[]): Problem[] {
  const names = new Set(query.keys());
  const unknown_names = [...names].filter((name) => !parameters.includes(name));
  const takes = parameters.length > 0 ? ` (it takes ${parameters.join(', ')})` : '';
  return unknown_names.map((name) => ({ path: `?${name}`, code: 'unknown_parameter', message: `${name} is not a parameter here${takes}.` }));
}

// ?name as a whole number from min to max; null when it is left out. A problem otherwise.
export function wholeNumberParam(query: URLSearchParams, name: string, min: number, max: number, problems: Problem[]): number | null {
  const text = query.get(name);
  if (text === null) return null;
  const value = /^\d{1,15}$/.test(text) ? Number(text) : NaN;
  if (value >= min && value <= max) return value;
  const range = max === Number.MAX_SAFE_INTEGER ? `${min} up` : `${min} to ${max}`;
  problems.push({ path: `?${name}`, code: 'out_of_range', message: `${name} must be a whole number from ${range}.` });
  return null;
}
