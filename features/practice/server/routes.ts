// Practice's routes: the page at /practice and the API under /api/practice (docs/practice-proposal.md §7.4).
import { mkdirSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonBody, sendFile, sendJson, sendModule, type Feature } from '../../../shared/server/http.ts';
import { log } from '../../../shared/server/log.ts';
import type { CreateAttemptRequest, ImportResult } from '../api.ts';
import { checkExerciseFile, MAX_IMPORT_FILE_BYTES } from './exercise-import.ts';
import { countWords } from './feedback-validate.ts';
import { gradeAttempt, gradingSettingsOf, isGradable, MAX_ANSWER_CHARS } from './grading.ts';
import { openPracticeStore, type PracticeStore } from './practice-store.ts';

// features/practice/: this file is features/practice/server/routes.ts.
const FEATURE_DIRECTORY = dirname(dirname(fileURLToPath(import.meta.url)));
const WEB_DIRECTORY = join(FEATURE_DIRECTORY, 'web');
const EXAMPLE_FILE_PATH = join(FEATURE_DIRECTORY, 'examples', 'exercises.example.json');
// The page's modules, served as JavaScript with their types stripped. URLs mirror the folders under features/practice/,
// so a relative import resolves the same for tsc and the browser.
const WEB_MODULE_PATHS = new Map([
  ['/practice/web/practice.ts', join(WEB_DIRECTORY, 'practice.ts')],
  ['/practice/categories.ts', join(FEATURE_DIRECTORY, 'categories.ts')],
]);
const EXERCISE_PATH = /^\/api\/practice\/exercises\/([a-z0-9][a-z0-9-]{0,63})$/;
const ATTEMPT_PATH = /^\/api\/practice\/attempts\/(\d+)$/;
const REGRADE_PATH = /^\/api\/practice\/attempts\/(\d+)\/regrade$/;
// Arbitrary: far above the longest answer, below anything that could hurt the server.
const MAX_ATTEMPT_BODY_BYTES = 256 * 1024;

function rejectAttempt(res: ServerResponse, status_code: number, reason: string): void {
  log('warn', null, 'http', `${status_code} POST /api/practice/attempts: ${reason}`);
  res.writeHead(status_code).end(reason);
}

// Saves the answer first (so nothing is lost if grading fails), answers 201, then grades in the background.
async function handleCreateAttempt(req: IncomingMessage, res: ServerResponse, store: PracticeStore): Promise<void> {
  let body: Partial<CreateAttemptRequest>;
  try {
    body = (await readJsonBody(req, MAX_ATTEMPT_BODY_BYTES)) as Partial<CreateAttemptRequest>;
  } catch {
    rejectAttempt(res, 400, 'Body must be JSON');
    return;
  }
  const detail = typeof body.exercise_id === 'string' ? store.readExercise(body.exercise_id) : null;
  if (detail === null) {
    rejectAttempt(res, 404, 'No such exercise');
    return;
  }
  const { exercise } = detail;
  if (!isGradable(exercise.type)) {
    rejectAttempt(res, 400, `${exercise.type} cannot be graded yet`);
    return;
  }
  const text = typeof body.answer?.text === 'string' ? body.answer.text.trim().normalize('NFC') : '';
  if (text === '' || text.length > MAX_ANSWER_CHARS[exercise.type]) {
    rejectAttempt(res, 400, `answer.text must be non-empty and at most ${MAX_ANSWER_CHARS[exercise.type]} characters`);
    return;
  }
  const writing_ms = Number.isInteger(body.writing_ms) && (body.writing_ms as number) >= 0 ? body.writing_ms as number : null;
  const answer = { text };
  const word_count = countWords(text);
  const { model_id: requested_model_id, effort } = gradingSettingsOf(exercise.type);
  const attempt_id = store.createAttempt({ exercise, answer, word_count, writing_ms, requested_model_id, effort });
  sendJson(res, 201, { attempt_id });
  gradeAttempt(store, attempt_id, exercise, answer, word_count);
}

// A failed attempt is graded again with the same answer and the exercise as it was then.
function handleRegrade(res: ServerResponse, store: PracticeStore, attempt_id: number): void {
  const attempt = store.readAttempt(attempt_id);
  if (attempt === null) {
    res.writeHead(404).end('No such attempt');
    return;
  }
  if (!store.restartGrading(attempt_id)) {
    res.writeHead(409).end('Only a failed attempt can be graded again');
    return;
  }
  res.writeHead(202).end();
  gradeAttempt(store, attempt_id, attempt.exercise_snapshot, attempt.answer, attempt.word_count);
}

