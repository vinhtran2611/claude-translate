// The practice database's tables (docs/data-model-proposal.md §4), and the migrations from schema 1 and schema 2 (§5).
import type { DatabaseSync } from 'node:sqlite';
import type { Effort, ModelRun, RunErrorCode } from '../../../shared/api-types.ts';
import {
  EFFORTS, RUN_CHECKS, RUN_INSERT_COLUMNS, RUN_INSERT_VALUES, runColumns, runRowOf, sqlList, thinkingTextOf, TIME_COLUMNS, timeCheck,
} from '../../../shared/server/model-run.ts';
import type { Answer, ExerciseContent, ExerciseSnapshot } from '../api-types.ts';
import { answerFromFormat3, contentFromFormat3, type Format3Content, type Format3Type } from '../format-3.ts';
import { EXERCISE_TYPES } from '../import-check.ts';

export const SCHEMA_VERSION = 3;
// A key: a-z, 0-9 and -, not starting with -, 1 to 64 characters (KEY_PATTERN in import-check.ts).
const KEY_CHECK = "CHECK (length(key) BETWEEN 1 AND 64 AND key NOT GLOB '*[^a-z0-9-]*' AND key NOT GLOB '-*')";
// What a grading interrupted by a restart says (and what schema 2 wrote in attempts.error).
export const INTERRUPTED_MESSAGE = 'The server stopped while grading.';

// An attempt keeps a snapshot of its exercise, so nothing done to an exercise later can change what it shows. Deleting
// an exercise or a project deletes its attempts and their gradings (the store asks first: rule 8). AUTOINCREMENT: an id
// is never reused.
export const CREATE_TABLES = [
  `CREATE TABLE projects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    key         TEXT    NOT NULL UNIQUE ${KEY_CHECK},
    name        TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    description TEXT    CHECK (description IS NULL OR length(description) BETWEEN 1 AND 500),
    archived_at TEXT    ${timeCheck('archived_at', true)},${TIME_COLUMNS}
  ) STRICT`,
  `CREATE TABLE exercises (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id   INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    key          TEXT    NOT NULL ${KEY_CHECK},
    position     INTEGER NOT NULL CHECK (position >= 1),
    type         TEXT    NOT NULL CHECK (type IN ${sqlList(EXERCISE_TYPES)}),
    topic        TEXT    CHECK (topic IS NULL OR topic <> ''),
    tags_json    TEXT    NOT NULL CHECK (json_valid(tags_json)),
    content_json TEXT    NOT NULL CHECK (json_valid(content_json)),
    version      INTEGER NOT NULL CHECK (version >= 1),${TIME_COLUMNS},
    UNIQUE (project_id, key),
    -- type copies content.type, so a list can filter by type; this keeps the two equal.
    CHECK (type = content_json ->> '$.type')
  ) STRICT`,
  'CREATE INDEX exercises_by_project_id_position ON exercises (project_id, position)',
  `CREATE TABLE attempts (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    exercise_id            INTEGER NOT NULL REFERENCES exercises (id) ON DELETE CASCADE,
    exercise_version       INTEGER NOT NULL CHECK (exercise_version >= 1),
    exercise_snapshot_json TEXT    NOT NULL CHECK (json_valid(exercise_snapshot_json)),
    answer_json            TEXT    NOT NULL CHECK (json_valid(answer_json)),
    time_spent_ms          INTEGER CHECK (time_spent_ms IS NULL OR time_spent_ms >= 0),${TIME_COLUMNS},
    -- Rule 1: an answer has the type of the exercise it answered.
    CHECK (answer_json ->> '$.type' = exercise_snapshot_json ->> '$.content.type')
  ) STRICT`,
  'CREATE INDEX attempts_by_exercise_id_id ON attempts (exercise_id, id)',
  `CREATE TABLE gradings (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    attempt_id        INTEGER NOT NULL REFERENCES attempts (id) ON DELETE CASCADE,${runColumns(false)},
    feedback_markdown TEXT,${TIME_COLUMNS},${RUN_CHECKS},
    CHECK (run_status <> 'succeeded' OR feedback_markdown IS NOT NULL)
  ) STRICT`,
  'CREATE INDEX gradings_by_attempt_id_id ON gradings (attempt_id, id)',
  'CREATE INDEX gradings_by_run_status ON gradings (run_status)',
  // Rule 7: at most one grading of an attempt is running.
  "CREATE UNIQUE INDEX gradings_by_attempt_id_running ON gradings (attempt_id) WHERE run_status = 'running'",
];

