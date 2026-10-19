// The one place that reads and writes the practice database (docs/practice-proposal.md §4).
import type { DatabaseSync } from 'node:sqlite';
import type { Effort } from '../../../shared/api.ts';
import { inTransaction, openDatabase } from '../../../shared/server/sqlite.ts';
import type {
  AiResult, AnswerByType, Attempt, AttemptStatus, Change, Exercise, ExerciseBody, ExerciseItem, ExerciseType, ImportFile, ImportResult, List, Project,
  ProjectFile, ProjectInput, ResultByType,
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
  exercise_id: number;
  answer: AnswerByType[ExerciseType];
  writing_ms: number | null;
  grader: 'ai' | 'self';
  outcome: { result: ResultByType[ExerciseType]; summary: string } | null;
}

// How an AI grading ended: the text it wrote, or why it failed.
export type GradingOutcome =
  | { status: 'graded'; text: string; thinking_text: string; thinking_ms: number | null; model: string; effort: Effort; grading_ms: number }
  | { status: 'failed'; error: string; model: string | null; grading_ms: number };

export interface AttemptFilter {
  project: string | null;
  exercise: string | null;
  status: AttemptStatus | null;
  // ISO times.
  since: string | null;
  before: number | null;
  limit: number;
}

// Every write that takes a body can be a dry run: it reports what would happen and writes nothing.
export interface PracticeStore {
  listProjects(archived: 'false' | 'true' | 'all'): Project[];
  readProject(key: string): Project | null;
  putProject(key: string, input: Required<ProjectInput>, is_dry_run: boolean): { project: Project; change: Change };
  // Gives a project a new key. Its exercises and attempts point at its id, so they stay linked.
  renameProject(key: string, new_key: string, is_dry_run: boolean): Project | 'not_found' | 'key_taken';
  // A project with attempts is deleted only with is_with_attempts; its exercises and attempts go with it.
  deleteProject(key: string, is_with_attempts: boolean): 'deleted' | 'not_found' | 'has_attempts';
  // null: no such project.
  listExercises(project_key: string, filter: { type: ExerciseType | null; tag: string | null }): ExerciseItem[] | null;
  readExercise(project_key: string, key: string): Exercise | null;
  // A new exercise goes to the end. null: no such project.
  putExercise(project_key: string, key: string, exercise: ExerciseBody, is_dry_run: boolean): { exercise: Exercise; change: Change } | null;
  // Gives an exercise a new key; its attempts get the new key too. Content, version and position do not change.
  renameExercise(project_key: string, key: string, new_key: string, is_dry_run: boolean): Exercise | 'not_found' | 'key_taken';
  // Its attempts stay, with its key and their snapshots.
  deleteExercise(project_key: string, key: string): boolean;
  // Upserts by key in one transaction (docs/practice-api-design.md §3.5); never deletes.
  importFile(file: ProjectFile, is_dry_run: boolean): ImportResult;
  exportProject(key: string): ImportFile | null;
  createAttempt(attempt: NewAttempt): Attempt;
  listAttempts(filter: AttemptFilter): List<Attempt>;
  readAttempt(attempt_id: number): Attempt | null;
  deleteAttempt(attempt_id: number): 'deleted' | 'not_found' | 'grading';
  // A failed attempt goes back to 'grading', its error cleared; false when it is not failed.
  restartGrading(attempt_id: number): boolean;
  finishGrading(attempt_id: number, outcome: GradingOutcome): void;
  // A server stopped mid-grading leaves 'grading' rows nobody will finish: they become failed.
  failInterruptedGradings(): number;
}

interface ProjectRow extends Omit<Project, 'archived' | 'type_counts'> {
  archived_at: string | null;
}

interface ExerciseRow {
  id: number;
  project_id: number;
  key: string;
  type: ExerciseType;
  topic: string | null;
  tags_json: string;
  content_json: string;
  version: number;
}

interface AttemptRow {
  id: number;
  project: string;
  exercise_key: string;
  exercise_version: number;
  exercise_deleted: number;
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

// JSON with every object's keys sorted: two values are the same exactly when this is.
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner) => {
    const is_plain_object = typeof inner === 'object' && inner !== null && !Array.isArray(inner);
    if (!is_plain_object) return inner;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(inner).sort()) sorted[key] = inner[key];
    return sorted;
  });
}

