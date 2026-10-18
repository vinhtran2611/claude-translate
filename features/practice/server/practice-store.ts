// The one place that reads and writes the practice database (docs/practice-proposal.md §6).
import type { DatabaseSync } from 'node:sqlite';
import { inTransaction, openDatabase } from '../../../shared/server/sqlite.ts';
import type { Exercise, ExerciseDetail, ExerciseSummary } from '../api.ts';
import { exerciseTitleOf } from './exercise-import.ts';

const SCHEMA_VERSION = 1;

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

export interface PracticeStore {
  // All or nothing, in one transaction. A known id is replaced and keeps its place in the list.
  importExercises(exercises: Exercise[], source_file: string): { added: number; updated: number };
  listExercises(): ExerciseSummary[];
  readExercise(exercise_id: string): ExerciseDetail | null;
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

  function listExercises(): ExerciseSummary[] {
    return (select_summaries.all() as { id: string; type: ExerciseSummary['type']; content_json: string; attempt_count: number }[])
      .map(({ id, type, content_json, attempt_count }) => {
        const exercise = JSON.parse(content_json) as Exercise;
        return { id, type, title: exerciseTitleOf(exercise), topic: exercise.topic ?? null, attempt_count };
      });
  }

  // null when no exercise has this id.
  function readExercise(exercise_id: string): ExerciseDetail | null {
    const row = select_exercise.get({ id: exercise_id }) as { id: string; content_json: string } | undefined;
    return row ? { id: row.id, exercise: JSON.parse(row.content_json) as Exercise } : null;
  }

  return { importExercises, listExercises, readExercise };
}
