// The Practice contract: the import file format and the HTTP API between features/practice/server and
// features/practice/web (docs/practice-import-format.md). Types only, erased before anything runs.
import type { Effort, EffortOption, ModelOption } from '../../shared/api.ts';

// ---- The import file: one file is one project ----

export type RewriteLength = 'sentence' | 'paragraph' | 'essay';

export interface RewriteContent {
  instruction: string;
  text: string;
  length: RewriteLength;
  // 'vi' makes it a translation. Default 'en'.
  source_lang?: 'en' | 'vi';
  // The answer box starts with `text`: error correction.
  prefill?: boolean;
  // Up to 3 chips the grader checks.
  constraints?: string[];
  // Planted mistakes; each `wrong` appears once in `text`.
  mistakes?: PlantedMistake[];
  // A model answer for the grader only.
  reference?: string;
}

export interface PlantedMistake {
  wrong: string;
  right: string;
  note?: string;
}

export interface WriteContent {
  prompt: string;
  // Default 250.
  min_words?: number;
  // A guide, never a limit.
  minutes?: number;
  // Shown after grading.
  sample?: string;
}

export interface ChoiceOption {
  text: string;
  why: string;
  correct?: boolean;
}

// One correct option is single choice; two or more is multi-select.
export interface ChoiceContent {
  question: string;
  context?: string;
  options: ChoiceOption[];
}

export interface FillGap {
  // A string or a list of accepted answers.
  answer: string | string[];
  hint?: string;
  why?: string;
}

// `text` holds the markers {{1}} {{2}} ..., one per gap, in order.
export interface FillContent {
  text: string;
  gaps: FillGap[];
  instruction?: string;
}

export interface FlashcardContent {
  front: string;
  back: string;
  hint?: string;
  example?: string;
  // Markdown: the concept and a worked explanation, shown under the answer.
  explanation?: string;
}

export interface ContentByType {
  rewrite: RewriteContent;
  write: WriteContent;
  choice: ChoiceContent;
  fill: FillContent;
  flashcard: FlashcardContent;
}

export type ExerciseType = keyof ContentByType;

// An exercise as the file means it, and as an attempt keeps it: type, topic, tags and content.
export interface ExerciseBody<Type extends ExerciseType = ExerciseType> {
  type: Type;
  topic: string | null;
  tags: string[];
  content: ContentByType[Type];
}

export interface FileExercise extends ExerciseBody {
  // The file's id: a-z 0-9 -, unique in the file.
  key: string;
}

export interface ProjectFile {
  name: string;
  description: string;
  exercises: FileExercise[];
}

// ---- Answers and results ----

export type Rating = 'unknown' | 'almost' | 'known';

export interface AnswerByType {
  rewrite: { text: string };
  write: { text: string };
  // Option indexes.
  choice: { chosen: number[] };
  fill: { gaps: string[] };
  flashcard: { rating: Rating };
}

// What the AI grader wrote for every type but a flashcard: free text (Markdown) and how it was made. It is shown as written, never parsed.
// thinking_text is the grader's thinking summary ('' when it did not think), thinking_ms how long it thought (null: it did not).
// effort is null for an attempt graded before the picker existed.
export interface AiResult {
  text: string;
  thinking_text: string;
  thinking_ms: number | null;
  model: string;
  effort: Effort | null;
  ms: number;
}

export interface ResultByType {
  rewrite: AiResult;
  write: AiResult;
  choice: AiResult;
  fill: AiResult;
  flashcard: { rating: Rating };
}

// ---- HTTP ----

export type AttemptStatus = 'grading' | 'graded' | 'failed';

// One attempt: all a reopened page needs. `exercise` is the snapshot: the exercise as it was when you answered.
export interface AttemptView<Type extends ExerciseType = ExerciseType> {
  id: number;
  project_id: number;
  exercise_id: number;
  submitted_at: string;
  status: AttemptStatus;
  // The history line's result ("Graded", "Almost"); null until graded.
  summary: string | null;
  // Why grading failed; null otherwise.
  error: string | null;
  writing_ms: number | null;
  exercise: ExerciseBody<Type>;
  answer: AnswerByType[Type];
  // null unless graded.
  result: ResultByType[Type] | null;
}

// What an AI grading runs with: the model and effort the person picked (the same options as Claude Translate).
export interface GradingSettings {
  model_id: string;
  effort: Effort;
}

// GET /api/practice/grading-options
export interface GradingOptions {
  models: ModelOption[];
  efforts: EffortOption[];
  default_model_id: string;
  default_effort: Effort;
}

// POST /api/practice/attempts. The answer's shape depends on the exercise's type. model_id and effort are the grading's
// settings (a flashcard ignores them): the defaults apply when one is left out, and a value that is not offered is a 400.
export interface CreateAttemptRequest extends Partial<GradingSettings> {
  exercise_id: number;
  answer: AnswerByType[ExerciseType];
  // From opening the exercise to Submit; null when unknown.
  writing_ms: number | null;
}

// POST /api/practice/attempts/:id/regrade body: the settings of the new grading, as above.
export type RegradeRequest = Partial<GradingSettings>;

// GET /api/practice/attempts/:id/stream: Server-Sent Events (`event: name` + `data: json`), the same wire format as Claude Translate's.
// A grading in progress sends `snapshot` first (what it has produced so far), then the rest as it happens. Whatever else the
// stream says, `done`, `error` and `finished` mean the same: read the attempt for the final state.
export interface GradingStreamEvents {
  snapshot: { thinking_text: string; thinking_ms: number | null; text: string; model_id: string; effort: Effort; elapsed_ms: number };
  thinking_delta: { text: string };
  thinking_done: { duration_ms: number };
  text_delta: { text: string };
  retry: { attempt: number; max_retries: number; error: string };
  fallback: { from_model_id: string; to_model_id: string };
  done: Record<string, never>;
  error: { message: string };
  // The attempt is not being graded (it is done, failed or a flashcard).
  finished: Record<string, never>;
}

// GET /api/practice/exercises/:id
export interface ExerciseView extends ExerciseBody {
  id: number;
  project_id: number;
}

// One exercise in a list: what a person needs to pick it.
export interface ExerciseItem {
  id: number;
  type: ExerciseType;
  // "Rewrite sentence", "Multiple choice" (text.ts).
  kind: string;
  preview: string;
  topic: string | null;
  // It has a graded attempt.
  done: boolean;
}

// The latest attempt of an exercise, for the History bar.
export interface HistoryItem {
  attempt_id: number;
  exercise_id: number;
  kind: string;
  preview: string;
  status: AttemptStatus;
  summary: string | null;
  submitted_at: string;
}

export interface ProjectSummary {
  id: number;
  name: string;
  description: string;
  created_at: string;
  // null until the first attempt.
  last_activity_at: string | null;
  exercise_count: number;
  done_count: number;
  type_counts: Partial<Record<ExerciseType, number>>;
}

// GET /api/practice/projects/:id
export interface ProjectDetail {
  project: ProjectSummary;
  // In file order.
  exercises: ExerciseItem[];
  // One per exercise tried, newest first.
  history: HistoryItem[];
}

// POST /api/practice/projects { name, description, file } -> 201 { id }.
// POST /api/practice/projects/:id/exercises { file } -> 200 { added }.
// `file` is the file's text. 400 { errors } when it has problems; nothing is imported.
export interface ImportRequest {
  name?: string;
  description?: string;
  file: string;
}
