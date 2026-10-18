// The one place that reads and writes the practice database (docs/practice-proposal.md §6).
import type { DatabaseSync } from 'node:sqlite';
import { inTransaction, openDatabase } from '../../../shared/server/sqlite.ts';
import type { AttemptAnswer, AttemptDetail, AttemptSummary, Exercise, ExerciseDetail, ExerciseSummary, ExerciseType, Feedback, LastAttempt } from '../api.ts';
import { exerciseTitleOf } from './exercise-import.ts';

const SCHEMA_VERSION = 1;
const ATTEMPT_LIST_LIMIT = 200;

// attempts is created now, so the grading milestone needs no migration. An attempt keeps a snapshot of its exercise
// and has no foreign key to it: replacing an exercise never changes or breaks history. AUTOINCREMENT: an id is never reused.
const CREATE_TABLES = [
  `CREATE TABLE exercises (
    id            TEXT    PRIMARY KEY,
    type          TEXT    NOT NULL CHECK (type IN ('sentence_translation', 'paragraph_translation', 'essay_translation',
                                                   'free_writing', 'error_correction')),
    content_json  TEXT    NOT NULL,
    position      INTEGER NOT NULL,
    source_file   TEXT    NOT NULL,
    imported_at   TEXT    NOT NULL,
    updated_at    TEXT    NOT NULL
  ) STRICT`,
  `CREATE TABLE attempts (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    exercise_id            TEXT    NOT NULL,
    exercise_type          TEXT    NOT NULL,
    exercise_snapshot_json TEXT    NOT NULL,
    answer_json            TEXT    NOT NULL,
    word_count             INTEGER NOT NULL,
    writing_ms             INTEGER,
    status                 TEXT    NOT NULL CHECK (status IN ('grading', 'graded', 'failed')),
    feedback_json          TEXT,
    raw_output             TEXT    NOT NULL DEFAULT '',
    error_kind             TEXT,
    error_message          TEXT,
    overall_band           REAL,
    error_count            INTEGER,
    major_error_count      INTEGER,
    requested_model_id     TEXT    NOT NULL,
    served_model_id        TEXT,
    effort                 TEXT    NOT NULL,
    submitted_at           TEXT    NOT NULL,
    graded_at              TEXT,
    grading_ms             INTEGER,
    output_tokens          INTEGER
  ) STRICT`,
  'CREATE INDEX attempts_by_time ON attempts (submitted_at)',
  'CREATE INDEX attempts_by_exercise ON attempts (exercise_id, submitted_at)',
];

// What createAttempt stores: the answer and how it will be graded, before any grading.
export interface NewAttempt {
  exercise: Exercise;
  answer: AttemptAnswer;
  word_count: number;
  writing_ms: number | null;
  requested_model_id: string;
  effort: string;
}

// How a grading ended. raw_output is the model's last reply ('' when there was none).
export type GradingOutcome =
  | { status: 'graded'; feedback: Feedback; error_count: number; major_error_count: number; overall_band: number | null; raw_output: string;
      served_model_id: string; grading_ms: number; output_tokens: number | null }
  | { status: 'failed'; error_kind: string; error_message: string; raw_output: string;
      served_model_id: string | null; grading_ms: number; output_tokens: number | null };

export interface PracticeStore {
  // All or nothing, in one transaction. A known id is replaced and keeps its place in the list.
  importExercises(exercises: Exercise[], source_file: string): { added: number; updated: number };
  // is_gradable: whether this version of the app can grade the type.
  listExercises(is_gradable: (type: ExerciseType) => boolean): ExerciseSummary[];
  readExercise(exercise_id: string): ExerciseDetail | null;
  // Saves the answer with status 'grading' and returns its id; committed before grading starts.
  createAttempt(attempt: NewAttempt): number;
  // A failed attempt goes back to 'grading', its last error cleared; false when it is not failed.
  restartGrading(attempt_id: number): boolean;
  finishGrading(attempt_id: number, outcome: GradingOutcome): void;
  readAttempt(attempt_id: number): AttemptDetail | null;
  // Newest first, at most ATTEMPT_LIST_LIMIT; a filter left out (null) matches every attempt.
  listAttempts(filters: { type: ExerciseType | null; exercise_id: string | null }): AttemptSummary[];
  // A server stopped mid-grading leaves 'grading' rows nobody will finish: they become failed / interrupted.
  failInterruptedGradings(): number;
}

