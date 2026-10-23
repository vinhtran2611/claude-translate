// The page's side of the HTTP API (src/features/practice/api-types.ts). Every read takes the navigation's AbortSignal, so a response
// that arrives after the page has moved on is dropped, never drawn.
import type { ApiProblem, GenerationDetail } from '../../../shared/api-types.ts';
import { ApiError, fetchJson } from '../../../shared/web/fetch-json.ts';
import { readServerEvents } from '../../../shared/web/ui.ts';
import type {
  Answer, AttemptDetail, CreateAttemptRequest, ExerciseDetail, ExerciseItem, GenerationStreamEvents, GradingOptions, GradingSettings,
  GradingStreamEvents, ImportResult, List, ProjectInput, ProjectSummary,
} from '../api-types.ts';

// The pages check `error instanceof ApiError`; it is defined with fetchJson in shared/web/fetch-json.ts.
export { ApiError };

// Sends one API request. A body is sent as JSON. A 204 has no body, so it returns null.
function request<Body>(method: string, path: string, signal: AbortSignal, body?: unknown): Promise<Body> {
  const init: RequestInit = { method, signal };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  return fetchJson<Body>(`/api/practice${path}`, init);
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

export async function listProjects(archived: 'false' | 'all', signal: AbortSignal): Promise<ProjectSummary[]> {
  const list = await request<List<ProjectSummary>>('GET', `/projects?archived=${archived}`, signal);
  return list.items;
}

export function readProject(key: string, signal: AbortSignal): Promise<ProjectSummary> {
  return request<ProjectSummary>('GET', `/projects/${key}`, signal);
}

export function putProject(key: string, input: ProjectInput, signal: AbortSignal): Promise<ProjectSummary> {
  return request<ProjectSummary>('PUT', `/projects/${key}`, signal, input);
}

export function deleteProject(key: string, withAttempts: boolean, signal: AbortSignal): Promise<void> {
  return request<void>('DELETE', `/projects/${key}?with_attempts=${withAttempts}`, signal);
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
  project: ProjectSummary;
  exercises: ExerciseItem[];
}

export async function readProjectView(key: string, signal: AbortSignal): Promise<ProjectView> {
  const [project, exercises] = await Promise.all([readProject(key, signal), listExercises(key, signal)]);
  return { project, exercises };
}

// ---- exercises ----

async function listExercises(projectKey: string, signal: AbortSignal): Promise<ExerciseItem[]> {
  const list = await request<List<ExerciseItem>>('GET', `/projects/${projectKey}/exercises`, signal);
  return list.items;
}

export function readExercise(projectKey: string, key: string, signal: AbortSignal): Promise<ExerciseDetail> {
  return request<ExerciseDetail>('GET', `/projects/${projectKey}/exercises/${key}`, signal);
}

export function deleteExercise(projectKey: string, key: string, withAttempts: boolean, signal: AbortSignal): Promise<void> {
  return request<void>('DELETE', `/projects/${projectKey}/exercises/${key}?with_attempts=${withAttempts}`, signal);
}

// ---- attempts ----

// Which exercise, and the version the page showed.
type AttemptTarget = Pick<ExerciseDetail, 'projectKey' | 'key' | 'version'>;

export function submitAttempt(
  exercise: AttemptTarget, answer: Answer, timeSpentMs: number, settings: GradingSettings, signal: AbortSignal,
): Promise<AttemptDetail> {
  const body: CreateAttemptRequest = { answer, timeSpentMs, exerciseVersion: exercise.version, ...settings };
  return request<AttemptDetail>('POST', `/projects/${exercise.projectKey}/exercises/${exercise.key}/attempts`, signal, body);
}

export function readAttempt(id: number, signal: AbortSignal): Promise<AttemptDetail> {
  return request<AttemptDetail>('GET', `/attempts/${id}`, signal);
}

export function regrade(attemptId: number, settings: GradingSettings, signal: AbortSignal): Promise<AttemptDetail> {
  return request<AttemptDetail>('POST', `/attempts/${attemptId}/regrade`, signal, settings);
}

export function readGradingOptions(signal: AbortSignal): Promise<GradingOptions> {
  return request<GradingOptions>('GET', '/grading-options', signal);
}

// One event of a grading stream as [name, data]: switching on the name narrows the data.
export type GradingEvent = { [Name in keyof GradingStreamEvents]: [Name, GradingStreamEvents[Name]] }[keyof GradingStreamEvents];

// ---- generations ----

export function readGeneration(id: number, signal: AbortSignal): Promise<GenerationDetail> {
  return request<GenerationDetail>('GET', `/generations/${id}`, signal);
}

// A new run from the same post. A 409 "generating" (an ApiError) names the run that is going in its fields.
export async function retryGeneration(id: number, signal: AbortSignal): Promise<GenerationDetail> {
  const started = await request<{ generation: GenerationDetail }>('POST', `/generations/${id}/retry`, signal);
  return started.generation;
}

// One event of a generation stream as [name, data].
export type GenerationEvent = { [Name in keyof GenerationStreamEvents]: [Name, GenerationStreamEvents[Name]] }[keyof GenerationStreamEvents];

// Follows a generation until its stream ends, as watchGrading follows a grading.
export async function watchGeneration(id: number, signal: AbortSignal, onEvent: (event: GenerationEvent) => void): Promise<void> {
  await readServerEvents(await fetch(`/api/practice/generations/${id}/stream`, { signal }), (name, data) => onEvent([name, data] as GenerationEvent));
}

// Follows the grading of an attempt until its stream ends (it is done, it failed, or the connection broke). The server keeps
// grading whether or not anyone follows, so a page that comes back just follows again and is sent what it missed first.
export async function watchGrading(attemptId: number, signal: AbortSignal, onEvent: (event: GradingEvent) => void): Promise<void> {
  await readServerEvents(await fetch(`/api/practice/attempts/${attemptId}/stream`, { signal }), (name, data) => onEvent([name, data] as GradingEvent));
}