function sendProblems(res: ServerResponse, message: string): void {
  sendJson(res, 400, { errors: [{ path: '', message }] });
}

// A copy of every imported file goes to <data>/practice-imports/, so the originals are never lost.
function saveImportCopy(imports_directory: string, file_name: string, body: unknown): string {
  mkdirSync(imports_directory, { recursive: true });
  const safe_name = basename(file_name).replace(/[^\w.-]+/g, '_').replace(/\.json$/i, '') || 'import';
  const copy_name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${safe_name}.json`;
  writeFileSync(join(imports_directory, copy_name), `${JSON.stringify(body, null, 2)}\n`);
  return copy_name;
}

async function handleImport(req: IncomingMessage, res: ServerResponse, store: PracticeStore, imports_directory: string): Promise<void> {
  const file_name = decodeURIComponent(String(req.headers['x-file-name'] ?? 'import.json'));
  let body: unknown;
  try {
    body = await readJsonBody(req, MAX_IMPORT_FILE_BYTES);
  } catch (error) {
    const message = (error as Error).message.startsWith('body is larger') ? 'the file is larger than 2 MB' : 'the file is not valid JSON';
    log('warn', null, 'import', `${file_name}: ${message}`);
    sendProblems(res, message);
    return;
  }
  const { exercises, errors, warnings } = checkExerciseFile(body);
  if (errors.length > 0) {
    log('warn', null, 'import', `${file_name}: ${errors.length} ${errors.length === 1 ? 'error' : 'errors'}, nothing imported`);
    sendJson(res, 400, { errors });
    return;
  }
  const copy_name = saveImportCopy(imports_directory, file_name, body);
  const { added, updated } = store.importExercises(exercises, copy_name);
  const warning_text = warnings.length > 0 ? `  ${warnings.length} ${warnings.length === 1 ? 'warning' : 'warnings'}` : '';
  log(warnings.length > 0 ? 'warn' : 'info', null, 'import', `${file_name}  ${added} added  ${updated} updated${warning_text}`);
  const result: ImportResult = { added, updated, warnings };
  sendJson(res, 200, result);
}

export function createPracticeFeature({ database_path }: { database_path: string }): Feature {
  // Throws on a newer or damaged file, so the server stops at startup, not mid-request.
  const store = openPracticeStore(database_path);
  const interrupted_count = store.failInterruptedGradings();
  if (interrupted_count > 0) log('warn', null, 'practice', `${interrupted_count} grading(s) were interrupted by a restart; Grade again redoes them`);
  const imports_directory = join(dirname(database_path), 'practice-imports');

  async function handle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
    const exercise_match = EXERCISE_PATH.exec(pathname);
    const attempt_match = ATTEMPT_PATH.exec(pathname);
    const regrade_match = REGRADE_PATH.exec(pathname);
    if (req.method === 'GET' && pathname === '/practice') {
      await sendFile(res, join(WEB_DIRECTORY, 'practice.html'), 'text/html; charset=utf-8');
    } else if (req.method === 'GET' && WEB_MODULE_PATHS.has(pathname)) {
      await sendModule(res, WEB_MODULE_PATHS.get(pathname) as string);
    } else if (req.method === 'GET' && pathname === '/practice/exercises.example.json') {
      await sendFile(res, EXAMPLE_FILE_PATH, 'application/json; charset=utf-8');
    } else if (req.method === 'GET' && pathname === '/api/practice/exercises') {
      sendJson(res, 200, store.listExercises(isGradable));
    } else if (req.method === 'GET' && exercise_match) {
      const detail = store.readExercise(exercise_match[1]);
      if (detail) sendJson(res, 200, detail);
      else res.writeHead(404).end('No such exercise');
    } else if (req.method === 'POST' && pathname === '/api/practice/exercises/import') {
      await handleImport(req, res, store, imports_directory);
    } else if (req.method === 'POST' && pathname === '/api/practice/attempts') {
      await handleCreateAttempt(req, res, store);
    } else if (req.method === 'GET' && attempt_match) {
      const attempt = store.readAttempt(Number(attempt_match[1]));
      if (attempt) sendJson(res, 200, attempt);
      else res.writeHead(404).end('No such attempt');
    } else if (req.method === 'POST' && regrade_match) {
      handleRegrade(res, store, Number(regrade_match[1]));
    } else {
      return false;
    }
    return true;
  }

  return { name: 'practice', handle };
}
