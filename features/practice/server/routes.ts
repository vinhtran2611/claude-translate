// Practice's routes: the page at /practice and the API under /api/practice (docs/practice-proposal.md §5).
import { readdirSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_EFFORT, DEFAULT_MODEL_ID, EFFORT_OPTIONS, isEffort, MODEL_OPTIONS, modelOptionOf } from '../../../shared/server/claude-runner.ts';
import { readJsonBody, sendFile, sendJson, sendModule, type Feature } from '../../../shared/server/http.ts';
import { log } from '../../../shared/server/log.ts';
import type { AnswerByType, AttemptView, CreateAttemptRequest, GradingOptions, GradingSettings, ProjectFile, RegradeRequest } from '../api.ts';
import { checkProjectFile, MAX_FILE_CHARS } from '../import-check.ts';
import { createGrader } from './ai-grading.ts';
import { checkAnswer, graderOf, rateFlashcard } from './answers.ts';
import { openPracticeStore, type PracticeStore } from './store.ts';

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
// Arbitrary: a file of MAX_FILE_CHARS, escaped inside JSON, with room to spare.
const MAX_IMPORT_BODY_BYTES = 4 * MAX_FILE_CHARS;
// Arbitrary: far above the longest answer, below anything that could hurt the server.
const MAX_ATTEMPT_BODY_BYTES = 256 * 1024;

type Params = number[];
type Handler = (req: IncomingMessage, res: ServerResponse, params: Params) => Promise<void> | void;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function reject(res: ServerResponse, status_code: number, reason: string): void {
  res.writeHead(status_code, { 'Content-Type': 'text/plain; charset=utf-8' }).end(reason);
}

// The body as an object, or a 400 already sent and null.
async function readObjectBody(req: IncomingMessage, res: ServerResponse, max_bytes: number): Promise<Record<string, unknown> | null> {
  try {
    const body = await readJsonBody(req, max_bytes);
    if (isObject(body)) return body;
  } catch {
    // Answered below.
  }
  reject(res, 400, 'Body must be a JSON object');
  return null;
}