// ---- Schema 1 -> 2 ----

const SCHEMA_2_TYPES = "('rewrite', 'write', 'choice', 'fill', 'flashcard')";

// Schema 2 as it shipped. Only migrateFrom1 makes these tables; migrateFrom2 then brings them to schema 3.
const SCHEMA_2_TABLES = [
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
    type         TEXT    NOT NULL CHECK (type IN ${SCHEMA_2_TYPES}),
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
    type                   TEXT    NOT NULL CHECK (type IN ${SCHEMA_2_TYPES}),
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
  const ascii_name = name
    .toLowerCase()
    .replaceAll('đ', 'd')
    // Splits each accented letter into the letter and its accents, then drops the accents: "ế" -> "e".
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '');
  const base = ascii_name
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  if (base !== '' && !is_taken(base)) return base;
  const suffix = `-${id}`;
  const shortened_base = (base || 'project').slice(0, 64 - suffix.length).replace(/-+$/, '');
  return `${shortened_base}${suffix}`;
}

function rowCount(database: DatabaseSync, table: string): number {
  const row = database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}

// Schema 1 -> 2 (docs/practice-api-design.md §6, step 2): keys for projects, versions and times for exercises, the
// exercise's key and version and the effort on attempts, and ON DELETE rules. SQLite cannot change a foreign key, so
// each table is renamed, made again from SCHEMA_2_TABLES, filled from the old one, and the old one dropped. Ids and the
// AUTOINCREMENT counters are kept. The caller has made a backup and runs this in one transaction with foreign keys off.
export function migrateFrom1(database: DatabaseSync): void {
  const TABLES = ['projects', 'exercises', 'attempts'];
  database.exec('DROP INDEX attempts_by_exercise; DROP INDEX attempts_by_project');
  for (const table of TABLES) database.exec(`ALTER TABLE ${table} RENAME TO ${table}_v1`);
  for (const statement of SCHEMA_2_TABLES) database.exec(statement);

  // Projects get a key made from their name.
  const insert_project = database.prepare(`
    INSERT INTO projects (id, key, name, description, created_at, updated_at, last_activity_at)
    VALUES ($id, $key, $name, $description, $created_at, $created_at, $last_activity_at)`);
  const old_projects = database
    .prepare('SELECT id, name, description, created_at, last_activity_at FROM projects_v1 ORDER BY id')
    .all() as Record<string, string | number | null>[];
  const keys = new Set<string>();
  for (const row of old_projects) {
    const key = keyFromName(row.name as string, row.id as number, (candidate) => keys.has(candidate));
    keys.add(key);
    insert_project.run({ ...row, key });
  }

  // Exercises start at version 1, created and updated when their project was created.
  database.exec(`
    INSERT INTO exercises (id, project_id, key, position, type, topic, tags_json, content_json, version, created_at, updated_at)
    SELECT exercise.id, exercise.project_id, exercise.key, exercise.position, exercise.type, exercise.topic, exercise.tags_json, exercise.content_json,
           1, project.created_at, project.created_at
    FROM exercises_v1 AS exercise JOIN projects_v1 AS project ON project.id = exercise.project_id`);

  // Attempts get their exercise's key and version 1; an AI grade's effort moves out of its result.
  database.exec(`
    INSERT INTO attempts (id, project_id, exercise_id, exercise_key, exercise_version, submitted_at, type, exercise_snapshot_json, answer_json,
                          status, result_json, summary, grader, model, effort, grading_ms, error, writing_ms, graded_at)
    SELECT attempt.id, attempt.project_id, attempt.exercise_id, exercise.key, 1, attempt.submitted_at, attempt.type, attempt.exercise_snapshot_json,
           attempt.answer_json, attempt.status, attempt.result_json, attempt.summary, attempt.grader, attempt.model,
           CASE WHEN attempt.grader = 'ai' THEN json_extract(attempt.result_json, '$.effort') END,
           attempt.grading_ms, attempt.error, attempt.writing_ms, attempt.graded_at
    FROM attempts_v1 AS attempt JOIN exercises_v1 AS exercise ON exercise.id = attempt.exercise_id`);

  for (const table of TABLES) {
    const old_count = rowCount(database, `${table}_v1`);
    const new_count = rowCount(database, table);
    if (new_count !== old_count) throw new Error(`migrating ${table} would lose rows (${old_count} -> ${new_count})`);
    // The new table's counter starts where the old one was, so no id is ever given twice.
    database.exec(`
      INSERT INTO sqlite_sequence (name, seq) SELECT '${table}', seq FROM sqlite_sequence
      WHERE name = '${table}_v1' AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = '${table}')`);
    database.exec(`
      UPDATE sqlite_sequence SET seq = max(seq, (SELECT seq FROM sqlite_sequence WHERE name = '${table}_v1'))
      WHERE name = '${table}'`);
  }
  // Children first, so no foreign key points at a dropped table.
  for (const table of [...TABLES].reverse()) database.exec(`DROP TABLE ${table}_v1`);
}

