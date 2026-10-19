// The one place that reads and writes the practice database (docs/practice-proposal.md §4).
import type { DatabaseSync } from 'node:sqlite';
import type { Effort } from '../../../shared/api.ts';
import { inTransaction, openDatabase } from '../../../shared/server/sqlite.ts';
import type {
  AiResult, AnswerByType, AttemptStatus, AttemptView, ExerciseBody, ExerciseItem, ExerciseType, ExerciseView, FileExercise, HistoryItem,
  ProjectDetail, ProjectFile, ProjectSummary, ResultByType,
} from '../api.ts';
import { kindOf, previewOf } from '../text.ts';

const SCHEMA_VERSION = 2;
// The history line of an AI-graded attempt: the grader's text is not parsed, so there is nothing more to say.
const AI_SUMMARY = 'Graded';
const TYPES = "('rewrite', 'write', 'choice', 'fill', 'flashcard')";
// A key: a-z, 0-9 and -, not starting with -, 1 to 64 characters (KEY_PATTERN in import-check.ts).
const KEY_CHECK = "CHECK (length(key) BETWEEN 1 AND 64 AND key NOT GLOB '*[^a-z0-9-]*' AND key NOT GLOB '-*')";

// An attempt keeps a snapshot of its exercise, so nothing done to an exercise later can change what it shows; deleting an
// exercise keeps its attempts (exercise_id becomes NULL, exercise_key stays). AUTOINCREMENT: an id is never reused.
// docs/practice-api-design.md §2.7.
const CREATE_TABLES = [
  `CREATE TABLE projects (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    key              TEXT    NOT NULL UNIQUE ${KEY_CHECK},
    name             TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    description      TEXT    NOT NULL DEFAULT '' CHECK (length(description) <= 500),
    archived_at      TEXT,
    created_at       TEXT    NOT NULL,
    updated_at       TEXT    NOT NULL,
    last_activity_at TEXT
  ) STRICT`,
  `CREATE TABLE exercises (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id   INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    key          TEXT    NOT NULL ${KEY_CHECK},
    position     INTEGER NOT NULL,
    type         TEXT    NOT NULL CHECK (type IN ${TYPES}),
    topic        TEXT,
    tags_json    TEXT    NOT NULL CHECK (json_valid(tags_json)),
    content_json TEXT    NOT NULL CHECK (json_valid(content_json)),
    version      INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at   TEXT    NOT NULL,
    updated_at   TEXT    NOT NULL,
    UNIQUE (project_id, key)
  ) STRICT`,
  'CREATE INDEX exercises_by_position ON exercises (project_id, position)',
  `CREATE TABLE attempts (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id             INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    exercise_id            INTEGER REFERENCES exercises (id) ON DELETE SET NULL,
    exercise_key           TEXT    NOT NULL,
    exercise_version       INTEGER NOT NULL,
    submitted_at           TEXT    NOT NULL,
    type                   TEXT    NOT NULL CHECK (type IN ${TYPES}),
    exercise_snapshot_json TEXT    NOT NULL CHECK (json_valid(exercise_snapshot_json)),
    answer_json            TEXT    NOT NULL CHECK (json_valid(answer_json)),
    status                 TEXT    NOT NULL CHECK (status IN ('grading', 'graded', 'failed')),
    result_json            TEXT    CHECK (result_json IS NULL OR json_valid(result_json)),
    summary                TEXT,
    grader                 TEXT    NOT NULL CHECK (grader IN ('ai', 'self')),
    model                  TEXT,
    effort                 TEXT,
    grading_ms             INTEGER,
    error                  TEXT,
    writing_ms             INTEGER,
    graded_at              TEXT
  ) STRICT`,
  'CREATE INDEX attempts_by_exercise ON attempts (exercise_id, id)',
  'CREATE INDEX attempts_by_project ON attempts (project_id, id)',
];

// A key made from a name: "Day 1 - 19/10/2026" -> "day-1-19-10-2026". When it is taken (or the name has no letters
// or digits), "-{id}" is added, so the key is unique without asking anyone.
export function keyFromName(name: string, id: number, is_taken: (key: string) => boolean): string {
  const base = name.toLowerCase().replaceAll('đ', 'd').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 64).replace(/-+$/, '');
  if (base !== '' && !is_taken(base)) return base;
  const suffix = `-${id}`;
  return `${(base || 'project').slice(0, 64 - suffix.length).replace(/-+$/, '')}${suffix}`;
}