// An import body's file, checked: the file, or the problems already sent as a 400 and null.
function checkedFile(res: ServerResponse, body: Record<string, unknown>): ProjectFile | null {
  const { file, errors } = checkProjectFile(typeof body.file === 'string' ? body.file : '');
  if (errors !== null) sendJson(res, 400, { errors });
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

  // The grading settings a request names, each the default when left out; null, with a 400 sent, when one is not offered.
  // Checked here because the CLI does not: an unknown --effort only prints a warning and runs at its default.
  function settingsOf(res: ServerResponse, { model_id = DEFAULT_MODEL_ID, effort = DEFAULT_EFFORT }: RegradeRequest): GradingSettings | null {
    const problem = modelOptionOf(model_id) === undefined ? `model_id must be one of ${MODEL_OPTIONS.map((option) => option.model_id).join(', ')}`
      : !isEffort(effort) ? `effort must be one of ${EFFORT_OPTIONS.map((option) => option.effort).join(', ')}` : null;
    if (problem === null) return { model_id, effort };
    reject(res, 400, problem);
    return null;
  }

  async function createProject(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readObjectBody(req, res, MAX_IMPORT_BODY_BYTES);
    if (body === null) return;
    const file = checkedFile(res, body);
    if (file === null) return;
    const name = typeof body.name === 'string' && body.name.trim() !== '' ? body.name.trim() : file.name;
    const description = typeof body.description === 'string' ? body.description.trim() : file.description;
    if (name.length > 80 || description.length > 500) return reject(res, 400, 'name is at most 80 characters and description at most 500');
    const id = store.createProject({ ...file, name, description });
    log('info', null, 'import', `project ${id} "${name}"  ${file.exercises.length} exercises`);
    sendJson(res, 201, { id });
  }

  async function addExercises(req: IncomingMessage, res: ServerResponse, [project_id]: Params): Promise<void> {
    const body = await readObjectBody(req, res, MAX_IMPORT_BODY_BYTES);
    if (body === null) return;
    const file = checkedFile(res, body);
    if (file === null) return;
    const added = store.addExercises(project_id, file.exercises);
    if (added === null) return reject(res, 404, 'No such project');
    if ('duplicate_keys' in added) {
      const errors = file.exercises.flatMap(({ key }, index) => (added.duplicate_keys.includes(key) ? [`Exercise ${index + 1}: id "${key}" is already in this project.`] : []));
      return sendJson(res, 400, { errors });
    }
    log('info', null, 'import', `project ${project_id}  ${added.added} exercises added`);
    sendJson(res, 200, added);
  }

  // A flashcard is graded at once by your rating; every other answer is saved first, then graded in the background.
  async function createAttempt(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readObjectBody(req, res, MAX_ATTEMPT_BODY_BYTES) as Partial<CreateAttemptRequest> | null;
    if (!body) return;
    const exercise = Number.isInteger(body.exercise_id) ? store.readExercise(body.exercise_id as number) : null;
    if (exercise === null) return reject(res, 404, 'No such exercise');
    const { answer, problem } = checkAnswer(exercise, body.answer);
    if (answer === null) return reject(res, 400, problem);
    const settings = settingsOf(res, body as RegradeRequest);
    if (settings === null) return;
    const writing_ms = Number.isInteger(body.writing_ms) && (body.writing_ms as number) >= 0 ? body.writing_ms as number : null;
    const grader_kind = graderOf(exercise.type);
    const attempt = store.createAttempt({ exercise, answer, writing_ms, grader: grader_kind, outcome: grader_kind === 'ai' ? null : rateFlashcard(answer as AnswerByType['flashcard']) });
    sendJson(res, 201, attempt);
    if (grader_kind === 'ai') grader.start(attempt, settings);
  }

  // A failed attempt is graded again with the same answer and the exercise as it was then, with the settings now chosen.
  async function regrade(req: IncomingMessage, res: ServerResponse, [attempt_id]: Params): Promise<void> {
    const body = await readObjectBody(req, res, MAX_ATTEMPT_BODY_BYTES);
    if (body === null) return;
    const settings = settingsOf(res, body as RegradeRequest);
    if (settings === null) return;
    if (store.readAttempt(attempt_id) === null) return reject(res, 404, 'No such attempt');
    if (!store.restartGrading(attempt_id)) return reject(res, 409, 'Only a failed attempt can be graded again');
    const attempt = store.readAttempt(attempt_id) as AttemptView;
    sendJson(res, 202, attempt);
    grader.start(attempt, settings);
  }

  const found = (res: ServerResponse, body: unknown, what: string): void => (body === null ? reject(res, 404, `No such ${what}`) : sendJson(res, 200, body));
  const ID = '(\\d{1,9})';
  const routes: [method: string, pattern: RegExp, handler: Handler][] = [
    ['GET', /^\/api\/practice\/grading-options$/, (_req, res) => sendJson(res, 200, grading_options)],
    ['GET', /^\/api\/practice\/projects$/, (_req, res) => sendJson(res, 200, store.listProjects())],
    ['POST', /^\/api\/practice\/projects$/, createProject],
    ['GET', new RegExp(`^/api/practice/projects/${ID}$`), (_req, res, [id]) => found(res, store.readProject(id), 'project')],
    ['POST', new RegExp(`^/api/practice/projects/${ID}/exercises$`), addExercises],
    ['GET', new RegExp(`^/api/practice/exercises/${ID}$`), (_req, res, [id]) => found(res, store.readExercise(id), 'exercise')],
    ['POST', /^\/api\/practice\/attempts$/, createAttempt],
    ['GET', new RegExp(`^/api/practice/attempts/${ID}$`), (_req, res, [id]) => found(res, store.readAttempt(id), 'attempt')],
    ['POST', new RegExp(`^/api/practice/attempts/${ID}/regrade$`), regrade],
    ['GET', new RegExp(`^/api/practice/attempts/${ID}/stream$`), (_req, res, [id]) => (store.readAttempt(id) === null ? reject(res, 404, 'No such attempt') : grader.watch(res, id))],
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
    for (const [method, pattern, handler] of routes) {
      const match = req.method === method ? pattern.exec(pathname) : null;
      if (match !== null) {
        await handler(req, res, match.slice(1).map(Number));
        return true;
      }
    }
    return false;
  }

  return { name: 'practice', handle };
}
