// The Practice contract: the exercise file format and the HTTP API between features/practice/server and
// features/practice/web (see docs/practice-proposal.md §4 and §7.4). Types only, erased before anything runs.
import type { ErrorCategory } from './categories.ts';

export type ExerciseType = 'sentence_translation' | 'paragraph_translation' | 'essay_translation' | 'free_writing' | 'error_correction';
export type EssayType = 'opinion' | 'discussion' | 'advantages_disadvantages' | 'problem_solution' | 'two_part';

// One import file. schema_version is 1; 1 to 500 exercises.
export interface ExerciseFile {
  schema_version: 1;
  exercises: Exercise[];
}

export type Exercise = SentenceTranslation | ParagraphTranslation | EssayTranslation | FreeWriting | ErrorCorrection;

interface ExerciseBase {
  // Unique across all your files: ^[a-z0-9][a-z0-9-]{0,63}$, e.g. "w03-s01".
  id: string;
  // A short label for lists; default: the first words of the text.
  title?: string;
  topic?: string;
  // The grammar or vocabulary points the exercise trains, e.g. ["present perfect"].
  focus?: string[];
}

export interface SentenceTranslation extends ExerciseBase {
  type: 'sentence_translation';
  text_vi: string;
  // One good translation; the grader treats it as one option, not the only one.
  reference_en?: string;
}

export interface ParagraphTranslation extends ExerciseBase {
  type: 'paragraph_translation';
  text_vi: string;
  reference_en?: string;
}

export interface EssayTranslation extends ExerciseBase {
  type: 'essay_translation';
  // The Task 2 question, in Vietnamese.
  prompt_vi: string;
  // A full sample answer in Vietnamese; paragraphs separated by a blank line.
  essay_vi: string;
  reference_prompt_en?: string;
  reference_essay_en?: string;
}

export interface FreeWriting extends ExerciseBase {
  type: 'free_writing';
  prompt_en: string;
  essay_type: EssayType;
  // Default 250.
  min_words?: number;
  // Default 40; shown only, never enforced.
  time_limit_minutes?: number;
  // Shown after grading, never before you write.
  sample_essay_en?: string;
}

export interface ErrorCorrection extends ExerciseBase {
  type: 'error_correction';
  length: 'sentence' | 'paragraph' | 'essay';
  // English text with planted mistakes.
  text_en: string;
  mistakes: PlantedMistake[];
  // text_en with every mistake fixed.
  corrected_en: string;
}

export interface PlantedMistake {
  // Exact words from text_en; they appear exactly once in it.
  wrong: string;
  correct: string;
  category: ErrorCategory;
  note?: string;
}

// A problem in an import file; path names the field, e.g. "exercises[3].text_vi".
export interface ImportProblem {
  path: string;
  message: string;
}

// POST /api/practice/exercises/import: 200 with this, or 400 with { errors: ImportProblem[] } and nothing imported.
export interface ImportResult {
  added: number;
  updated: number;
  warnings: ImportProblem[];
}

// GET /api/practice/exercises, in file order.
export interface ExerciseSummary {
  id: string;
  type: ExerciseType;
  title: string;
  topic: string | null;
  attempt_count: number;
  last_attempt: LastAttempt | null;
  // Whether this version of the app can grade the type.
  is_gradable: boolean;
}

// GET /api/practice/exercises/:id
export interface ExerciseDetail {
  id: string;
  exercise: Exercise;
}

// What Claude returns for one answer (docs/practice-proposal.md §5.4), checked by the server before it is stored.
export interface Feedback {
  feedback_version: 1;
  categories_version: 1;
  // 1–3 short sentences.
  summary: string;
  // 0–2 short items.
  strengths: string[];
  // 0–40, in answer order.
  errors: FeedbackError[];
  // The answer with only the errors fixed.
  corrected_text: string;
  // 1–3 lessons, most important first.
  remember: string[];
  // Translation types.
  meaning?: 'complete' | 'minor_loss' | 'major_loss';
  // Sentence and paragraph translation: how a strong writer would say it.
  natural_version?: string;
  // Essay translation: your English task with only its errors fixed (corrected_text is the essay).
  corrected_prompt_text?: string;
  // Free writing: all 4 criteria. Essay translation: lexical_resource and grammatical_range_accuracy only, since the
  // ideas and structure come from the Vietnamese sample.
  bands?: Bands;
  // Error correction: one per planted mistake, in the exercise's order.
  key_results?: KeyResult[];
}

// Did you fix one planted mistake? Any correct fix counts, not only the listed one.
export interface KeyResult {
  // Index in the exercise's mistakes.
  mistake_index: number;
  status: 'fixed' | 'partly' | 'missed';
  // What you wrote in that place.
  learner_text: string;
  comment?: string;
}

// Estimates from a model, often off by 0.5 to 1.0; the page always calls them estimates.
export interface Bands {
  task_response?: Criterion;
  coherence_cohesion?: Criterion;
  lexical_resource: Criterion;
  grammatical_range_accuracy: Criterion;
}

export interface Criterion {
  // 0 to 9 in steps of 0.5.
  band: number;
  // 1 to 2 sentences.
  comment: string;
  // One concrete action towards the next band.
  next_step: string;
}

export interface FeedbackError {
  // Essay translation only: which of your two texts the error is in.
  part?: 'prompt' | 'essay';
  // Exact words from the answer.
  original: string;
  correction: string;
  category: ErrorCategory;
  severity: 'major' | 'minor';
  // Why it is wrong.
  explanation: string;
  // What to remember.
  rule: string;
}

export type AttemptStatus = 'grading' | 'graded' | 'failed';

export interface AttemptAnswer {
  // The essay for essay types, else the whole answer.
  text: string;
  // Essay translation only: your English version of the task.
  prompt_text?: string;
}

// POST /api/practice/attempts -> 201 { attempt_id }: the answer is saved before grading starts.
export interface CreateAttemptRequest {
  exercise_id: string;
  answer: AttemptAnswer;
  // From opening the exercise to Submit; null when unknown.
  writing_ms: number | null;
}

// GET /api/practice/attempts/:id
export interface AttemptDetail {
  id: number;
  exercise_id: string;
  exercise_type: ExerciseType;
  // The exercise exactly as it was when you answered.
  exercise_snapshot: Exercise;
  answer: AttemptAnswer;
  word_count: number;
  writing_ms: number | null;
  status: AttemptStatus;
  // null unless status is 'graded'.
  feedback: Feedback | null;
  // The model's last raw reply; '' when there was none.
  raw_output: string;
  error_kind: string | null;
  error_message: string | null;
  error_count: number | null;
  major_error_count: number | null;
  // Free writing only: the mean of the 4 criteria, rounded down to 0.5; computed by the server.
  overall_band: number | null;
  requested_model_id: string;
  served_model_id: string | null;
  effort: string;
  submitted_at: string;
  graded_at: string | null;
  grading_ms: number | null;
}

// The latest attempt of an exercise, as the list shows it.
export interface LastAttempt {
  id: number;
  status: AttemptStatus;
  error_count: number | null;
  overall_band: number | null;
  submitted_at: string;
}

// GET /api/practice/attempts?type=&exercise_id=, newest first, at most 200.
export interface AttemptSummary {
  id: number;
  exercise_id: string;
  exercise_type: ExerciseType;
  // From the exercise as it was when you answered.
  title: string;
  status: AttemptStatus;
  error_count: number | null;
  overall_band: number | null;
  submitted_at: string;
}
