// The page's side of the HTTP API (features/practice/api.ts). Every read takes the navigation's AbortSignal, so a response
// that arrives after the page has moved on is dropped, never drawn.
import type { ApiErrorBody, ApiProblem } from '../../../shared/api.ts';
import { readServerEvents } from '../../../shared/web/ui.ts';
import type {
  AnswerByType, Attempt, CreateAttemptRequest, Exercise, ExerciseItem, ExerciseType, GradingOptions, GradingSettings, GradingStreamEvents, ImportResult,
  List, Project, ProjectInput,
} from '../api.ts';

// A non-2xx answer: its status and the API's one error shape (docs/practice-api-design.md §3.3).
export class ApiError extends Error {
  status: number;
  code: string;
  problems: ApiProblem[];

  constructor(status: number, code: string, message: string, problems: ApiProblem[] = []) {
    super(message);
    this.status = status;
    this.code = code;
    this.problems = problems;
  }
}

// Every API error is JSON; anything else (a proxy, a crash before the server answered) keeps its status and text.
async function apiErrorOf(response: Response): Promise<ApiError> {
  const text = await response.text();
  try {
    const { error } = JSON.parse(text) as ApiErrorBody;
    return new ApiError(response.status, error.code, error.message, error.problems);
  } catch {
    return new ApiError(response.status, 'http', text || `HTTP ${response.status}`);
  }
}

// Sends one API request. A body is sent as JSON. A 204 has no body, so it returns undefined.
async function request<Body>(method: string, path: string, signal: AbortSignal, body?: unknown): Promise<Body> {
  const init: RequestInit = { method, signal };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`/api/practice${path}`, init);
  if (!response.ok) throw await apiErrorOf(response);
  if (response.status === 204) return undefined as Body;
  return await response.json() as Body;
}

// The problems of a rejected request, or the one error as a problem.
export function problemsOf(error: unknown): ApiProblem[] {
  if (error instanceof ApiError && error.problems.length > 0) return error.problems;
  const code = error instanceof ApiError ? error.code : 'network';
  return [{ path: '', code, message: (error as Error).message }];
}

// An error as one line for a person: the API's message and, when it lists problems, each of them.
export function errorText(error: unknown): string {
  const problems = error instanceof ApiError ? error.problems : [];
  if (problems.length === 0) return (error as Error).message;
  return problems.map((problem) => problem.message).join(' ');
}

// ---- projects ----

export async function listProjects(archived: 'false' | 'all', signal: AbortSignal): Promise<Project[]> {
  const list = await request<List<Project>>('GET', `/projects?archived=${archived}`, signal);
  return list.items;
}

export function readProject(key: string, signal: AbortSignal): Promise<Project> {
  return request<Project>('GET', `/projects/${key}`, signal);
}

export function putProject(key: string, input: ProjectInput, signal: AbortSignal): Promise<Project> {
  return request<Project>('PUT', `/projects/${key}`, signal, input);
}

export function deleteProject(key: string, with_attempts: boolean, signal: AbortSignal): Promise<void> {
  return request<void>('DELETE', `/projects/${key}?with_attempts=${with_attempts}`, signal);
}

// The URL that downloads the project as a file.
export function exportUrl(key: string): string {
  return `/api/practice/projects/${key}/export`;
}

export function importFile(file: unknown, signal: AbortSignal): Promise<ImportResult> {
  return request<ImportResult>('POST', '/import', signal, file);
}

// What a project's pages show: the project and its exercises, in order.
export interface ProjectView {
  project: Project;
  exercises: ExerciseItem[];
}

export async function readProjectView(key: string, signal: AbortSignal): Promise<ProjectView> {
  const [project, exercises] = await Promise.all([readProject(key, signal), listExercises(key, signal)]);
  return { project, exercises };
}

// ---- exercises ----

export async function listExercises(project_key: string, signal: AbortSignal): Promise<ExerciseItem[]> {
  const list = await request<List<ExerciseItem>>('GET', `/projects/${project_key}/exercises`, signal);
  return list.items;
}

export function readExercise(project_key: string, key: string, signal: AbortSignal): Promise<Exercise> {
  return request<Exercise>('GET', `/projects/${project_key}/exercises/${key}`, signal);
}

export function deleteExercise(project_key: string, key: string, signal: AbortSignal): Promise<void> {
  return request<void>('DELETE', `/projects/${project_key}/exercises/${key}`, signal);
}

// ---- attempts ----

// target: which exercise, and the version the page showed.
export function submitAttempt(exercise: Pick<Exercise, 'project' | 'key' | 'version'>, answer: AnswerByType[ExerciseType], writing_ms: number, settings: GradingSettings, signal: AbortSignal): Promise<Attempt> {
  const body: CreateAttemptRequest = { answer, writing_ms, exercise_version: exercise.version, ...settings };
  return request<Attempt>('POST', `/projects/${exercise.project}/exercises/${exercise.key}/attempts`, signal, body);
}

export function readAttempt(id: number, signal: AbortSignal): Promise<Attempt> {
  return request<Attempt>('GET', `/attempts/${id}`, signal);
}

export function regrade(attempt_id: number, settings: GradingSettings, signal: AbortSignal): Promise<Attempt> {
  return request<Attempt>('POST', `/attempts/${attempt_id}/regrade`, signal, settings);
}

export function readGradingOptions(signal: AbortSignal): Promise<GradingOptions> {
  return request<GradingOptions>('GET', '/grading-options', signal);
}

// One event of a grading stream as [name, data]: switching on the name narrows the data.
export type GradingEvent = { [Name in keyof GradingStreamEvents]: [Name, GradingStreamEvents[Name]] }[keyof GradingStreamEvents];

// Follows the grading of an attempt until its stream ends (it is done, it failed, or the connection broke). The server keeps
// grading whether or not anyone follows, so a page that comes back just follows again and is sent what it missed first.
export async function watchGrading(attempt_id: number, signal: AbortSignal, onEvent: (event: GradingEvent) => void): Promise<void> {
  await readServerEvents(await fetch(`/api/practice/attempts/${attempt_id}/stream`, { signal }), (name, data) => onEvent([name, data] as GradingEvent));
}
