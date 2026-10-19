// The page's side of the HTTP API (features/practice/api.ts). Every read takes the navigation's AbortSignal, so a response
// that arrives after the page has moved on is dropped, never drawn.
import type { ApiErrorBody, ApiProblem } from '../../../shared/api.ts';
import { readServerEvents } from '../../../shared/web/ui.ts';
import type {
  AnswerByType, Attempt, ExerciseItem, ExerciseType, ExerciseView, GradingOptions, GradingSettings, GradingStreamEvents, ImportRequest, List, Project,
  ProjectDetail,
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

async function request<Body>(path: string, signal: AbortSignal | undefined, body?: unknown): Promise<Body> {
  const response = await fetch(`/api/practice${path}`, body === undefined ? { signal } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
  });
  if (!response.ok) throw await apiErrorOf(response);
  return await response.json() as Body;
}

// The problems of a rejected request, or the one error as a problem.
export function problemsOf(error: unknown): ApiProblem[] {
  if (error instanceof ApiError && error.problems.length > 0) return error.problems;
  return [{ path: '', code: error instanceof ApiError ? error.code : 'network', message: (error as Error).message }];
}

export const listProjects = async (signal: AbortSignal) => (await request<List<Project>>('/projects', signal)).items;
export const readProjectByKey = (key: string, signal: AbortSignal) => request<Project>(`/projects/${key}`, signal);
export const listExercises = async (key: string, signal: AbortSignal) => (await request<List<ExerciseItem>>(`/projects/${key}/exercises`, signal)).items;
export const readProject = (id: number, signal: AbortSignal) => request<ProjectDetail>(`/projects/${id}`, signal);
export const readExercise = (id: number, signal: AbortSignal) => request<ExerciseView>(`/exercises/${id}`, signal);
export const readAttempt = (id: number, signal: AbortSignal) => request<Attempt>(`/attempts/${id}`, signal);
export const createProject = (body: ImportRequest, signal: AbortSignal) => request<{ id: number }>('/projects', signal, body);
export const addExercises = (project_id: number, body: ImportRequest, signal: AbortSignal) => request<{ added: number }>(`/projects/${project_id}/exercises`, signal, body);
export const readGradingOptions = (signal: AbortSignal) => request<GradingOptions>('/grading-options', signal);
export const submitAttempt = (exercise_id: number, answer: AnswerByType[ExerciseType], writing_ms: number, settings: GradingSettings, signal: AbortSignal) =>
  request<Attempt>('/attempts', signal, { exercise_id, answer, writing_ms, ...settings });
export const regrade = (attempt_id: number, settings: GradingSettings, signal: AbortSignal) => request<Attempt>(`/attempts/${attempt_id}/regrade`, signal, settings);

// One event of a grading stream as [name, data]: switching on the name narrows the data.
export type GradingEvent = { [Name in keyof GradingStreamEvents]: [Name, GradingStreamEvents[Name]] }[keyof GradingStreamEvents];

// Follows the grading of an attempt until its stream ends (it is done, it failed, or the connection broke). The server keeps
// grading whether or not anyone follows, so a page that comes back just follows again and is sent what it missed first.
export async function watchGrading(attempt_id: number, signal: AbortSignal, onEvent: (event: GradingEvent) => void): Promise<void> {
  await readServerEvents(await fetch(`/api/practice/attempts/${attempt_id}/stream`, { signal }), (name, data) => onEvent([name, data] as GradingEvent));
}
