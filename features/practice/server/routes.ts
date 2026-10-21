// Practice's routes: the page at /practice and the API under /api/practice (docs/practice-api-design.md §3).
import { readdirSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_EFFORT, DEFAULT_MODEL_ID, EFFORT_OPTIONS, isEffort, MODEL_OPTIONS, modelOptionOf } from '../../../shared/server/claude-runner.ts';
import { readRequestJson, sendError, sendFile, sendJson, sendModule, type Feature } from '../../../shared/server/http.ts';
import { log } from '../../../shared/server/log.ts';
import type { AnswerByType, ApiIndex, Attempt, AttemptStatus, ExerciseItem, ExerciseType, GradingOptions, GradingSettings, RegradeRequest } from '../api.ts';
import {
  checkExerciseInput, checkImportValue, checkProjectInput, EXERCISE_TYPES, exerciseSchema, importSchema, KEY_PATTERN, keyProblems, MAX_EXERCISES,
  MAX_FILE_CHARS, type Problem,
} from '../import-check.ts';
import { createGrader } from './ai-grading.ts';
import { checkAnswer, graderOf, rateFlashcard } from './answers.ts';
import { openPracticeStore, type AttemptFilter, type PracticeStore } from './store.ts';

// features/practice/: this file is features/practice/server/routes.ts.
const FEATURE_DIRECTORY = dirname(dirname(fileURLToPath(import.meta.url)));
const WEB_DIRECTORY = join(FEATURE_DIRECTORY, 'web');
const DOCS_DIRECTORY = join(dirname(dirname(FEATURE_DIRECTORY)), 'docs');
// What the browser may fetch. Modules are served with their types stripped. Every .ts and .css under web/ is listed (so a
// new file needs no entry here), and so are the modules the server shares; URLs mirror the folders under features/practice/,
// so a relative import resolves the same for tsc and the browser.
const WEB_FILES = readdirSync(WEB_DIRECTORY, { recursive: true, encoding: 'utf8' }).filter((name) => /\.(ts|css)$/.test(name));
const MODULES = new Map([
  ...WEB_FILES.filter((name) => name.endsWith('.ts')).map((name): [string, string] => [`/practice/web/${name}`, join(WEB_DIRECTORY, name)]),
  ...['import-check.ts', 'text.ts'].map((name): [string, string] => [`/practice/${name}`, join(FEATURE_DIRECTORY, name)]),
]);
const FILES = new Map([
  ['/practice', { path: join(WEB_DIRECTORY, 'practice.html'), content_type: 'text/html; charset=utf-8' }],
  ...WEB_FILES.filter((name) => name.endsWith('.css')).map((name) => [`/practice/web/${name}`, { path: join(WEB_DIRECTORY, name), content_type: 'text/css; charset=utf-8' }] as const),
  ['/practice/example-project.json', { path: join(FEATURE_DIRECTORY, 'examples', 'example-project.json'), content_type: 'application/json; charset=utf-8' }],
  ['/practice/format-guide.md', { path: join(DOCS_DIRECTORY, 'practice-import-format.md'), content_type: 'text/plain; charset=utf-8' }],
]);
// The import body is the file itself.
const MAX_IMPORT_BODY_BYTES = MAX_FILE_CHARS;
// Arbitrary: a PUT of one exercise or project; the longest exercise is far below it.
const MAX_EXERCISE_BODY_BYTES = 200_000;
// Arbitrary: far above the longest answer, below anything that could hurt the server.
const MAX_ATTEMPT_BODY_BYTES = 256 * 1024;
const ATTEMPTS_PAGE_DEFAULT = 50;
const ATTEMPTS_PAGE_MAX = 200;
const ATTEMPT_STATUSES: AttemptStatus[] = ['grading', 'graded', 'failed'];

