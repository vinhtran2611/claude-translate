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
}

// GET /api/practice/exercises/:id
export interface ExerciseDetail {
  id: string;
  exercise: Exercise;
}