// ---- Schema 2 -> 3 ----

interface Schema2Project {
  id: number;
  key: string;
  name: string;
  description: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

interface Schema2Exercise {
  id: number;
  project_id: number;
  key: string;
  position: number;
  type: Format3Type;
  topic: string | null;
  tags_json: string;
  content_json: string;
  version: number;
  created_at: string;
  updated_at: string;
}

interface Schema2Attempt {
  id: number;
  exercise_id: number | null;
  exercise_version: number;
  submitted_at: string;
  exercise_snapshot_json: string;
  answer_json: string;
  status: 'grading' | 'graded' | 'failed';
  result_json: string | null;
  grader: 'ai' | 'self';
  model: string | null;
  effort: string | null;
  grading_ms: number | null;
  error: string | null;
  writing_ms: number | null;
  graded_at: string | null;
}

// The AI result schema 2 kept in result_json. Results from before the thinking summary was kept lack thinking_*.
interface Schema2AiResult {
  text?: string;
  thinking_text?: string;
  thinking_ms?: number | null;
}

// What a failed grading from before error details were kept says.
const UNKNOWN_ERROR = 'Unknown (saved before error details were kept).';
const MIGRATED_TABLES = ['projects', 'exercises', 'attempts'];

// An absent value is null, never '' (the spec's §3.1).
function emptyAsNull(text: string | null | undefined): string | null {
  if (text === undefined || text === '') return null;
  return text;
}

// A time moved by some milliseconds, as an ISO time again.
function shiftTime(time: string, milliseconds: number): string {
  return new Date(Date.parse(time) + milliseconds).toISOString();
}

// A stored exercise's content in the new model. A row that cannot be read stops the migration, naming the row: the
// caller rolls everything back, and the backup is there.
function contentOf(what: string, type: Format3Type, content_json: string): ExerciseContent {
  try {
    return contentFromFormat3(type, JSON.parse(content_json) as Format3Content);
  } catch (error) {
    throw new Error(`migrating ${what} to schema 3: its content cannot be read (${(error as Error).message})`);
  }
}

function snapshotOf(attempt: Schema2Attempt): ExerciseSnapshot {
  const old_snapshot = JSON.parse(attempt.exercise_snapshot_json) as { type: Format3Type; topic: string | null; tags: string[]; content: Format3Content };
  const content_json = JSON.stringify(old_snapshot.content);
  const content = contentOf(`the snapshot of attempt ${attempt.id}`, old_snapshot.type, content_json);
  return { topic: emptyAsNull(old_snapshot.topic), tags: old_snapshot.tags ?? [], content };
}

function answerOf(attempt: Schema2Attempt, snapshot: ExerciseSnapshot): Answer {
  const answer = answerFromFormat3(snapshot.content.type, JSON.parse(attempt.answer_json));
  if (answer === null) throw new Error(`migrating attempt ${attempt.id} to schema 3: its answer does not fit a ${snapshot.content.type} exercise`);
  return answer;
}

function effortOf(effort: string | null): Effort | null {
  const known = EFFORTS.find((one) => one === effort);
  return known ?? null;
}

// The one grading an AI-graded schema 2 attempt had, as a run and its feedback (the spec's §5):
//   graded -> succeeded: finishedAt = graded_at, startedAt = graded_at - grading_ms;
//   failed -> failed: the time it failed was not kept, so startedAt = submitted_at, finishedAt = startedAt + grading_ms;
//   grading -> running: the server stopped mid-grading; the next start fails it as interrupted.
// Both model ids are the old model (the served one; the requested one was not kept).
function gradingOf(attempt: Schema2Attempt): { run: ModelRun; feedback_markdown: string | null } {
  let result: Schema2AiResult = {};
  if (attempt.result_json !== null) result = JSON.parse(attempt.result_json) as Schema2AiResult;
  const grading_ms = attempt.grading_ms ?? 0;
  const run: ModelRun = {
    status: 'running',
    requestedModelId: attempt.model,
    servedModelId: attempt.model,
    effort: effortOf(attempt.effort),
    thinkingText: thinkingTextOf(result.thinking_text ?? ''),
    thinkingMs: result.thinking_ms ?? null,
    errorCode: null,
    errorMessage: null,
    startedAt: attempt.submitted_at,
    finishedAt: null,
  };
  let feedback_markdown: string | null = null;
  if (attempt.status === 'graded') {
    const finished_at = attempt.graded_at ?? attempt.submitted_at;
    run.status = 'succeeded';
    run.finishedAt = finished_at;
    run.startedAt = shiftTime(finished_at, -grading_ms);
    feedback_markdown = result.text ?? '';
  } else if (attempt.status === 'failed') {
    let error_code: RunErrorCode = 'claude_error';
    if (attempt.error === INTERRUPTED_MESSAGE) error_code = 'interrupted';
    run.status = 'failed';
    run.finishedAt = shiftTime(attempt.submitted_at, grading_ms);
    run.errorCode = error_code;
    run.errorMessage = attempt.error ?? UNKNOWN_ERROR;
  }
  return { run, feedback_markdown };
}

// Schema 2 -> 3 (docs/data-model-proposal.md §5): the new data model. Every row is read, converted in code (the same
// conversion as a format 3 import, format-3.ts) and written to the new tables; the old tables are dropped first, inside
// the same transaction. Ids and the AUTOINCREMENT counters are kept. Each AI-graded attempt gets one grading. The caller
// has made a backup and runs this in one transaction with foreign keys off; any error rolls all of it back.
export function migrateFrom2(database: DatabaseSync): void {
  const projects = database.prepare('SELECT * FROM projects ORDER BY id').all() as unknown as Schema2Project[];
  const exercises = database.prepare('SELECT * FROM exercises ORDER BY id').all() as unknown as Schema2Exercise[];
  const attempts = database.prepare('SELECT * FROM attempts ORDER BY id').all() as unknown as Schema2Attempt[];
  const sequence_rows = database.prepare('SELECT name, seq FROM sqlite_sequence').all() as { name: string; seq: number }[];

  // Rule 8: every attempt has an exercise. None is without one today; if one is, stop rather than drop it.
  const orphan_ids = attempts.filter((attempt) => attempt.exercise_id === null).map((attempt) => attempt.id);
  if (orphan_ids.length > 0) {
    throw new Error(`migrating to schema 3: attempt(s) ${orphan_ids.join(', ')} have no exercise; every attempt must have one`);
  }

  // Children first. Dropping a table drops its indexes and its sqlite_sequence row too.
  database.exec('DROP TABLE attempts; DROP TABLE exercises; DROP TABLE projects');
  for (const statement of CREATE_TABLES) database.exec(statement);

  const insert_project = database.prepare(`
    INSERT INTO projects (id, key, name, description, archived_at, created_at, updated_at)
    VALUES ($id, $key, $name, $description, $archived_at, $created_at, $updated_at)`);
  for (const project of projects) {
    let description: string | null = project.description;
    if (description === '') description = null;
    insert_project.run({
      id: project.id,
      key: project.key,
      name: project.name,
      description,
      archived_at: project.archived_at,
      created_at: project.created_at,
      updated_at: project.updated_at,
    });
  }

  const insert_exercise = database.prepare(`
    INSERT INTO exercises (id, project_id, key, position, type, topic, tags_json, content_json, version, created_at, updated_at)
    VALUES ($id, $project_id, $key, $position, $type, $topic, $tags_json, $content_json, $version, $created_at, $updated_at)`);
  for (const exercise of exercises) {
    const content = contentOf(`exercise ${exercise.id}`, exercise.type, exercise.content_json);
    insert_exercise.run({
      id: exercise.id,
      project_id: exercise.project_id,
      key: exercise.key,
      position: exercise.position,
      type: content.type,
      topic: emptyAsNull(exercise.topic),
      tags_json: exercise.tags_json,
      content_json: JSON.stringify(content),
      version: exercise.version,
      created_at: exercise.created_at,
      updated_at: exercise.updated_at,
    });
  }

  const insert_attempt = database.prepare(`
    INSERT INTO attempts (id, exercise_id, exercise_version, exercise_snapshot_json, answer_json, time_spent_ms, created_at, updated_at)
    VALUES ($id, $exercise_id, $exercise_version, $exercise_snapshot_json, $answer_json, $time_spent_ms, $created_at, $created_at)`);
  const insert_grading = database.prepare(`
    INSERT INTO gradings (attempt_id, ${RUN_INSERT_COLUMNS}, feedback_markdown, created_at, updated_at)
    VALUES ($attempt_id, ${RUN_INSERT_VALUES}, $feedback_markdown, $created_at, $created_at)`);
  let grading_count = 0;
  for (const attempt of attempts) {
    const snapshot = snapshotOf(attempt);
    const answer = answerOf(attempt, snapshot);
    insert_attempt.run({
      id: attempt.id,
      exercise_id: attempt.exercise_id,
      exercise_version: attempt.exercise_version,
      exercise_snapshot_json: JSON.stringify(snapshot),
      answer_json: JSON.stringify(answer),
      time_spent_ms: attempt.writing_ms,
      created_at: attempt.submitted_at,
    });
    // A flashcard's result was its rating, which the answer holds: it gets no grading (rule 6).
    if (attempt.grader !== 'ai') continue;
    const { run, feedback_markdown } = gradingOf(attempt);
    insert_grading.run({ attempt_id: attempt.id, ...runRowOf(run), feedback_markdown, created_at: run.startedAt });
    grading_count++;
  }

  const expected_counts: Record<string, number> = { projects: projects.length, exercises: exercises.length, attempts: attempts.length, gradings: grading_count };
  for (const [table, expected_count] of Object.entries(expected_counts)) {
    const count = rowCount(database, table);
    if (count !== expected_count) throw new Error(`migrating ${table} to schema 3 would lose rows (${expected_count} -> ${count})`);
  }

  // Each counter starts where the old one was, so no id is ever given twice (a deleted row's id included).
  const set_sequence = database.prepare('UPDATE sqlite_sequence SET seq = max(seq, $seq) WHERE name = $name');
  const add_sequence = database.prepare('INSERT INTO sqlite_sequence (name, seq) SELECT $name, $seq WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = $name)');
  for (const { name, seq } of sequence_rows) {
    if (!MIGRATED_TABLES.includes(name)) continue;
    set_sequence.run({ name, seq });
    add_sequence.run({ name, seq });
  }
}
