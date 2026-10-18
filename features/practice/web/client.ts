// The page's side of the HTTP API (features/practice/api.ts). Every read takes the navigation's AbortSignal, so a response
// that arrives after the page has moved on is dropped, never drawn.
import { readServerEvents } from '../../../shared/web/ui.ts';
import type {
  AnswerByType, AttemptView, CreateAttemptRequest, ExerciseType, ExerciseView, GradingOptions, GradingSettings, GradingStreamEvents, ImportRequest,
  ProjectDetail, ProjectSummary,
} from '../api.ts';

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<Body>(path: string, signal: AbortSignal | undefined, body?: unknown): Promise<Body> {
  const response = await fetch(`/api/practice${path}`, body === undefined ? { signal } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
  });
  if (!response.ok) throw new ApiError(response.status, await response.text());
  return await response.json() as Body;
}

// The problems of a rejected import: the lines the server listed, or the one line it sent.
export function problemsOf(error: unknown): string[] {
  if (!(error instanceof ApiError)) return [(error as Error).message];
  try {
    return (JSON.parse(error.message) as { errors: string[] }).errors;
  } catch {
    return [error.message || `HTTP ${error.status}`];
  }
}

export const listProjects = (signal: AbortSignal) => request<ProjectSummary[]>('/projects', signal);
export const readProject = (id: number, signal: AbortSignal) => request<ProjectDetail>(`/projects/${id}`, signal);
export const readExercise = (id: number, signal: AbortSignal) => request<ExerciseView>(`/exercises/${id}`, signal);
export const readAttempt = (id: number, signal: AbortSignal) => request<AttemptView>(`/attempts/${id}`, signal);
export const createProject = (body: ImportRequest, signal: AbortSignal) => request<{ id: number }>('/projects', signal, body);
export const addExercises = (project_id: number, body: ImportRequest, signal: AbortSignal) => request<{ added: number }>(`/projects/${project_id}/exercises`, signal, body);
export const readGradingOptions = (signal: AbortSignal) => request<GradingOptions>('/grading-options', signal);
export const submitAttempt = (exercise_id: number, answer: AnswerByType[ExerciseType], writing_ms: number, settings: GradingSettings, signal: AbortSignal) =>
  request<AttemptView>('/attempts', signal, { exercise_id, answer, writing_ms, ...settings } satisfies CreateAttemptRequest);
export const regrade = (attempt_id: number, settings: GradingSettings, signal: AbortSignal) => request<AttemptView>(`/attempts/${attempt_id}/regrade`, signal, settings);

// One event of a grading stream as [name, data]: switching on the name narrows the data.
export type GradingEvent = { [Name in keyof GradingStreamEvents]: [Name, GradingStreamEvents[Name]] }[keyof GradingStreamEvents];

// Follows the grading of an attempt until its stream ends (it is done, it failed, or the connection broke). The server keeps
// grading whether or not anyone follows, so a page that comes back just follows again and is sent what it missed first.
export async function watchGrading(attempt_id: number, signal: AbortSignal, onEvent: (event: GradingEvent) => void): Promise<void> {
  await readServerEvents(await fetch(`/api/practice/attempts/${attempt_id}/stream`, { signal }), (name, data) => onEvent([name, data] as GradingEvent));
}
