// Practice's routes: the page at /practice and the API under /api/practice (docs/practice-api-design.md §3).
import { readdirSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_EFFORT, DEFAULT_MODEL_ID, EFFORT_OPTIONS, isEffort, MODEL_OPTIONS, modelOptionOf } from '../../../shared/server/claude-runner.ts';
import { readRequestJson, sendError, sendFile, sendJson, sendModule, type Feature } from '../../../shared/server/http.ts';
import { log } from '../../../shared/server/log.ts';
import type { AnswerByType, ApiIndex, Attempt, AttemptStatus, ExerciseType, GradingOptions, GradingSettings, ProjectFile, RegradeRequest } from '../api.ts';
import {
  checkExerciseInput, checkImportValue, checkProjectFile, checkProjectInput, EXERCISE_TYPES, exerciseSchema, importSchema, KEY_PATTERN, keyProblems,
  MAX_EXERCISES, MAX_FILE_CHARS, type Problem,
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
// Arbitrary: the first API sent the file as text inside JSON, escaped, with room to spare (step 5 deletes it).
const MAX_LEGACY_IMPORT_BODY_BYTES = 4 * MAX_FILE_CHARS;
const ATTEMPTS_PAGE_DEFAULT = 50;
const ATTEMPTS_PAGE_MAX = 200;
const ATTEMPT_STATUSES: AttemptStatus[] = ['grading', 'graded', 'failed'];

const API_INDEX: ApiIndex = {
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
  pattern: RegExp;
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

// ?name as one of `values` (its first when it is left out); a problem otherwise.
function choiceParam<Value extends string>(query: URLSearchParams, name: string, values: readonly Value[], problems: Problem[]): Value {
  const value = query.get(name) ?? values[0];
  if (values.includes(value as Value)) return value as Value;
  problems.push({ path: `?${name}`, code: 'not_allowed', message: `${name} must be one of: ${values.join(', ')}.` });
  return values[0];
}

const DRY_RUN = ['false', 'true'] as const;

// An import body's file, checked: the file, or the problems already sent as a 400 and null.
function checkedFile(res: ServerResponse, body: Record<string, unknown>): ProjectFile | null {
  const { file, problems } = checkProjectFile(typeof body.file === 'string' ? body.file : '', 2);
  if (problems !== null) sendProblems(res, problems.map((problem) => ({ ...problem, path: `/file${problem.path}` })));
  return file;
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
    if (modelOptionOf(model_id) === undefined) problems.push({ path: '/model_id', code: 'not_allowed', message: `model_id must be one of ${MODEL_OPTIONS.map((option) => option.model_id).join(', ')}.` });
    if (!isEffort(effort)) problems.push({ path: '/effort', code: 'not_allowed', message: `effort must be one of ${EFFORT_OPTIONS.map((option) => option.effort).join(', ')}.` });
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

  function deleteProject(_req: IncomingMessage, res: ServerResponse, [key]: string[], query: URLSearchParams): void {
    const problems: Problem[] = [];
    const is_with_attempts = choiceParam(query, 'with_attempts', ['false', 'true'] as const, problems) === 'true';
    if (problems.length > 0) return sendProblems(res, problems);
    const outcome = store.deleteProject(key, is_with_attempts);
    if (outcome === 'not_found') return notFound(res, `project "${key}"`);
    if (outcome === 'has_attempts') return sendError(res, 409, 'has_attempts', `Project "${key}" has attempts. To delete them too, add ?with_attempts=true; to keep them, archive it instead.`);
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
    if (type !== null && !EXERCISE_TYPES.includes(type as ExerciseType)) problems.push({ path: '?type', code: 'not_allowed', message: `type must be one of: ${EXERCISE_TYPES.join(', ')}.` });
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
    if (saved.change !== 'unchanged' && !is_dry_run) log('info', null, 'practice', `exercise ${project_key}/${key} ${saved.change}, version ${saved.exercise.version}`);
    sendJson(res, saved.change === 'created' ? 201 : 200, saved.exercise);
  }

  function readExercise(_req: IncomingMessage, res: ServerResponse, [project_key, key]: string[]): void {
    const exercise = store.readExercise(project_key, key);
    if (exercise === null) return notFound(res, store.readProject(project_key) === null ? `project "${project_key}"` : `exercise "${key}" in project "${project_key}"`);
    sendJson(res, 200, exercise);
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
    const { file, problems: file_problems } = checkImportValue(body, 3);
    problems.push(...(file_problems ?? []));
    if (file === null || problems.length > 0) return sendProblems(res, problems);
    const result = store.importFile(file, is_dry_run);
    const { created, updated, unchanged } = result.exercises;
    if (!is_dry_run) log('info', null, 'import', `project ${file.key} ${result.project_change}  ${created.length} created, ${updated.length} updated, ${unchanged.length} unchanged`);
    sendJson(res, 200, result);
  }

  // ---- attempts ----

  // Saves the answer to an exercise. A flashcard is graded at once by your rating; every other answer is saved first, then
  // graded in the background.
  async function answer(res: ServerResponse, body: Record<string, unknown>, exercise: { id: number; version: number } & Parameters<typeof checkAnswer>[0]): Promise<void> {
    const problems: Problem[] = [];
    const { answer: checked, problem } = checkAnswer(exercise, body.answer);
    if (checked === null) problems.push({ path: '/answer', code: body.answer === undefined ? 'required' : 'wrong_type', message: `${problem}.` });
    const settings = settingsOf(body as RegradeRequest, problems);
    const { writing_ms = null, exercise_version } = body;
    if (writing_ms !== null && !(Number.isInteger(writing_ms) && (writing_ms as number) >= 0)) problems.push({ path: '/writing_ms', code: 'wrong_type', message: 'writing_ms must be a whole number of milliseconds, or null.' });
    if (exercise_version !== undefined && !Number.isInteger(exercise_version)) problems.push({ path: '/exercise_version', code: 'wrong_type', message: 'exercise_version must be a whole number.' });
    if (checked === null || problems.length > 0) return sendProblems(res, problems);
    if (exercise_version !== undefined && exercise_version !== exercise.version) {
      return sendError(res, 409, 'exercise_changed', `The exercise changed while you answered (you saw version ${exercise_version}, it is now ${exercise.version}). Open it again.`);
    }
    const grader_kind = graderOf(exercise.type);
    const attempt = store.createAttempt({
      exercise_id: exercise.id, answer: checked, writing_ms: writing_ms as number | null, grader: grader_kind,
      outcome: grader_kind === 'ai' ? null : rateFlashcard(checked as AnswerByType['flashcard']),
    });
    sendJson(res, 201, attempt);
    if (grader_kind === 'ai') grader.start(attempt, settings);
  }

  async function createAttempt(req: IncomingMessage, res: ServerResponse, [project_key, key]: string[]): Promise<void> {
    const body = await readObjectBody(req, res, MAX_ATTEMPT_BODY_BYTES, ['answer', 'writing_ms', 'model_id', 'effort', 'exercise_version']);
    if (body === null) return;
    const exercise = store.readExercise(project_key, key);
    if (exercise === null) return notFound(res, `exercise "${key}" in project "${project_key}"`);
    await answer(res, body, exercise);
  }

  function listAttempts(_req: IncomingMessage, res: ServerResponse, _params: string[], query: URLSearchParams): void {
    const problems: Problem[] = [];
    const filter: AttemptFilter = { project: query.get('project'), exercise: query.get('exercise'), status: null, since: null, before: null, limit: ATTEMPTS_PAGE_DEFAULT };
    if (filter.exercise !== null && filter.project === null) problems.push({ path: '?exercise', code: 'required', message: 'exercise needs project: an exercise key is unique only inside its project.' });
    const status = query.get('status');
    if (status !== null && !ATTEMPT_STATUSES.includes(status as AttemptStatus)) problems.push({ path: '?status', code: 'not_allowed', message: `status must be one of: ${ATTEMPT_STATUSES.join(', ')}.` });
    else filter.status = status as AttemptStatus | null;
    const since = query.get('since');
    if (since !== null && (!/^\d{4}-\d{2}-\d{2}/.test(since) || Number.isNaN(Date.parse(since)))) problems.push({ path: '?since', code: 'wrong_type', message: 'since must be a date or time, like 2026-10-19 or 2026-10-19T08:30:00Z.' });
    else if (since !== null) filter.since = new Date(since).toISOString();
    for (const [name, min, max] of [['before', 1, Number.MAX_SAFE_INTEGER], ['limit', 1, ATTEMPTS_PAGE_MAX]] as const) {
      const text = query.get(name);
      if (text === null) continue;
      const value = /^\d{1,15}$/.test(text) ? Number(text) : NaN;
      if (value >= min && value <= max) filter[name] = value;
      else problems.push({ path: `?${name}`, code: 'out_of_range', message: `${name} must be a whole number from ${min}${name === 'limit' ? ` to ${max}` : ' up'}.` });
    }
    if (problems.length > 0) return sendProblems(res, problems);
    if (filter.project !== null && store.readProject(filter.project) === null) return notFound(res, `project "${filter.project}"`);
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

  // ---- The first API: what the page still calls until it moves (step 5 deletes it) ----

  async function legacyCreateProject(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readObjectBody(req, res, MAX_LEGACY_IMPORT_BODY_BYTES);
    if (body === null) return;
    const file = checkedFile(res, body);
    if (file === null) return;
    const name = typeof body.name === 'string' && body.name.trim() !== '' ? body.name.trim() : file.name;
    const description = typeof body.description === 'string' ? body.description.trim() : file.description;
    if (name.length > 80 || description.length > 500) {
      return sendProblems(res, [{ path: name.length > 80 ? '/name' : '/description', code: 'too_long', message: 'name is at most 80 characters and description at most 500.' }]);
    }
    const id = store.legacy.createProject({ ...file, name, description });
    log('info', null, 'import', `project ${id} "${name}"  ${file.exercises.length} exercises`);
    sendJson(res, 201, { id });
  }

  async function legacyAddExercises(req: IncomingMessage, res: ServerResponse, [id]: string[]): Promise<void> {
    const project_id = Number(id);
    const body = await readObjectBody(req, res, MAX_LEGACY_IMPORT_BODY_BYTES);
    if (body === null) return;
    const file = checkedFile(res, body);
    if (file === null) return;
    const added = store.legacy.addExercises(project_id, file.exercises);
    if (added === null) return notFound(res, 'project');
    if ('duplicate_keys' in added) {
      return sendProblems(res, file.exercises.flatMap(({ key }, index) => (added.duplicate_keys.includes(key)
        ? [{ path: `/file/exercises/${index}/id`, code: 'duplicate_key', message: `id "${key}" is already in this project.` }] : [])));
    }
    log('info', null, 'import', `project ${project_id}  ${added.added} exercises added`);
    sendJson(res, 200, added);
  }

  async function legacyCreateAttempt(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readObjectBody(req, res, MAX_ATTEMPT_BODY_BYTES, ['exercise_id', 'answer', 'writing_ms', 'model_id', 'effort']);
    if (body === null) return;
    const view = Number.isInteger(body.exercise_id) ? store.legacy.readExercise(body.exercise_id as number) : null;
    if (view === null) return notFound(res, 'exercise');
    const { exercise_id: _exercise_id, ...rest } = body;
    await answer(res, rest, { ...view, version: 0 });
  }

  const found = (res: ServerResponse, body: unknown, what: string): void => (body === null ? notFound(res, what) : sendJson(res, 200, body));
  const ID = '(\\d{1,9})';
  // One part of a path: a key (checked by the handler that needs it).
  const PART = '([^/]+)';
  const route = (method: string, path: string, handler: Handler, query?: string[]): Route => ({ method, pattern: new RegExp(`^/api/practice${path}$`), handler, query });
  const routes: Route[] = [
    route('GET', '', (_req, res) => sendJson(res, 200, API_INDEX)),
    route('GET', '/schemas/([a-z]+)\\.json', (_req, res, [name]) => found(res, SCHEMAS.get(name) ?? null, `schema "${name}"`)),
    route('GET', '/grading-options', (_req, res) => sendJson(res, 200, grading_options)),
    route('GET', '/projects', listProjects, ['archived']),
    route('POST', '/projects', legacyCreateProject),
    // Before the key routes, so the first API keeps its numeric ids until step 5.
    route('GET', `/projects/${ID}`, (_req, res, [id]) => found(res, store.legacy.readProjectDetail(Number(id)), 'project')),
    route('POST', `/projects/${ID}/exercises`, legacyAddExercises),
    route('GET', `/projects/${PART}`, (_req, res, [key]) => found(res, store.readProject(key), `project "${key}"`)),
    route('PUT', `/projects/${PART}`, putProject, ['dry_run']),
    route('DELETE', `/projects/${PART}`, deleteProject, ['with_attempts']),
    route('GET', `/projects/${PART}/export`, exportProject),
    route('GET', `/projects/${PART}/exercises`, listExercises, ['type', 'tag']),
    route('GET', `/projects/${PART}/exercises/${PART}`, readExercise),
    route('PUT', `/projects/${PART}/exercises/${PART}`, putExercise, ['dry_run']),
    route('DELETE', `/projects/${PART}/exercises/${PART}`, deleteExercise),
    route('POST', `/projects/${PART}/exercises/${PART}/attempts`, createAttempt),
    route('POST', '/import', importFile, ['dry_run']),
    route('GET', `/exercises/${ID}`, (_req, res, [id]) => found(res, store.legacy.readExercise(Number(id)), 'exercise')),
    route('GET', '/attempts', listAttempts, ['project', 'exercise', 'status', 'since', 'before', 'limit']),
    route('POST', '/attempts', legacyCreateAttempt),
    route('GET', `/attempts/${ID}`, (_req, res, [id]) => found(res, store.readAttempt(Number(id)), 'attempt')),
    route('DELETE', `/attempts/${ID}`, deleteAttempt),
    route('POST', `/attempts/${ID}/regrade`, regrade),
    route('GET', `/attempts/${ID}/stream`, (_req, res, [id]) => (store.readAttempt(Number(id)) === null ? notFound(res, 'attempt') : grader.watch(res, Number(id)))),
  ];

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
    // A known path with another method is a 405 that names the right ones.
    const allowed: string[] = [];
    for (const { method, pattern, handler, query: parameters = [] } of routes) {
      const match = pattern.exec(pathname);
      if (match === null) continue;
      if (req.method !== method) {
        allowed.push(method);
        continue;
      }
      let params: string[];
      try {
        params = match.slice(1).map((part) => decodeURIComponent(part));
      } catch {
        sendError(res, 404, 'not_found', `Nothing at ${pathname}.`);
        return true;
      }
      const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
      const unknown = [...new Set(query.keys())].filter((name) => !parameters.includes(name));
      if (unknown.length > 0) {
        sendProblems(res, unknown.map((name) => ({ path: `?${name}`, code: 'unknown_parameter', message: `${name} is not a parameter here${parameters.length > 0 ? ` (it takes ${parameters.join(', ')})` : ''}.` })));
        return true;
      }
      await handler(req, res, params, query);
      return true;
    }
    if (allowed.length === 0) return false;
    sendError(res, 405, 'method_not_allowed', `${req.method} is not allowed here; use ${[...new Set(allowed)].join(' or ')}.`, undefined, { Allow: [...new Set(allowed)].join(', ') });
    return true;
  }

  return { name: 'practice', handle };
}