// The index without its list of endpoints, which is made from the routes.
const API_INDEX: Omit<ApiIndex, 'endpoints'> = {
  api: 'practice',
  version: 3,
  docs: '/practice/format-guide.md',
  schemas: { exercise: '/api/practice/schemas/exercise.json', import: '/api/practice/schemas/import.json' },
  types: EXERCISE_TYPES,
  limits: {
    import_body_bytes: MAX_IMPORT_BODY_BYTES, exercises_per_import: MAX_EXERCISES, exercise_body_bytes: MAX_EXERCISE_BODY_BYTES,
    attempt_body_bytes: MAX_ATTEMPT_BODY_BYTES, key_pattern: KEY_PATTERN.source, attempts_page_max: ATTEMPTS_PAGE_MAX,
  },
};
const SCHEMAS = new Map([['exercise', exerciseSchema()], ['import', importSchema()]]);

// params: the URL's parts, decoded. query: checked against the route's parameters before the handler runs.
type Handler = (req: IncomingMessage, res: ServerResponse, params: string[], query: URLSearchParams) => Promise<void> | void;
interface Route {
  method: string;
  // As people write it, like /api/practice/projects/{p}; listed in the index.
  path: string;
  pattern: RegExp;
  // One line for the index.
  about: string;
  // The query parameters it takes; any other is a 400.
  query?: string[];
  handler: Handler;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// 400 invalid with every problem.
function sendProblems(res: ServerResponse, problems: Problem[]): void {
  sendError(res, 400, 'invalid', problems.length === 1 ? 'The request has 1 problem.' : `The request has ${problems.length} problems.`, problems);
}

const notFound = (res: ServerResponse, what: string): void => sendError(res, 404, 'not_found', `No such ${what}.`);

// 409 key_taken: a rename or a move would give a key that is already used.
function keyTaken(res: ServerResponse, message: string): void {
  sendError(res, 409, 'key_taken', message);
}

// The body as an object, or null with the error already sent. fields: the ones it may have; any other is a problem.
async function readObjectBody(req: IncomingMessage, res: ServerResponse, max_bytes: number, fields?: string[]): Promise<Record<string, unknown> | null> {
  const body = await readRequestJson(req, res, max_bytes);
  if (body === undefined) return null;
  if (!isObject(body)) {
    sendProblems(res, [{ path: '', code: 'wrong_type', message: 'The body must be a JSON object.' }]);
    return null;
  }
  const unknown = fields === undefined ? [] : Object.keys(body).filter((key) => !fields.includes(key));
  if (unknown.length === 0) return body;
  sendProblems(res, unknown.map((key) => ({ path: `/${key}`, code: 'unknown_field', message: `${key} is not a known field.` })));
  return null;
}

// The body of a rename or a move: an object with one field that holds a key. null with the error already sent.
// problems: the ones found before the body (a bad query), sent together with the body's.
async function readKeyBody(req: IncomingMessage, res: ServerResponse, field: string, problems: Problem[]): Promise<string | null> {
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
function choiceParam<Value extends string>(query: URLSearchParams, name: string, values: readonly Value[], problems: Problem[]): Value {
  const value = query.get(name) ?? values[0];
  if (values.includes(value as Value)) return value as Value;
  problems.push({ path: `?${name}`, code: 'not_allowed', message: `${name} must be one of: ${values.join(', ')}.` });
  return values[0];
}

const DRY_RUN = ['false', 'true'] as const;

// Every query parameter the route does not take, as a problem: an agent's typo is never silently ignored.
function unknownParameterProblems(query: URLSearchParams, parameters: string[]): Problem[] {
  const names = new Set(query.keys());
  const unknown = [...names].filter((name) => !parameters.includes(name));
  const takes = parameters.length > 0 ? ` (it takes ${parameters.join(', ')})` : '';
  return unknown.map((name) => ({ path: `?${name}`, code: 'unknown_parameter', message: `${name} is not a parameter here${takes}.` }));
}

function isWholeNumber(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 0;
}

// ?name as a whole number from min to max; null when it is left out. A problem otherwise.
function wholeNumberParam(query: URLSearchParams, name: string, min: number, max: number, problems: Problem[]): number | null {
  const text = query.get(name);
  if (text === null) return null;
  const value = /^\d{1,15}$/.test(text) ? Number(text) : NaN;
  if (value >= min && value <= max) return value;
  const range = max === Number.MAX_SAFE_INTEGER ? `${min} up` : `${min} to ${max}`;
  problems.push({ path: `?${name}`, code: 'out_of_range', message: `${name} must be a whole number from ${range}.` });
  return null;
}

export function createPracticeFeature({ database_path }: { database_path: string }): Feature {
  // Throws on a newer or damaged file, so the server stops at startup, not mid-request.
  const store: PracticeStore = openPracticeStore(database_path);
  const interrupted_count = store.failInterruptedGradings();
  if (interrupted_count > 0) log('warn', null, 'practice', `${interrupted_count} grading(s) were interrupted by a restart; Grade again redoes them`);

  const grader = createGrader(store);
  const grading_options: GradingOptions = {
    models: MODEL_OPTIONS.map(({ model_id, label, short_label, description }) => ({ model_id, label, short_label, description })),
    efforts: EFFORT_OPTIONS, default_model_id: DEFAULT_MODEL_ID, default_effort: DEFAULT_EFFORT,
  };

  // The grading settings a body names, each the default when left out, as problems when one is not offered. Checked here
  // because the CLI does not: an unknown --effort only prints a warning and runs at its default.
  function settingsOf({ model_id = DEFAULT_MODEL_ID, effort = DEFAULT_EFFORT }: RegradeRequest, problems: Problem[]): GradingSettings {
    if (modelOptionOf(model_id) === undefined) {
      const models = MODEL_OPTIONS.map((option) => option.model_id).join(', ');
      problems.push({ path: '/model_id', code: 'not_allowed', message: `model_id must be one of ${models}.` });
    }
    if (!isEffort(effort)) {
      const efforts = EFFORT_OPTIONS.map((option) => option.effort).join(', ');
      problems.push({ path: '/effort', code: 'not_allowed', message: `effort must be one of ${efforts}.` });
    }
    return { model_id, effort };
  }

  // ---- projects ----

  function listProjects(_req: IncomingMessage, res: ServerResponse, _params: string[], query: URLSearchParams): void {
    const problems: Problem[] = [];
    const archived = choiceParam(query, 'archived', ['false', 'true', 'all'] as const, problems);
    if (problems.length > 0) return sendProblems(res, problems);
    sendJson(res, 200, { items: store.listProjects(archived) });
  }

  async function putProject(req: IncomingMessage, res: ServerResponse, [key]: string[], query: URLSearchParams): Promise<void> {
    const problems = keyProblems(key);
    const is_dry_run = choiceParam(query, 'dry_run', DRY_RUN, problems) === 'true';
    const body = await readRequestJson(req, res, MAX_EXERCISE_BODY_BYTES);
    if (body === undefined) return;
    const { project, problems: body_problems } = checkProjectInput(body);
    problems.push(...(body_problems ?? []));
    if (project === null || problems.length > 0) return sendProblems(res, problems);
    const { project: saved, change } = store.putProject(key, project, is_dry_run);
    if (change !== 'unchanged' && !is_dry_run) log('info', null, 'practice', `project ${key} ${change}`);
    sendJson(res, change === 'created' ? 201 : 200, saved);
  }

  // A new key for a project. Its exercises and attempts stay linked; old URLs with the old key stop working.
  async function renameProject(req: IncomingMessage, res: ServerResponse, [key]: string[], query: URLSearchParams): Promise<void> {
    const problems: Problem[] = [];
    const is_dry_run = choiceParam(query, 'dry_run', DRY_RUN, problems) === 'true';
    const new_key = await readKeyBody(req, res, 'key', problems);
    if (new_key === null) return;
    const outcome = store.renameProject(key, new_key, is_dry_run);
    if (outcome === 'not_found') return notFound(res, `project "${key}"`);
    if (outcome === 'key_taken') return keyTaken(res, `There is already a project "${new_key}".`);
    if (new_key !== key && !is_dry_run) log('info', null, 'practice', `project ${key} renamed to ${new_key}`);
    sendJson(res, 200, outcome);
  }

  function deleteProject(_req: IncomingMessage, res: ServerResponse, [key]: string[], query: URLSearchParams): void {
    const problems: Problem[] = [];
    const is_with_attempts = choiceParam(query, 'with_attempts', ['false', 'true'] as const, problems) === 'true';
    if (problems.length > 0) return sendProblems(res, problems);
    const outcome = store.deleteProject(key, is_with_attempts);
    if (outcome === 'not_found') return notFound(res, `project "${key}"`);
    if (outcome === 'has_attempts') {
      const message = `Project "${key}" has attempts. To delete them too, add ?with_attempts=true; to keep them, archive it instead.`;
      return sendError(res, 409, 'has_attempts', message);
    }
    log('info', null, 'practice', `project ${key} deleted`);
    res.writeHead(204).end();
  }

  function exportProject(_req: IncomingMessage, res: ServerResponse, [key]: string[]): void {
    const file = store.exportProject(key);
    if (file === null) return notFound(res, `project "${key}"`);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${key}.json"` });
    res.end(`${JSON.stringify(file, null, 2)}\n`);
  }

  // ---- exercises ----

  function listExercises(_req: IncomingMessage, res: ServerResponse, [project_key]: string[], query: URLSearchParams): void {
    const problems: Problem[] = [];
    const type = query.get('type');
    if (type !== null && !EXERCISE_TYPES.includes(type as ExerciseType)) {
      problems.push({ path: '?type', code: 'not_allowed', message: `type must be one of: ${EXERCISE_TYPES.join(', ')}.` });
    }
    if (problems.length > 0) return sendProblems(res, problems);
    const items = store.listExercises(project_key, { type: type as ExerciseType | null, tag: query.get('tag') });
    if (items === null) return notFound(res, `project "${project_key}"`);
    sendJson(res, 200, { items });
  }

  async function putExercise(req: IncomingMessage, res: ServerResponse, [project_key, key]: string[], query: URLSearchParams): Promise<void> {
    const problems = keyProblems(key);
    const is_dry_run = choiceParam(query, 'dry_run', DRY_RUN, problems) === 'true';
    const body = await readRequestJson(req, res, MAX_EXERCISE_BODY_BYTES);
    if (body === undefined) return;
    const { exercise, problems: body_problems } = checkExerciseInput(body, key);
    problems.push(...(body_problems ?? []));
    if (exercise === null || problems.length > 0) return sendProblems(res, problems);
    const saved = store.putExercise(project_key, key, exercise, is_dry_run);
    if (saved === null) return notFound(res, `project "${project_key}"`);
    if (saved.change !== 'unchanged' && !is_dry_run) {
      log('info', null, 'practice', `exercise ${project_key}/${key} ${saved.change}, version ${saved.exercise.version}`);
    }
    sendJson(res, saved.change === 'created' ? 201 : 200, saved.exercise);
  }

  function readExercise(_req: IncomingMessage, res: ServerResponse, [project_key, key]: string[]): void {
    const exercise = store.readExercise(project_key, key);
    if (exercise !== null) return sendJson(res, 200, exercise);
    // Say which part of the URL is wrong.
    if (store.readProject(project_key) === null) return notFound(res, `project "${project_key}"`);
    notFound(res, `exercise "${key}" in project "${project_key}"`);
  }

  // A new key for an exercise, inside its project. Its attempts follow it and show the new key.
  async function renameExercise(req: IncomingMessage, res: ServerResponse, [project_key, key]: string[], query: URLSearchParams): Promise<void> {
    const problems: Problem[] = [];
    const is_dry_run = choiceParam(query, 'dry_run', DRY_RUN, problems) === 'true';
    const new_key = await readKeyBody(req, res, 'key', problems);
    if (new_key === null) return;
    const outcome = store.renameExercise(project_key, key, new_key, is_dry_run);
    if (outcome === 'not_found') return notFound(res, `exercise "${key}" in project "${project_key}"`);
    if (outcome === 'key_taken') return keyTaken(res, `There is already an exercise "${new_key}" in project "${project_key}".`);
    if (new_key !== key && !is_dry_run) log('info', null, 'practice', `exercise ${project_key}/${key} renamed to ${new_key}`);
    sendJson(res, 200, outcome);
  }

  // Moves an exercise, with its attempts, to the end of another project. It keeps its key, so the key must be free there.
  async function moveExercise(req: IncomingMessage, res: ServerResponse, [project_key, key]: string[], query: URLSearchParams): Promise<void> {
    const problems: Problem[] = [];
    const is_dry_run = choiceParam(query, 'dry_run', DRY_RUN, problems) === 'true';
    const to_project_key = await readKeyBody(req, res, 'project', problems);
    if (to_project_key === null) return;
    const outcome = store.moveExercise(project_key, key, to_project_key, is_dry_run);
    if (outcome === 'not_found') return notFound(res, `exercise "${key}" in project "${project_key}"`);
    if (outcome === 'no_target') return notFound(res, `project "${to_project_key}" to move to`);
    if (outcome === 'key_taken') {
      const message = `Project "${to_project_key}" already has an exercise "${key}". Rename one of them first.`;
      return keyTaken(res, message);
    }
    if (to_project_key !== project_key && !is_dry_run) log('info', null, 'practice', `exercise ${project_key}/${key} moved to ${to_project_key}`);
    sendJson(res, 200, outcome);
  }

  // The order of a project's exercises: the listed keys first, in this order; the others keep their order after them.
  async function putOrder(req: IncomingMessage, res: ServerResponse, [project_key]: string[], query: URLSearchParams): Promise<void> {
    const problems: Problem[] = [];
    const is_dry_run = choiceParam(query, 'dry_run', DRY_RUN, problems) === 'true';
    const body = await readObjectBody(req, res, MAX_EXERCISE_BODY_BYTES, ['keys']);
    if (body === null) return;
    const items = store.listExercises(project_key, { type: null, tag: null });
    if (items === null) return notFound(res, `project "${project_key}"`);

    const keys = body.keys;
    if (keys === undefined) {
      problems.push({ path: '/keys', code: 'required', message: 'keys is missing: the exercise keys in their new order.' });
    } else if (!Array.isArray(keys)) {
      problems.push({ path: '/keys', code: 'wrong_type', message: 'keys must be a list of exercise keys.' });
    } else {
      const known = new Set(items.map((item) => item.key));
      const seen = new Set<string>();
      keys.forEach((key, index) => {
        const path = `/keys/${index}`;
        if (typeof key !== 'string') {
          problems.push({ path, code: 'wrong_type', message: 'must be an exercise key.' });
        } else if (!known.has(key)) {
          problems.push({ path, code: 'unknown_key', message: `project "${project_key}" has no exercise "${key}".` });
        } else if (seen.has(key)) {
          problems.push({ path, code: 'duplicate_key', message: `"${key}" is listed twice.` });
        }
        seen.add(key);
      });
    }
    if (problems.length > 0) return sendProblems(res, problems);

    const ordered = store.reorderExercises(project_key, keys as string[], is_dry_run) as ExerciseItem[];
    if (!is_dry_run) log('info', null, 'practice', `project ${project_key}: exercises reordered`);
    sendJson(res, 200, { items: ordered });
  }

  function deleteExercise(_req: IncomingMessage, res: ServerResponse, [project_key, key]: string[]): void {
    if (!store.deleteExercise(project_key, key)) return notFound(res, `exercise "${key}" in project "${project_key}"`);
    log('info', null, 'practice', `exercise ${project_key}/${key} deleted`);
    res.writeHead(204).end();
  }

  async function importFile(req: IncomingMessage, res: ServerResponse, _params: string[], query: URLSearchParams): Promise<void> {
    const problems: Problem[] = [];
    const is_dry_run = choiceParam(query, 'dry_run', DRY_RUN, problems) === 'true';
    const body = await readRequestJson(req, res, MAX_IMPORT_BODY_BYTES);
    if (body === undefined) return;
    const { file, problems: file_problems } = checkImportValue(body);
    problems.push(...(file_problems ?? []));
    if (file === null || problems.length > 0) return sendProblems(res, problems);
    const result = store.importFile(file, is_dry_run);
    const { created, updated, unchanged } = result.exercises;
    if (!is_dry_run) {
      const counts = `${created.length} created, ${updated.length} updated, ${unchanged.length} unchanged`;
      log('info', null, 'import', `project ${file.key} ${result.project_change}  ${counts}`);
    }
    sendJson(res, 200, result);
  }

  // ---- attempts ----

  // Saves an answer. A flashcard is graded at once by your rating; every other answer is saved first, then graded in the
  // background.
  async function createAttempt(req: IncomingMessage, res: ServerResponse, [project_key, key]: string[]): Promise<void> {
    const body = await readObjectBody(req, res, MAX_ATTEMPT_BODY_BYTES, ['answer', 'writing_ms', 'model_id', 'effort', 'exercise_version']);
    if (body === null) return;
    const exercise = store.readExercise(project_key, key);
    if (exercise === null) return notFound(res, `exercise "${key}" in project "${project_key}"`);

    const problems: Problem[] = [];
    const { answer, problem } = checkAnswer(exercise, body.answer);
    if (answer === null) {
      const code = body.answer === undefined ? 'required' : 'wrong_type';
      problems.push({ path: '/answer', code, message: `${problem}.` });
    }
    const settings = settingsOf(body as RegradeRequest, problems);
    const writing_ms = body.writing_ms ?? null;
    if (writing_ms !== null && !isWholeNumber(writing_ms)) {
      problems.push({ path: '/writing_ms', code: 'wrong_type', message: 'writing_ms must be a whole number of milliseconds, or null.' });
    }
    const shown_version = body.exercise_version;
    if (shown_version !== undefined && !isWholeNumber(shown_version)) {
      problems.push({ path: '/exercise_version', code: 'wrong_type', message: 'exercise_version must be a whole number.' });
    }
    if (answer === null || problems.length > 0) return sendProblems(res, problems);

    // The exercise was changed (by an agent, say) after the page showed it: do not grade against a question you did not see.
    if (shown_version !== undefined && shown_version !== exercise.version) {
      const message = `The exercise changed while you answered (you saw version ${shown_version}, it is now ${exercise.version}). Open it again.`;
      return sendError(res, 409, 'exercise_changed', message);
    }

    const grader_kind = graderOf(exercise.type);
    const outcome = grader_kind === 'ai' ? null : rateFlashcard(answer as AnswerByType['flashcard']);
    const attempt = store.createAttempt({ exercise_id: exercise.id, answer, writing_ms: writing_ms as number | null, grader: grader_kind, outcome });
    sendJson(res, 201, attempt);
    if (grader_kind === 'ai') grader.start(attempt, settings);
  }

  function listAttempts(_req: IncomingMessage, res: ServerResponse, _params: string[], query: URLSearchParams): void {
    const problems: Problem[] = [];
    const project = query.get('project');
    const exercise = query.get('exercise');
    if (exercise !== null && project === null) {
      problems.push({ path: '?exercise', code: 'required', message: 'exercise needs project: an exercise key is unique only inside its project.' });
    }

    const status = query.get('status');
    if (status !== null && !ATTEMPT_STATUSES.includes(status as AttemptStatus)) {
      problems.push({ path: '?status', code: 'not_allowed', message: `status must be one of: ${ATTEMPT_STATUSES.join(', ')}.` });
    }

    // A date ("2026-10-19", midnight UTC) or a full time.
    const since = query.get('since');
    const is_since_valid = since === null || (/^\d{4}-\d{2}-\d{2}/.test(since) && !Number.isNaN(Date.parse(since)));
    if (!is_since_valid) {
      problems.push({ path: '?since', code: 'wrong_type', message: 'since must be a date or time, like 2026-10-19 or 2026-10-19T08:30:00Z.' });
    }

    const before = wholeNumberParam(query, 'before', 1, Number.MAX_SAFE_INTEGER, problems);
    const limit = wholeNumberParam(query, 'limit', 1, ATTEMPTS_PAGE_MAX, problems);
    if (problems.length > 0) return sendProblems(res, problems);

    if (project !== null && store.readProject(project) === null) return notFound(res, `project "${project}"`);
    const filter: AttemptFilter = {
      project,
      exercise,
      status: status as AttemptStatus | null,
      since: since === null ? null : new Date(since).toISOString(),
      before,
      limit: limit ?? ATTEMPTS_PAGE_DEFAULT,
    };
    sendJson(res, 200, store.listAttempts(filter));
  }

  function deleteAttempt(_req: IncomingMessage, res: ServerResponse, [id]: string[]): void {
    const outcome = store.deleteAttempt(Number(id));
    if (outcome === 'not_found') return notFound(res, 'attempt');
    if (outcome === 'grading') return sendError(res, 409, 'grading_in_progress', 'The attempt is being graded; delete it once grading has ended.');
    res.writeHead(204).end();
  }

  // A failed attempt is graded again with the same answer and the exercise as it was then, with the settings now chosen.
  async function regrade(req: IncomingMessage, res: ServerResponse, [id]: string[]): Promise<void> {
    const attempt_id = Number(id);
    const body = await readObjectBody(req, res, MAX_ATTEMPT_BODY_BYTES, ['model_id', 'effort']);
    if (body === null) return;
    const problems: Problem[] = [];
    const settings = settingsOf(body as RegradeRequest, problems);
    if (problems.length > 0) return sendProblems(res, problems);
    if (store.readAttempt(attempt_id) === null) return notFound(res, 'attempt');
    if (!store.restartGrading(attempt_id)) return sendError(res, 409, 'not_failed', 'Only a failed attempt can be graded again.');
    const attempt = store.readAttempt(attempt_id) as Attempt;
    sendJson(res, 202, attempt);
    grader.start(attempt, settings);
  }

  const found = (res: ServerResponse, body: unknown, what: string): void => (body === null ? notFound(res, what) : sendJson(res, 200, body));

  function watchAttempt(_req: IncomingMessage, res: ServerResponse, [id]: string[]): void {
    const attempt_id = Number(id);
    if (store.readAttempt(attempt_id) === null) return notFound(res, 'attempt');
    grader.watch(res, attempt_id);
  }

  // The parts of a readable path: {p} a project key and {e} an exercise key (checked by the handler that needs it), {id} an
  // attempt's number, {name} a schema's name.
  function patternOf(path: string): RegExp {
    const pattern = path
      .replaceAll('.', '\\.')
      .replaceAll('{p}', '([^/]+)')
      .replaceAll('{e}', '([^/]+)')
      .replaceAll('{id}', '(\\d{1,9})')
      .replaceAll('{name}', '([a-z]+)');
    return new RegExp(`^${pattern}$`);
  }
  function route(method: string, path: string, about: string, handler: Handler, query?: string[]): Route {
    const full_path = `/api/practice${path}`;
    return { method, path: full_path, pattern: patternOf(full_path), about, handler, query };
  }
  const routes: Route[] = [
    route('GET', '', 'This index: version, limits, types and every endpoint.', (_req, res) => sendJson(res, 200, api_index)),
    route('GET', '/schemas/{name}.json', 'JSON Schema of an exercise (exercise) or an import file (import).',
      (_req, res, [name]) => found(res, SCHEMAS.get(name) ?? null, `schema "${name}"`)),
    route('GET', '/grading-options', 'The models and efforts the AI grader can use.', (_req, res) => sendJson(res, 200, grading_options)),

    route('GET', '/projects', 'List projects, newest activity first.', listProjects, ['archived']),
    route('GET', '/projects/{p}', 'Read one project.', (_req, res, [key]) => found(res, store.readProject(key), `project "${key}"`)),
    route('PUT', '/projects/{p}', 'Create or replace a project: { name, description?, archived? }.', putProject, ['dry_run']),
    route('DELETE', '/projects/{p}', 'Delete a project; with attempts only with ?with_attempts=true.', deleteProject, ['with_attempts']),
    route('POST', '/projects/{p}/rename', 'Give a project a new key: { key }. Attempts stay linked.', renameProject, ['dry_run']),
    route('GET', '/projects/{p}/export', 'The project as an import file (format 3).', exportProject),
    route('POST', '/import', 'Import a format 3 file: upsert the project and its exercises by key.', importFile, ['dry_run']),

    route('GET', '/projects/{p}/exercises', 'List a project\'s exercises in order.', listExercises, ['type', 'tag']),
    route('PUT', '/projects/{p}/order', 'Set the order: { keys }; the keys not listed follow in their order.', putOrder, ['dry_run']),
    route('GET', '/projects/{p}/exercises/{e}', 'Read one exercise with its content.', readExercise),
    route('PUT', '/projects/{p}/exercises/{e}', 'Create or replace an exercise.', putExercise, ['dry_run']),
    route('DELETE', '/projects/{p}/exercises/{e}', 'Delete an exercise; its attempts stay.', deleteExercise),
    route('POST', '/projects/{p}/exercises/{e}/rename', 'Give an exercise a new key: { key }. Attempts follow it.', renameExercise, ['dry_run']),
    route('POST', '/projects/{p}/exercises/{e}/move', 'Move an exercise to another project: { project }. Attempts follow it.', moveExercise, ['dry_run']),

    route('POST', '/projects/{p}/exercises/{e}/attempts', 'Answer an exercise; AI grading starts in the background.', createAttempt),
    route('GET', '/attempts', 'List attempts, newest first.', listAttempts, ['project', 'exercise', 'status', 'since', 'before', 'limit']),
    route('GET', '/attempts/{id}', 'Read one attempt.', (_req, res, [id]) => found(res, store.readAttempt(Number(id)), 'attempt')),
    route('DELETE', '/attempts/{id}', 'Delete an attempt (not while it is graded).', deleteAttempt),
    route('POST', '/attempts/{id}/regrade', 'Grade a failed attempt again: { model_id?, effort? }.', regrade),
    route('GET', '/attempts/{id}/stream', 'Follow a grading as server-sent events.', watchAttempt),
  ];
  const api_index: ApiIndex = {
    ...API_INDEX,
    endpoints: routes.map((one_route) => ({
      method: one_route.method,
      path: one_route.path,
      query: one_route.query ?? [],
      about: one_route.about,
    })),
  };

  async function handle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
    if (req.method === 'GET' && FILES.has(pathname)) {
      const { path, content_type } = FILES.get(pathname) as { path: string; content_type: string };
      await sendFile(res, path, content_type);
      return true;
    }
    if (req.method === 'GET' && MODULES.has(pathname)) {
      await sendModule(res, MODULES.get(pathname) as string);
      return true;
    }
    return handleApi(req, res, pathname);
  }

  // Finds the route for the path and method and runs it. A known path with another method is a 405 that names the right
  // ones; a path no route knows is left to the server (false).
  async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
    const allowed_methods = new Set<string>();
    for (const one_route of routes) {
      const match = one_route.pattern.exec(pathname);
      if (match === null) continue;
      if (req.method === one_route.method) {
        await runRoute(one_route, match, req, res, pathname);
        return true;
      }
      allowed_methods.add(one_route.method);
    }
    if (allowed_methods.size === 0) return false;
    const allowed = [...allowed_methods];
    const message = `${req.method} is not allowed here; use ${allowed.join(' or ')}.`;
    sendError(res, 405, 'method_not_allowed', message, undefined, { Allow: allowed.join(', ') });
    return true;
  }

  async function runRoute(one_route: Route, match: RegExpExecArray, req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    let params: string[];
    try {
      params = match.slice(1).map((part) => decodeURIComponent(part));
    } catch {
      return sendError(res, 404, 'not_found', `Nothing at ${pathname}.`);
    }
    const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
    const problems = unknownParameterProblems(query, one_route.query ?? []);
    if (problems.length > 0) return sendProblems(res, problems);
    await one_route.handler(req, res, params, query);
  }

  return { name: 'practice', handle };
}