// Schema 1 -> 2 (docs/practice-api-design.md §6, step 2): keys for projects, versions and times for exercises, the
// exercise's key and version and the effort on attempts, and ON DELETE rules. SQLite cannot change a foreign key, so
// each table is renamed, made again from CREATE_TABLES, filled from the old one, and the old one dropped. Ids and the
// AUTOINCREMENT counters are kept. The caller has made a backup and runs this in one transaction with foreign keys off.
function migrateFrom1(database: DatabaseSync): void {
  const TABLES = ['projects', 'exercises', 'attempts'];
  const countOf = (table: string): number => (database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count;
  database.exec('DROP INDEX attempts_by_exercise; DROP INDEX attempts_by_project');
  for (const table of TABLES) database.exec(`ALTER TABLE ${table} RENAME TO ${table}_v1`);
  for (const statement of CREATE_TABLES) database.exec(statement);
  const insert_project = database.prepare(`
    INSERT INTO projects (id, key, name, description, created_at, updated_at, last_activity_at)
    VALUES ($id, $key, $name, $description, $created_at, $created_at, $last_activity_at)`);
  const keys = new Set<string>();
  for (const row of database.prepare('SELECT id, name, description, created_at, last_activity_at FROM projects_v1 ORDER BY id').all() as Record<string, string | number | null>[]) {
    const key = keyFromName(row.name as string, row.id as number, (candidate) => keys.has(candidate));
    keys.add(key);
    insert_project.run({ ...row, key });
  }
  database.exec(`
    INSERT INTO exercises (id, project_id, key, position, type, topic, tags_json, content_json, version, created_at, updated_at)
    SELECT exercise.id, exercise.project_id, exercise.key, exercise.position, exercise.type, exercise.topic, exercise.tags_json, exercise.content_json,
           1, project.created_at, project.created_at
    FROM exercises_v1 AS exercise JOIN projects_v1 AS project ON project.id = exercise.project_id`);
  database.exec(`
    INSERT INTO attempts (id, project_id, exercise_id, exercise_key, exercise_version, submitted_at, type, exercise_snapshot_json, answer_json,
                          status, result_json, summary, grader, model, effort, grading_ms, error, writing_ms, graded_at)
    SELECT attempt.id, attempt.project_id, attempt.exercise_id, exercise.key, 1, attempt.submitted_at, attempt.type, attempt.exercise_snapshot_json,
           attempt.answer_json, attempt.status, attempt.result_json, attempt.summary, attempt.grader, attempt.model,
           CASE WHEN attempt.grader = 'ai' THEN json_extract(attempt.result_json, '$.effort') END,
           attempt.grading_ms, attempt.error, attempt.writing_ms, attempt.graded_at
    FROM attempts_v1 AS attempt JOIN exercises_v1 AS exercise ON exercise.id = attempt.exercise_id`);
  for (const table of TABLES) {
    if (countOf(table) !== countOf(`${table}_v1`)) throw new Error(`migrating ${table} would lose rows (${countOf(`${table}_v1`)} -> ${countOf(table)})`);
    // The new table's counter starts where the old one was, so no id is ever given twice.
    database.exec(`
      INSERT INTO sqlite_sequence (name, seq) SELECT '${table}', seq FROM sqlite_sequence
      WHERE name = '${table}_v1' AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = '${table}')`);
    database.exec(`UPDATE sqlite_sequence SET seq = max(seq, (SELECT seq FROM sqlite_sequence WHERE name = '${table}_v1')) WHERE name = '${table}'`);
  }
  for (const table of [...TABLES].reverse()) database.exec(`DROP TABLE ${table}_v1`);
}

// What createAttempt stores. `outcome` null: the AI will grade it; otherwise it is already graded (a flashcard).
export interface NewAttempt {
  exercise: ExerciseView;
  answer: AnswerByType[ExerciseType];
  writing_ms: number | null;
  grader: 'ai' | 'self';
  outcome: { result: ResultByType[ExerciseType]; summary: string } | null;
}

// How an AI grading ended: the text it wrote, or why it failed.
export type GradingOutcome =
  | { status: 'graded'; text: string; thinking_text: string; thinking_ms: number | null; model: string; effort: Effort; grading_ms: number }
  | { status: 'failed'; error: string; model: string | null; grading_ms: number };

export interface PracticeStore {
  listProjects(): ProjectSummary[];
  readProject(project_id: number): ProjectDetail | null;
  createProject(file: ProjectFile): number;
  // Appends in file order. A key already in the project adds nothing and is returned. null: no such project.
  addExercises(project_id: number, exercises: FileExercise[]): { added: number } | { duplicate_keys: string[] } | null;
  readExercise(exercise_id: number): ExerciseView | null;
  createAttempt(attempt: NewAttempt): AttemptView;
  // A failed attempt goes back to 'grading', its error cleared; false when it is not failed.
  restartGrading(attempt_id: number): boolean;
  finishGrading(attempt_id: number, outcome: GradingOutcome): void;
  readAttempt(attempt_id: number): AttemptView | null;
  // A server stopped mid-grading leaves 'grading' rows nobody will finish: they become failed.
  failInterruptedGradings(): number;
}

interface ExerciseRow {
  id: number;
  project_id: number;
  type: ExerciseType;
  topic: string | null;
  tags_json: string;
  content_json: string;
}

interface AttemptRow {
  id: number;
  project_id: number;
  exercise_id: number;
  submitted_at: string;
  type: ExerciseType;
  exercise_snapshot_json: string;
  answer_json: string;
  status: AttemptStatus;
  result_json: string | null;
  summary: string | null;
  error: string | null;
  writing_ms: number | null;
}

function bodyOf(row: Pick<ExerciseRow, 'type' | 'topic' | 'tags_json' | 'content_json'>): ExerciseBody {
  return { type: row.type, topic: row.topic, tags: JSON.parse(row.tags_json), content: JSON.parse(row.content_json) };
}

// A row whose JSON has the wrong shape still lists: with its type as the name and no preview.
function describe(body: ExerciseBody): { kind: string; preview: string } {
  try {
    return { kind: kindOf(body), preview: previewOf(body) };
  } catch {
    return { kind: body.type, preview: '' };
  }
}

// An AI result written before the thinking summary and the effort were kept lacks them.
function resultOf(type: ExerciseType, result_json: string | null): ResultByType[ExerciseType] | null {
  if (result_json === null) return null;
  const result = JSON.parse(result_json);
  return type !== 'flashcard' ? { thinking_text: '', thinking_ms: null, effort: null, ...result } : result;
}

function attemptViewOf(row: AttemptRow): AttemptView {
  const { type, exercise_snapshot_json, answer_json, result_json, ...columns } = row;
  return { ...columns, exercise: JSON.parse(exercise_snapshot_json), answer: JSON.parse(answer_json), result: resultOf(type, result_json) } as AttemptView;
}

export function openPracticeStore(database_path: string): PracticeStore {
  const database: DatabaseSync = openDatabase(database_path, SCHEMA_VERSION, (migrating_database, file_schema_version) => {
    if (file_schema_version === 0) for (const statement of CREATE_TABLES) migrating_database.exec(statement);
    else if (file_schema_version === 1) migrateFrom1(migrating_database);
  });
  database.exec('PRAGMA foreign_keys = ON');

  const insert_project = database.prepare('INSERT INTO projects (key, name, description, created_at, updated_at) VALUES ($key, $name, $description, $now, $now)');
  const select_project_key = database.prepare('SELECT 1 FROM projects WHERE key = $key');
  const select_next_project_id = database.prepare("SELECT coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'projects'), 0) + 1 AS id");
  const insert_exercise = database.prepare(`
    INSERT INTO exercises (project_id, key, position, type, topic, tags_json, content_json, created_at, updated_at)
    VALUES ($project_id, $key, $position, $type, $topic, $tags_json, $content_json, $now, $now)`);
  const select_exercise_version = database.prepare('SELECT key, version FROM exercises WHERE id = $id');
  const select_project_id = database.prepare('SELECT id FROM projects WHERE id = $id');
  const select_keys = database.prepare('SELECT key FROM exercises WHERE project_id = $project_id');
  const select_position = database.prepare('SELECT coalesce(max(position), 0) AS position FROM exercises WHERE project_id = $project_id');
  const select_projects = database.prepare(`
    SELECT id, name, description, created_at, last_activity_at,
           (SELECT count(*) FROM exercises WHERE project_id = projects.id) AS exercise_count,
           (SELECT count(DISTINCT exercise_id) FROM attempts WHERE project_id = projects.id AND status = 'graded') AS done_count
    FROM projects WHERE $id IS NULL OR id = $id ORDER BY id`);
  const select_type_counts = database.prepare('SELECT project_id, type, count(*) AS count FROM exercises GROUP BY project_id, type');
  const select_exercises = database.prepare(`
    SELECT id, project_id, type, topic, tags_json, content_json,
           EXISTS (SELECT 1 FROM attempts WHERE exercise_id = exercises.id AND status = 'graded') AS done
    FROM exercises WHERE project_id = $project_id ORDER BY position`);
  const select_latest_attempts = database.prepare(`
    SELECT id, exercise_id, type, exercise_snapshot_json, status, summary, submitted_at FROM attempts
    WHERE project_id = $project_id AND id = (SELECT max(id) FROM attempts AS later WHERE later.exercise_id = attempts.exercise_id)
    ORDER BY id DESC`);
  const select_exercise = database.prepare('SELECT id, project_id, type, topic, tags_json, content_json FROM exercises WHERE id = $id');
  const insert_attempt = database.prepare(`
    INSERT INTO attempts (project_id, exercise_id, exercise_key, exercise_version, submitted_at, type, exercise_snapshot_json, answer_json, status,
                          result_json, summary, grader, writing_ms, graded_at)
    VALUES ($project_id, $exercise_id, $exercise_key, $exercise_version, $now, $type, $exercise_snapshot_json, $answer_json, $status,
            $result_json, $summary, $grader, $writing_ms, $graded_at)`);
  const touch_project = database.prepare('UPDATE projects SET last_activity_at = $now WHERE id = $id');
  const select_attempt = database.prepare(`
    SELECT id, project_id, exercise_id, submitted_at, type, exercise_snapshot_json, answer_json, status, result_json, summary, error, writing_ms
    FROM attempts WHERE id = $id`);
  const restart_grading = database.prepare("UPDATE attempts SET status = 'grading', error = NULL WHERE id = $id AND status = 'failed'");
  // Only a 'grading' row is finished, so a late result can never overwrite a graded attempt.
  const finish_graded = database.prepare(`
    UPDATE attempts SET status = 'graded', result_json = $result_json, summary = $summary, model = $model, effort = $effort,
                        grading_ms = $grading_ms, graded_at = $now, error = NULL
    WHERE id = $id AND status = 'grading'`);
  const finish_failed = database.prepare("UPDATE attempts SET status = 'failed', error = $error, model = $model, grading_ms = $grading_ms WHERE id = $id AND status = 'grading'");
  const fail_interrupted = database.prepare("UPDATE attempts SET status = 'failed', error = 'The server stopped while grading.' WHERE status = 'grading'");

  function summariesOf(project_id: number | null): ProjectSummary[] {
    const type_counts = new Map<number, Partial<Record<ExerciseType, number>>>();
    for (const { project_id: id, type, count } of select_type_counts.all() as { project_id: number; type: ExerciseType; count: number }[]) {
      type_counts.set(id, { ...type_counts.get(id), [type]: count });
    }
    return (select_projects.all({ id: project_id }) as Omit<ProjectSummary, 'type_counts'>[]).map((row) => ({ ...row, type_counts: type_counts.get(row.id) ?? {} }));
  }

  function insertExercises(project_id: number, exercises: FileExercise[]): void {
    let { position } = select_position.get({ project_id }) as { position: number };
    const now = new Date().toISOString();
    for (const { key, type, topic, tags, content } of exercises) {
      insert_exercise.run({ project_id, key, position: ++position, type, topic, tags_json: JSON.stringify(tags), content_json: JSON.stringify(content), now });
    }
  }

  function listProjects(): ProjectSummary[] {
    return summariesOf(null);
  }

  function readProject(project_id: number): ProjectDetail | null {
    const [project] = summariesOf(project_id);
    if (project === undefined) return null;
    const exercises = (select_exercises.all({ project_id }) as unknown as (ExerciseRow & { done: number })[]).map((row): ExerciseItem => (
      { id: row.id, type: row.type, topic: row.topic, done: row.done === 1, ...describe(bodyOf(row)) }));
    const history = (select_latest_attempts.all({ project_id }) as unknown as Pick<AttemptRow, 'id' | 'exercise_id' | 'exercise_snapshot_json' | 'status' | 'summary' | 'submitted_at'>[]).map((row): HistoryItem => (
      { attempt_id: row.id, exercise_id: row.exercise_id, status: row.status, summary: row.summary, submitted_at: row.submitted_at, ...describe(JSON.parse(row.exercise_snapshot_json)) }));
    return { project, exercises, history };
  }

  function createProject(file: ProjectFile): number {
    return inTransaction(database, () => {
      const { id: next_id } = select_next_project_id.get() as { id: number };
      const key = keyFromName(file.name, next_id, (candidate) => select_project_key.get({ key: candidate }) !== undefined);
      const project_id = Number(insert_project.run({ key, name: file.name, description: file.description, now: new Date().toISOString() }).lastInsertRowid);
      insertExercises(project_id, file.exercises);
      return project_id;
    });
  }

  function addExercises(project_id: number, exercises: FileExercise[]): { added: number } | { duplicate_keys: string[] } | null {
    if (select_project_id.get({ id: project_id }) === undefined) return null;
    const existing = new Set((select_keys.all({ project_id }) as { key: string }[]).map(({ key }) => key));
    const duplicate_keys = exercises.map(({ key }) => key).filter((key) => existing.has(key));
    if (duplicate_keys.length > 0) return { duplicate_keys };
    inTransaction(database, () => insertExercises(project_id, exercises));
    return { added: exercises.length };
  }

  function readExercise(exercise_id: number): ExerciseView | null {
    const row = select_exercise.get({ id: exercise_id }) as ExerciseRow | undefined;
    return row === undefined ? null : { id: row.id, project_id: row.project_id, ...bodyOf(row) };
  }

  function createAttempt({ exercise, answer, writing_ms, grader, outcome }: NewAttempt): AttemptView {
    const now = new Date().toISOString();
    const { id: _id, project_id: _project_id, ...snapshot } = exercise;
    const attempt_id = inTransaction(database, () => {
      const { key: exercise_key, version: exercise_version } = select_exercise_version.get({ id: exercise.id }) as { key: string; version: number };
      const id = Number(insert_attempt.run({
        project_id: exercise.project_id, exercise_id: exercise.id, exercise_key, exercise_version, now, type: exercise.type, exercise_snapshot_json: JSON.stringify(snapshot),
        answer_json: JSON.stringify(answer), status: outcome === null ? 'grading' : 'graded', result_json: outcome === null ? null : JSON.stringify(outcome.result),
        summary: outcome?.summary ?? null, grader, writing_ms, graded_at: outcome === null ? null : now,
      }).lastInsertRowid);
      touch_project.run({ id: exercise.project_id, now });
      return id;
    });
    return readAttempt(attempt_id) as AttemptView;
  }

  function restartGrading(attempt_id: number): boolean {
    return restart_grading.run({ id: attempt_id }).changes > 0;
  }

  function finishGrading(attempt_id: number, outcome: GradingOutcome): void {
    if (outcome.status === 'graded') {
      const { text, thinking_text, thinking_ms, model, effort, grading_ms } = outcome;
      const result: AiResult = { text, thinking_text, thinking_ms, model, effort, ms: grading_ms };
      finish_graded.run({
        id: attempt_id, result_json: JSON.stringify(result), summary: AI_SUMMARY, model: outcome.model, effort, grading_ms: outcome.grading_ms,
        now: new Date().toISOString(),
      });
    } else {
      finish_failed.run({ id: attempt_id, error: outcome.error, model: outcome.model, grading_ms: outcome.grading_ms });
    }
  }

  function readAttempt(attempt_id: number): AttemptView | null {
    const row = select_attempt.get({ id: attempt_id }) as AttemptRow | undefined;
    return row === undefined ? null : attemptViewOf(row);
  }

  function failInterruptedGradings(): number {
    return Number(fail_interrupted.run().changes);
  }

  return { listProjects, readProject, createProject, addExercises, readExercise, createAttempt, restartGrading, finishGrading, readAttempt, failInterruptedGradings };
}