// Whether an exercise really changes: the same content written again, in any key order, is not a change.
function isSameBody(row: ExerciseRow, body: ExerciseBody): boolean {
  return row.type === body.type && row.topic === body.topic && canonical(JSON.parse(row.tags_json)) === canonical(body.tags)
    && canonical(JSON.parse(row.content_json)) === canonical(body.content);
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

function attemptOf(row: AttemptRow): Attempt {
  return {
    id: row.id,
    project: row.project,
    exercise: row.exercise_key,
    exercise_version: row.exercise_version,
    exercise_deleted: row.exercise_deleted === 1,
    submitted_at: row.submitted_at,
    status: row.status,
    summary: row.summary,
    error: row.error,
    writing_ms: row.writing_ms,
    snapshot: JSON.parse(row.exercise_snapshot_json),
    answer: JSON.parse(row.answer_json),
    result: resultOf(row.type, row.result_json),
  };
}

const PROJECT_COLUMNS = `
  id, key, name, description, archived_at, created_at, updated_at, last_activity_at,
  (SELECT count(*) FROM exercises WHERE project_id = projects.id) AS exercise_count,
  (SELECT count(DISTINCT exercise_id) FROM attempts WHERE project_id = projects.id AND status = 'graded') AS done_count`;
const ATTEMPT_COLUMNS = `
  attempts.id, projects.key AS project, exercise_key, exercise_version, exercise_id IS NULL AS exercise_deleted, submitted_at, type,
  exercise_snapshot_json, answer_json, status, result_json, summary, error, writing_ms
  FROM attempts JOIN projects ON projects.id = attempts.project_id`;

export function openPracticeStore(database_path: string): PracticeStore {
  const database: DatabaseSync = openDatabase(database_path, SCHEMA_VERSION, (migrating_database, file_schema_version) => {
    if (file_schema_version === 0) for (const statement of CREATE_TABLES) migrating_database.exec(statement);
    else if (file_schema_version === 1) migrateFrom1(migrating_database);
  });
  database.exec('PRAGMA foreign_keys = ON');

  // ---- projects ----
  const select_projects = database.prepare(`
    SELECT ${PROJECT_COLUMNS} FROM projects
    WHERE $archived = 'all' OR ($archived = 'true') = (archived_at IS NOT NULL)
    ORDER BY coalesce(last_activity_at, created_at) DESC, id DESC`);
  const select_project = database.prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE key = $key`);
  const select_type_counts = database.prepare('SELECT type, count(*) AS count FROM exercises WHERE project_id = $project_id GROUP BY type');
  const insert_project = database.prepare(`
    INSERT INTO projects (key, name, description, archived_at, created_at, updated_at) VALUES ($key, $name, $description, $archived_at, $now, $now)`);
  const update_project = database.prepare('UPDATE projects SET name = $name, description = $description, archived_at = $archived_at, updated_at = $now WHERE id = $id');
  const rename_project = database.prepare('UPDATE projects SET key = $new_key, updated_at = $now WHERE id = $id');
  const select_has_attempts = database.prepare('SELECT EXISTS (SELECT 1 FROM attempts WHERE project_id = $project_id) AS has_attempts');
  const delete_project = database.prepare('DELETE FROM projects WHERE id = $id');
  const touch_project = database.prepare('UPDATE projects SET last_activity_at = $now WHERE id = $id');

  // ---- exercises ----
  const select_exercise_row = database.prepare(`
    SELECT exercises.id, project_id, exercises.key, type, topic, tags_json, content_json, version FROM exercises
    JOIN projects ON projects.id = exercises.project_id WHERE projects.key = $project_key AND exercises.key = $key`);
  const select_exercise_row_by_project = database.prepare('SELECT id, project_id, key, type, topic, tags_json, content_json, version FROM exercises WHERE project_id = $project_id AND key = $key');
  const select_exercise = database.prepare(`
    SELECT exercises.id, projects.key AS project, exercises.key, type, topic, tags_json, content_json, position, version,
           exercises.created_at, exercises.updated_at,
           EXISTS (SELECT 1 FROM attempts WHERE exercise_id = exercises.id AND status = 'graded') AS done,
           (SELECT count(*) FROM attempts WHERE exercise_id = exercises.id) AS attempt_count
    FROM exercises JOIN projects ON projects.id = exercises.project_id WHERE projects.key = $project_key AND exercises.key = $key`);
  const select_exercise_items = database.prepare(`
    SELECT exercises.id, exercises.key, exercises.type, topic, tags_json, content_json, version, updated_at,
           EXISTS (SELECT 1 FROM attempts WHERE exercise_id = exercises.id AND status = 'graded') AS done,
           last.id AS last_id, last.status AS last_status, last.summary AS last_summary, last.submitted_at AS last_submitted_at
    FROM exercises LEFT JOIN attempts AS last ON last.id = (SELECT max(id) FROM attempts WHERE exercise_id = exercises.id)
    WHERE exercises.project_id = $project_id AND ($type IS NULL OR exercises.type = $type)
      AND ($tag IS NULL OR EXISTS (SELECT 1 FROM json_each(exercises.tags_json) WHERE value = $tag))
    ORDER BY position, exercises.id`);
  const select_export_rows = database.prepare('SELECT key, type, topic, tags_json, content_json FROM exercises WHERE project_id = $project_id ORDER BY position, id');
  const select_position = database.prepare('SELECT coalesce(max(position), 0) AS position FROM exercises WHERE project_id = $project_id');
  const select_positions = database.prepare('SELECT id, key FROM exercises WHERE project_id = $project_id ORDER BY position, id');
  const insert_exercise = database.prepare(`
    INSERT INTO exercises (project_id, key, position, type, topic, tags_json, content_json, created_at, updated_at)
    VALUES ($project_id, $key, $position, $type, $topic, $tags_json, $content_json, $now, $now)`);
  const update_exercise = database.prepare(`
    UPDATE exercises SET type = $type, topic = $topic, tags_json = $tags_json, content_json = $content_json, version = version + 1, updated_at = $now
    WHERE id = $id`);
  const set_position = database.prepare('UPDATE exercises SET position = $position WHERE id = $id');
  const delete_exercise = database.prepare('DELETE FROM exercises WHERE id = $id');
  const rename_exercise = database.prepare('UPDATE exercises SET key = $new_key WHERE id = $id');
  const rename_attempts = database.prepare('UPDATE attempts SET exercise_key = $new_key WHERE exercise_id = $id');
  const select_exercise_by_id = database.prepare('SELECT id, project_id, key, type, topic, tags_json, content_json, version FROM exercises WHERE id = $id');

  // ---- attempts ----
  const insert_attempt = database.prepare(`
    INSERT INTO attempts (project_id, exercise_id, exercise_key, exercise_version, submitted_at, type, exercise_snapshot_json, answer_json, status,
                          result_json, summary, grader, writing_ms, graded_at)
    VALUES ($project_id, $exercise_id, $exercise_key, $exercise_version, $now, $type, $exercise_snapshot_json, $answer_json, $status,
            $result_json, $summary, $grader, $writing_ms, $graded_at)`);
  const select_attempt = database.prepare(`SELECT ${ATTEMPT_COLUMNS} WHERE attempts.id = $id`);
  const select_attempts = database.prepare(`
    SELECT ${ATTEMPT_COLUMNS}
    WHERE ($project IS NULL OR projects.key = $project) AND ($exercise IS NULL OR exercise_key = $exercise) AND ($status IS NULL OR status = $status)
      AND ($since IS NULL OR submitted_at >= $since) AND ($before IS NULL OR attempts.id < $before)
    ORDER BY attempts.id DESC LIMIT $limit`);
  const delete_attempt = database.prepare("DELETE FROM attempts WHERE id = $id AND status != 'grading'");
  const restart_grading = database.prepare("UPDATE attempts SET status = 'grading', error = NULL WHERE id = $id AND status = 'failed'");
  // Only a 'grading' row is finished, so a late result can never overwrite a graded attempt.
  const finish_graded = database.prepare(`
    UPDATE attempts SET status = 'graded', result_json = $result_json, summary = $summary, model = $model, effort = $effort,
                        grading_ms = $grading_ms, graded_at = $now, error = NULL
    WHERE id = $id AND status = 'grading'`);
  const finish_failed = database.prepare("UPDATE attempts SET status = 'failed', error = $error, model = $model, grading_ms = $grading_ms WHERE id = $id AND status = 'grading'");
  const fail_interrupted = database.prepare("UPDATE attempts SET status = 'failed', error = 'The server stopped while grading.' WHERE status = 'grading'");

  function projectOf(row: ProjectRow): Project {
    const type_counts: Partial<Record<ExerciseType, number>> = {};
    const counts = select_type_counts.all({ project_id: row.id }) as { type: ExerciseType; count: number }[];
    for (const { type, count } of counts) type_counts[type] = count;
    const { archived_at, ...columns } = row;
    return { ...columns, archived: archived_at !== null, type_counts };
  }

  function listProjects(archived: 'false' | 'true' | 'all'): Project[] {
    return (select_projects.all({ archived }) as unknown as ProjectRow[]).map(projectOf);
  }

  function readProject(key: string): Project | null {
    const row = select_project.get({ key }) as ProjectRow | undefined;
    return row === undefined ? null : projectOf(row);
  }

  // archived_at keeps the day it was first archived.
  function putProject(key: string, { name, description, archived }: Required<ProjectInput>, is_dry_run: boolean): { project: Project; change: Change } {
    return inTransaction(database, () => {
      const now = new Date().toISOString();
      const row = select_project.get({ key }) as ProjectRow | undefined;
      const archived_at = !archived ? null : row?.archived_at ?? now;
      let change: Change = 'unchanged';
      if (row === undefined) {
        insert_project.run({ key, name, description, archived_at, now });
        change = 'created';
      } else if (row.name !== name || row.description !== description || row.archived_at !== archived_at) {
        update_project.run({ id: row.id, name, description, archived_at, now });
        change = 'updated';
      }
      return { project: readProject(key) as Project, change };
    }, is_dry_run);
  }

  // The same key again is no change.
  function renameProject(key: string, new_key: string, is_dry_run: boolean): Project | 'not_found' | 'key_taken' {
    return inTransaction(database, () => {
      const row = select_project.get({ key }) as ProjectRow | undefined;
      if (row === undefined) return 'not_found';
      if (new_key === key) return readProject(key) as Project;
      if (select_project.get({ key: new_key }) !== undefined) return 'key_taken';
      rename_project.run({ id: row.id, new_key, now: new Date().toISOString() });
      return readProject(new_key) as Project;
    }, is_dry_run);
  }

  function deleteProject(key: string, is_with_attempts: boolean): 'deleted' | 'not_found' | 'has_attempts' {
    const row = select_project.get({ key }) as ProjectRow | undefined;
    if (row === undefined) return 'not_found';
    const { has_attempts } = select_has_attempts.get({ project_id: row.id }) as { has_attempts: number };
    if (has_attempts === 1 && !is_with_attempts) return 'has_attempts';
    delete_project.run({ id: row.id });
    return 'deleted';
  }

  interface ItemRow extends ExerciseRow {
    updated_at: string;
    done: number;
    // The latest attempt's columns; all null when there is none.
    last_id: number | null;
    last_status: AttemptStatus;
    last_summary: string | null;
    last_submitted_at: string;
  }

  function itemOf(row: ItemRow): ExerciseItem {
    const { kind, preview } = describe(bodyOf(row));
    let last_attempt: ExerciseItem['last_attempt'] = null;
    if (row.last_id !== null) {
      last_attempt = { id: row.last_id, status: row.last_status, summary: row.last_summary, submitted_at: row.last_submitted_at };
    }
    return {
      id: row.id,
      key: row.key,
      type: row.type,
      kind,
      preview,
      topic: row.topic,
      tags: JSON.parse(row.tags_json),
      version: row.version,
      updated_at: row.updated_at,
      done: row.done === 1,
      last_attempt,
    };
  }

  function itemsOf(project_id: number, type: ExerciseType | null, tag: string | null): ExerciseItem[] {
    const rows = select_exercise_items.all({ project_id, type, tag }) as unknown as ItemRow[];
    return rows.map(itemOf);
  }

  function listExercises(project_key: string, { type, tag }: { type: ExerciseType | null; tag: string | null }): ExerciseItem[] | null {
    const project = select_project.get({ key: project_key }) as ProjectRow | undefined;
    return project === undefined ? null : itemsOf(project.id, type, tag);
  }

  function readExercise(project_key: string, key: string): Exercise | null {
    type Row = ExerciseRow & { project: string; position: number; created_at: string; updated_at: string; done: number; attempt_count: number };
    const row = select_exercise.get({ project_key, key }) as Row | undefined;
    if (row === undefined) return null;
    return {
      id: row.id,
      project: row.project,
      key: row.key,
      ...bodyOf(row),
      position: row.position,
      version: row.version,
      created_at: row.created_at,
      updated_at: row.updated_at,
      done: row.done === 1,
      attempt_count: row.attempt_count,
    };
  }

  // Creates or replaces one exercise; position null puts a new one at the end and leaves an old one where it is.
  function upsertExercise(project_id: number, key: string, body: ExerciseBody, position: number | null, now: string): Change {
    const row = select_exercise_row_by_project.get({ project_id, key }) as ExerciseRow | undefined;
    const columns = { type: body.type, topic: body.topic, tags_json: JSON.stringify(body.tags), content_json: JSON.stringify(body.content), now };
    if (row === undefined) {
      const { position: last_position } = select_position.get({ project_id }) as { position: number };
      insert_exercise.run({ project_id, key, position: position ?? last_position + 1, ...columns });
      return 'created';
    }
    if (position !== null) set_position.run({ id: row.id, position });
    if (isSameBody(row, body)) return 'unchanged';
    update_exercise.run({ id: row.id, ...columns });
    return 'updated';
  }

  function putExercise(project_key: string, key: string, body: ExerciseBody, is_dry_run: boolean): { exercise: Exercise; change: Change } | null {
    return inTransaction(database, () => {
      const project = select_project.get({ key: project_key }) as ProjectRow | undefined;
      if (project === undefined) return null;
      const change = upsertExercise(project.id, key, body, null, new Date().toISOString());
      return { exercise: readExercise(project_key, key) as Exercise, change };
    }, is_dry_run);
  }

  // The attempts of a deleted exercise that had the old key are not touched: they belong to that other exercise.
  function renameExercise(project_key: string, key: string, new_key: string, is_dry_run: boolean): Exercise | 'not_found' | 'key_taken' {
    return inTransaction(database, () => {
      const row = select_exercise_row.get({ project_key, key }) as ExerciseRow | undefined;
      if (row === undefined) return 'not_found';
      if (new_key === key) return readExercise(project_key, key) as Exercise;
      if (select_exercise_row_by_project.get({ project_id: row.project_id, key: new_key }) !== undefined) return 'key_taken';
      rename_exercise.run({ id: row.id, new_key });
      rename_attempts.run({ id: row.id, new_key });
      return readExercise(project_key, new_key) as Exercise;
    }, is_dry_run);
  }

  function deleteExercise(project_key: string, key: string): boolean {
    const row = select_exercise_row.get({ project_key, key }) as ExerciseRow | undefined;
    return row !== undefined && delete_exercise.run({ id: row.id }).changes > 0;
  }

  function importFile(file: ProjectFile, is_dry_run: boolean): ImportResult {
    const { key } = file;
    return inTransaction(database, () => {
      const now = new Date().toISOString();
      const row = select_project.get({ key }) as ProjectRow | undefined;
      let project_change: Change = 'unchanged';
      if (row === undefined) {
        insert_project.run({ key, name: file.name, description: file.description, archived_at: null, now });
        project_change = 'created';
      } else if (row.name !== file.name || row.description !== file.description) {
        update_project.run({ id: row.id, name: file.name, description: file.description, archived_at: row.archived_at, now });
        project_change = 'updated';
      }
      const project_id = (select_project.get({ key }) as unknown as ProjectRow).id;
      const exercises: ImportResult['exercises'] = { created: [], updated: [], unchanged: [] };
      file.exercises.forEach((exercise, index) => {
        const { key: exercise_key, ...body } = exercise;
        const change = upsertExercise(project_id, exercise_key, body, index + 1, now);
        exercises[change].push(exercise_key);
      });
      // The file's order first; the exercises it leaves out keep their order after them.
      const in_file = new Set(file.exercises.map((exercise) => exercise.key));
      let position = file.exercises.length;
      for (const other of select_positions.all({ project_id }) as { id: number; key: string }[]) {
        if (!in_file.has(other.key)) set_position.run({ id: other.id, position: ++position });
      }
      return { dry_run: is_dry_run, project: readProject(key) as Project, project_change, exercises };
    }, is_dry_run);
  }

  // The project as a format 3 file: importing it again changes nothing.
  function exportProject(key: string): ImportFile | null {
    const project = select_project.get({ key }) as ProjectRow | undefined;
    if (project === undefined) return null;
    const exercises = (select_export_rows.all({ project_id: project.id }) as unknown as ExerciseRow[]).map((row) => {
      const { type, topic, tags, content } = bodyOf(row);
      return { key: row.key, type, ...(topic === null ? {} : { topic }), ...(tags.length === 0 ? {} : { tags }), content };
    });
    return { format: 3, project: { key, name: project.name, ...(project.description === '' ? {} : { description: project.description }) }, exercises };
  }

  // The snapshot is taken from the row as it is now, in the same transaction as the insert.
  function createAttempt({ exercise_id, answer, writing_ms, grader, outcome }: NewAttempt): Attempt {
    const now = new Date().toISOString();
    const attempt_id = inTransaction(database, () => {
      const exercise = select_exercise_by_id.get({ id: exercise_id }) as unknown as ExerciseRow;
      const is_graded = outcome !== null;
      const inserted = insert_attempt.run({
        project_id: exercise.project_id,
        exercise_id,
        exercise_key: exercise.key,
        exercise_version: exercise.version,
        now,
        type: exercise.type,
        exercise_snapshot_json: JSON.stringify(bodyOf(exercise)),
        answer_json: JSON.stringify(answer),
        status: is_graded ? 'graded' : 'grading',
        result_json: is_graded ? JSON.stringify(outcome.result) : null,
        summary: is_graded ? outcome.summary : null,
        grader,
        writing_ms,
        graded_at: is_graded ? now : null,
      });
      const id = Number(inserted.lastInsertRowid);
      touch_project.run({ id: exercise.project_id, now });
      return id;
    });
    return readAttempt(attempt_id) as Attempt;
  }

  // Newest first; one more row than asked tells whether there is a next page.
  function listAttempts({ limit, ...filter }: AttemptFilter): List<Attempt> {
    const rows = select_attempts.all({ ...filter, limit: limit + 1 }) as unknown as AttemptRow[];
    const items = rows.slice(0, limit).map(attemptOf);
    if (rows.length <= limit) return { items };
    const last = items[items.length - 1];
    return { items, next_before: last.id };
  }

  function readAttempt(attempt_id: number): Attempt | null {
    const row = select_attempt.get({ id: attempt_id }) as AttemptRow | undefined;
    return row === undefined ? null : attemptOf(row);
  }

  function deleteAttempt(attempt_id: number): 'deleted' | 'not_found' | 'grading' {
    if (delete_attempt.run({ id: attempt_id }).changes > 0) return 'deleted';
    return select_attempt.get({ id: attempt_id }) === undefined ? 'not_found' : 'grading';
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

  function failInterruptedGradings(): number {
    return Number(fail_interrupted.run().changes);
  }

  return {
    listProjects, readProject, putProject, renameProject, deleteProject, listExercises, readExercise, putExercise, renameExercise, deleteExercise, importFile, exportProject,
    createAttempt, listAttempts, readAttempt, deleteAttempt, restartGrading, finishGrading, failInterruptedGradings,
  };
}
