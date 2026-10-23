// One request to the server, as JSON, for every page. Throws an ApiError when the answer is not ok, read the same way
// for every feature: the JSON API's one error shape when the body has it, else the body text as the message.
import type { ApiErrorBody, ApiProblem } from '../api-types.ts';

// A non-2xx answer: its status and the API's one error shape (docs/practice-api-design.md §3.3).
export class ApiError extends Error {
  status: number;
  code: string;
  problems: ApiProblem[];
  // The error object as sent, for the fields a code adds: a 409 "generating" names its generationId.
  fields: Record<string, unknown>;

  constructor(status: number, code: string, message: string, problems: ApiProblem[] = [], fields: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.problems = problems;
    this.fields = fields;
  }
}

// A JSON API error keeps its code and problems; any other answer (Translate's plain-text errors, a proxy, a crash
// before the server answered) keeps its status and text.
async function apiErrorOf(response: Response): Promise<ApiError> {
  const text = await response.text();
  try {
    const { error } = JSON.parse(text) as ApiErrorBody;
    return new ApiError(response.status, error.code, error.message, error.problems, error);
  } catch {
    return new ApiError(response.status, 'http', text || `HTTP ${response.status}`);
  }
}

// Body: what the endpoint answers (see the feature's api-types.ts); null for a 204.
export async function fetchJson<Body>(url: string, options: RequestInit = {}): Promise<Body> {
  const response = await fetch(url, options);
  if (!response.ok) throw await apiErrorOf(response);
  if (response.status === 204) return null as Body;
  return (await response.json()) as Body;
}
