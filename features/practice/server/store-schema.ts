// The practice database's tables, and the migration from schema 1 (docs/practice-api-design.md §2.7 and §6).
import type { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 2;
const TYPES = "('rewrite', 'write', 'choice', 'fill', 'flashcard')";
// A key: a-z, 0-9 and -, not starting with -, 1 to 64 characters (KEY_PATTERN in import-check.ts).
const KEY_CHECK = "CHECK (length(key) BETWEEN 1 AND 64 AND key NOT GLOB '*[^a-z0-9-]*' AND key NOT GLOB '-*')";

// An attempt keeps a snapshot of its exercise, so nothing done to an exercise later can change what it shows; deleting an
// exercise keeps its attempts (exercise_id becomes NULL, exercise_key stays). AUTOINCREMENT: an id is never reused.
export const CREATE_TABLES = [
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
  const ascii_name = name
    .toLowerCase()
    .replaceAll('đ', 'd')
    // Splits each accented letter into the letter and its accents, then drops the accents: "ế" -> "e".
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
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
// each table is renamed, made again from CREATE_TABLES, filled from the old one, and the old one dropped. Ids and the
// AUTOINCREMENT counters are kept. The caller has made a backup and runs this in one transaction with foreign keys off.
export function migrateFrom1(database: DatabaseSync): void {
  const TABLES = ['projects', 'exercises', 'attempts'];
  database.exec('DROP INDEX attempts_by_exercise; DROP INDEX attempts_by_project');
  for (const table of TABLES) database.exec(`ALTER TABLE ${table} RENAME TO ${table}_v1`);
  for (const statement of CREATE_TABLES) database.exec(statement);

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