export function openPracticeStore(database_path: string): PracticeStore {
  const database: DatabaseSync = openDatabase(database_path, SCHEMA_VERSION, (migrating_database, file_schema_version) => {
    if (file_schema_version === 0) for (const statement of CREATE_TABLES) migrating_database.exec(statement);
  });

  const select_exercise_id = database.prepare('SELECT id FROM exercises WHERE id = $id');
  const select_next_position = database.prepare('SELECT coalesce(max(position), 0) + 1 AS position FROM exercises');
  const insert_exercise = database.prepare(`
    INSERT INTO exercises (id, type, content_json, position, source_file, imported_at, updated_at)
    VALUES ($id, $type, $content_json, $position, $source_file, $now, $now)`);
  const update_exercise = database.prepare(`
    UPDATE exercises SET type = $type, content_json = $content_json, source_file = $source_file, updated_at = $now WHERE id = $id`);
  const select_summaries = database.prepare(`
    SELECT id, type, content_json, (SELECT count(*) FROM attempts WHERE attempts.exercise_id = exercises.id) AS attempt_count
    FROM exercises ORDER BY position`);
  const select_last_attempts = database.prepare(`
    SELECT exercise_id, id, status, error_count, overall_band, submitted_at FROM attempts AS outer_attempt
    WHERE id = (SELECT max(id) FROM attempts WHERE attempts.exercise_id = outer_attempt.exercise_id)`);
  const insert_attempt = database.prepare(`
    INSERT INTO attempts (exercise_id, exercise_type, exercise_snapshot_json, answer_json, word_count, writing_ms, status,
                          requested_model_id, effort, submitted_at)
    VALUES ($exercise_id, $exercise_type, $exercise_snapshot_json, $answer_json, $word_count, $writing_ms, 'grading',
            $requested_model_id, $effort, $submitted_at)`);
  const restart_grading = database.prepare(`
    UPDATE attempts SET status = 'grading', error_kind = NULL, error_message = NULL WHERE id = $id AND status = 'failed'`);
  const finish_graded = database.prepare(`
    UPDATE attempts SET status = 'graded', feedback_json = $feedback_json, raw_output = $raw_output, error_count = $error_count,
                        major_error_count = $major_error_count, overall_band = $overall_band, served_model_id = $served_model_id, graded_at = $now,
                        grading_ms = $grading_ms, output_tokens = $output_tokens, error_kind = NULL, error_message = NULL
    WHERE id = $id AND status = 'grading'`);
  const finish_failed = database.prepare(`
    UPDATE attempts SET status = 'failed', raw_output = $raw_output, error_kind = $error_kind, error_message = $error_message,
                        served_model_id = $served_model_id, grading_ms = $grading_ms, output_tokens = $output_tokens
    WHERE id = $id AND status = 'grading'`);
  const select_attempt = database.prepare('SELECT * FROM attempts WHERE id = $id');
  const select_attempt_summaries = database.prepare(`
    SELECT id, exercise_id, exercise_type, exercise_snapshot_json, status, error_count, overall_band, submitted_at FROM attempts
    WHERE ($type IS NULL OR exercise_type = $type) AND ($exercise_id IS NULL OR exercise_id = $exercise_id)
    ORDER BY id DESC LIMIT ${ATTEMPT_LIST_LIMIT}`);
  const fail_interrupted = database.prepare(`
    UPDATE attempts SET status = 'failed', error_kind = 'interrupted', error_message = 'The server stopped while grading.'
    WHERE status = 'grading'`);
  const select_exercise = database.prepare('SELECT id, content_json FROM exercises WHERE id = $id');

  function importExercises(exercises: Exercise[], source_file: string): { added: number; updated: number } {
    const now = new Date().toISOString();
    return inTransaction(database, () => {
      let added = 0;
      let updated = 0;
      for (const exercise of exercises) {
        const row = { id: exercise.id, type: exercise.type, content_json: JSON.stringify(exercise), source_file, now };
        if (select_exercise_id.get({ id: exercise.id })) {
          update_exercise.run(row);
          updated += 1;
        } else {
          const { position } = select_next_position.get() as { position: number };
          insert_exercise.run({ ...row, position });
          added += 1;
        }
      }
      return { added, updated };
    });
  }

  function listExercises(is_gradable: (type: ExerciseType) => boolean): ExerciseSummary[] {
    const last_attempts = new Map((select_last_attempts.all() as unknown as (LastAttempt & { exercise_id: string })[])
      .map(({ exercise_id, ...last_attempt }) => [exercise_id, last_attempt]));
    return (select_summaries.all() as { id: string; type: ExerciseType; content_json: string; attempt_count: number }[])
      .map(({ id, type, content_json, attempt_count }) => {
        const exercise = JSON.parse(content_json) as Exercise;
        return {
          id, type, title: exerciseTitleOf(exercise), topic: exercise.topic ?? null, attempt_count,
          last_attempt: last_attempts.get(id) ?? null, is_gradable: is_gradable(type),
        };
      });
  }

  // null when no exercise has this id.
  function readExercise(exercise_id: string): ExerciseDetail | null {
    const row = select_exercise.get({ id: exercise_id }) as { id: string; content_json: string } | undefined;
    return row ? { id: row.id, exercise: JSON.parse(row.content_json) as Exercise } : null;
  }

  function createAttempt({ exercise, answer, word_count, writing_ms, requested_model_id, effort }: NewAttempt): number {
    return Number(insert_attempt.run({
      exercise_id: exercise.id, exercise_type: exercise.type, exercise_snapshot_json: JSON.stringify(exercise),
      answer_json: JSON.stringify(answer), word_count, writing_ms, requested_model_id, effort, submitted_at: new Date().toISOString(),
    }).lastInsertRowid);
  }

  function restartGrading(attempt_id: number): boolean {
    return restart_grading.run({ id: attempt_id }).changes > 0;
  }

  // Only a 'grading' row is finished, so a late result can never overwrite a graded attempt.
  function finishGrading(attempt_id: number, outcome: GradingOutcome): void {
    const { raw_output, served_model_id, grading_ms, output_tokens } = outcome;
    if (outcome.status === 'graded') {
      finish_graded.run({
        id: attempt_id, feedback_json: JSON.stringify(outcome.feedback), raw_output, error_count: outcome.error_count,
        major_error_count: outcome.major_error_count, overall_band: outcome.overall_band, served_model_id, now: new Date().toISOString(), grading_ms, output_tokens,
      });
    } else {
      finish_failed.run({
        id: attempt_id, raw_output, error_kind: outcome.error_kind, error_message: outcome.error_message, served_model_id,
        grading_ms, output_tokens,
      });
    }
  }

  // null when no attempt has this id.
  function readAttempt(attempt_id: number): AttemptDetail | null {
    const row = select_attempt.get({ id: attempt_id }) as Record<string, any> | undefined;
    if (!row) return null;
    const { exercise_snapshot_json, answer_json, feedback_json, output_tokens: _output_tokens, ...columns } = row;
    return {
      ...columns,
      exercise_snapshot: JSON.parse(exercise_snapshot_json),
      answer: JSON.parse(answer_json),
      feedback: feedback_json === null ? null : JSON.parse(feedback_json),
    } as AttemptDetail;
  }

  function listAttempts({ type, exercise_id }: { type: ExerciseType | null; exercise_id: string | null }): AttemptSummary[] {
    return (select_attempt_summaries.all({ type, exercise_id }) as (Omit<AttemptSummary, 'title'> & { exercise_snapshot_json: string })[])
      .map(({ exercise_snapshot_json, ...columns }) => ({ ...columns, title: exerciseTitleOf(JSON.parse(exercise_snapshot_json) as Exercise) }));
  }

  function failInterruptedGradings(): number {
    return Number(fail_interrupted.run().changes);
  }

  return { importExercises, listExercises, readExercise, createAttempt, restartGrading, finishGrading, readAttempt, listAttempts, failInterruptedGradings };
}
