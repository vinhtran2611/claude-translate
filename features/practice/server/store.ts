// The one place that reads and writes the practice database (docs/data-model-proposal.md §3.4 and §4).
import type { DatabaseSync } from 'node:sqlite';
import type { ModelRun, RunErrorCode, RunStatus } from '../../../shared/api.ts';
import {
  RUN_FINISH_SET, RUN_INSERT_COLUMNS, RUN_INSERT_VALUES, runOf, runRowOf, thinkingTextOf, type RunRow,
} from '../../../shared/server/model-run.ts';
import { inTransaction, openDatabase } from '../../../shared/server/sqlite.ts';
import type {
  Answer, AttemptDetail, AttemptLine, Change, ExerciseBody, ExerciseContent, ExerciseDetail, ExerciseItem, ExerciseType, Grading,
  GradingSettings, ImportFile, ImportResult, List, ProjectFile, ProjectInput, ProjectSummary,
} from '../api.ts';
import { historyLineOf, labelOf, previewOf } from '../text.ts';
import { CREATE_TABLES, INTERRUPTED_MESSAGE, migrateFrom1, migrateFrom2, SCHEMA_VERSION } from './store-schema.ts';

// What createAttempt stores. grading: the settings of the AI grading it starts; null for a flashcard (rule 6).
export interface NewAttempt {
  exerciseId: number;
  answer: Answer;
  timeSpentMs: number | null;
  grading: GradingSettings | null;
}

// How an AI grading ended: the feedback it wrote, or why it failed (with what it had written by then, if anything).
export type GradingOutcome =
  | { status: 'succeeded'; servedModelId: string; thinkingText: string; thinkingMs: number | null; feedbackMarkdown: string }
  | {
    status: 'failed'; servedModelId: string | null; thinkingText: string; thinkingMs: number | null; feedbackMarkdown: string;
    errorCode: RunErrorCode; errorMessage: string;
  };

export interface AttemptFilter {
  project: string | null;
  exercise: string | null;
  // The status of the attempt's latest grading.
  status: RunStatus | null;
  // ISO times.
  since: string | null;
  before: number | null;
  limit: number;
}

// An attempt that was just saved, with the grading that must now run (null for a flashcard).
export interface StartedAttempt {
  attempt: AttemptDetail;
  gradingId: number | null;
}

// Every write that takes a body can be a dry run: it reports what would happen and writes nothing.
export interface PracticeStore {
  listProjects(archived: 'false' | 'true' | 'all'): ProjectSummary[];
  readProject(key: string): ProjectSummary | null;
  putProject(key: string, input: Required<ProjectInput>, is_dry_run: boolean): { project: ProjectSummary; change: Change };
  // Gives a project a new key. Its exercises and attempts point at its id, so they stay linked.
  renameProject(key: string, new_key: string, is_dry_run: boolean): ProjectSummary | 'not_found' | 'key_taken';
  // A project with attempts is deleted only with is_with_attempts; its exercises and attempts go with it (rule 8).
  deleteProject(key: string, is_with_attempts: boolean): 'deleted' | 'not_found' | 'has_attempts';
  // null: no such project.
  listExercises(project_key: string, filter: { type: ExerciseType | null; tag: string | null }): ExerciseItem[] | null;
  readExercise(project_key: string, key: string): ExerciseDetail | null;
  // A new exercise goes to the end. null: no such project.
  putExercise(project_key: string, key: string, exercise: ExerciseBody, is_dry_run: boolean): { exercise: ExerciseDetail; change: Change } | null;
  // Gives an exercise a new key. Content, version and position do not change; its attempts stay linked.
  renameExercise(project_key: string, key: string, new_key: string, is_dry_run: boolean): ExerciseDetail | 'not_found' | 'key_taken';
  // Moves an exercise to the end of another project, with its attempts. The same project is no change.
  moveExercise(project_key: string, key: string, to_project_key: string, is_dry_run: boolean): ExerciseDetail | 'not_found' | 'no_target' | 'key_taken';
  // Puts these keys first, in this order; the others keep their order after them (as an import does). Every key must be
  // one of the project's exercises. The list in its new order; null: no such project.
  reorderExercises(project_key: string, keys: string[], is_dry_run: boolean): ExerciseItem[] | null;
  // An exercise with attempts is deleted only with is_with_attempts; its attempts go with it (rule 8).
  deleteExercise(project_key: string, key: string, is_with_attempts: boolean): 'deleted' | 'not_found' | 'has_attempts';
  // Upserts by key in one transaction (docs/practice-api-design.md §3.5); never deletes.
  importFile(file: ProjectFile, is_dry_run: boolean): ImportResult;
  exportProject(key: string): ImportFile | null;
  // Saves the attempt and, for every type but a flashcard, a running grading, in one transaction.
  createAttempt(attempt: NewAttempt): StartedAttempt;
  listAttempts(filter: AttemptFilter): List<AttemptDetail>;
  readAttempt(attempt_id: number): AttemptDetail | null;
  deleteAttempt(attempt_id: number): 'deleted' | 'not_found' | 'grading';
  // A new running grading of the attempt (rule 7: at any time, but one at a time).
  regrade(attempt_id: number, settings: GradingSettings): StartedAttempt | 'not_found' | 'not_graded_by_ai' | 'grading';
  // Ends a running grading; a grading that is no longer running is left as it is.
  finishGrading(grading_id: number, outcome: GradingOutcome): void;
  // A server stopped mid-grading leaves running gradings nobody will finish: they become failed with 'interrupted'.
  failInterruptedGradings(): number;
}

interface ProjectRow {
  id: number;
  key: string;
  name: string;
  description: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  last_activity_at: string | null;
  exercise_count: number;
  done_count: number;
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

interface ExerciseDetailRow extends ExerciseRow {
  project_key: string;
  position: number;
  created_at: string;
  updated_at: string;
  is_done: number;
  attempt_count: number;
}

interface ItemRow extends ExerciseRow {
  updated_at: string;
  is_done: number;
  // The latest attempt's columns; all null when there is none.
  last_id: number | null;
  last_created_at: string | null;
  last_answer_json: string | null;
  last_grading_status: RunStatus | null;
}

interface AttemptRow {
  id: number;
  exercise_id: number;
  exercise_version: number;
  exercise_snapshot_json: string;
  answer_json: string;
  time_spent_ms: number | null;
  created_at: string;
  updated_at: string;
  project_key: string;
  exercise_key: string;
}

interface GradingRow extends RunRow {
  id: number;
  attempt_id: number;
  feedback_markdown: string | null;
  created_at: string;
  updated_at: string;
}

function bodyOf(row: Pick<ExerciseRow, 'topic' | 'tags_json' | 'content_json'>): ExerciseBody {
  return { topic: row.topic, tags: JSON.parse(row.tags_json), content: JSON.parse(row.content_json) };
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
  const is_same_topic = row.topic === body.topic;
  const is_same_tags = canonical(JSON.parse(row.tags_json)) === canonical(body.tags);
  const is_same_content = canonical(JSON.parse(row.content_json)) === canonical(body.content);
  return is_same_topic && is_same_tags && is_same_content;
}

// A row whose JSON has the wrong shape still lists: with its type as the label and no preview.
function describe(row: ExerciseRow): { label: string; preview: string } {
  try {
    const content = JSON.parse(row.content_json) as ExerciseContent;
    return { label: labelOf(content), preview: previewOf(content) };
  } catch {
    return { label: row.type, preview: '' };
  }
}

function gradingOf(row: GradingRow): Grading {
  return {
    id: row.id,
    attemptId: row.attempt_id,
    run: runOf(row),
    feedbackMarkdown: row.feedback_markdown,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function projectOf(row: ProjectRow, type_counts: Partial<Record<ExerciseType, number>>): ProjectSummary {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at,
    exerciseCount: row.exercise_count,
    doneCount: row.done_count,
    typeCounts: type_counts,
  };
}

// An exercise is done when it has a flashcard attempt, or an attempt with a succeeded grading (rule 9). `exercises` is
// the exercise row in the query this goes into. The attempt's own answer says whether it is a flashcard: the exercise's
// type may have changed since.
const IS_DONE = `EXISTS (
  SELECT 1 FROM attempts WHERE attempts.exercise_id = exercises.id
    AND (attempts.answer_json ->> '$.type' = 'flashcard'
      OR EXISTS (SELECT 1 FROM gradings WHERE gradings.attempt_id = attempts.id AND gradings.run_status = 'succeeded')))`;
// A project's last activity is the newest createdAt of its attempts (rule 9).
const PROJECT_COLUMNS = `
  id, key, name, description, archived_at, created_at, updated_at,
  (SELECT max(attempts.created_at) FROM attempts JOIN exercises ON exercises.id = attempts.exercise_id
   WHERE exercises.project_id = projects.id) AS last_activity_at,
  (SELECT count(*) FROM exercises WHERE project_id = projects.id) AS exercise_count,
  (SELECT count(*) FROM exercises WHERE project_id = projects.id AND ${IS_DONE}) AS done_count`;
const ATTEMPT_COLUMNS = `
  attempts.id, attempts.exercise_id, attempts.exercise_version, attempts.exercise_snapshot_json, attempts.answer_json,
  attempts.time_spent_ms, attempts.created_at, attempts.updated_at, projects.key AS project_key, exercises.key AS exercise_key
  FROM attempts
  JOIN exercises ON exercises.id = attempts.exercise_id
  JOIN projects ON projects.id = exercises.project_id`;
// The status of an attempt's latest grading (the one shown: rule 7); NULL for a flashcard.
const LATEST_GRADING_STATUS = '(SELECT run_status FROM gradings WHERE attempt_id = attempts.id ORDER BY id DESC LIMIT 1)';

export function openPracticeStore(database_path: string): PracticeStore {
  const database: DatabaseSync = openDatabase(database_path, SCHEMA_VERSION, (migrating_database, file_schema_version) => {
    // 0 is a new, empty file.
    if (file_schema_version === 0) {
      for (const statement of CREATE_TABLES) migrating_database.exec(statement);
      return;
    }
    if (file_schema_version === 1) migrateFrom1(migrating_database);
    if (file_schema_version <= 2) migrateFrom2(migrating_database);
  });
  database.exec('PRAGMA foreign_keys = ON');

  // ---- projects ----
  const select_projects = database.prepare(`
    SELECT ${PROJECT_COLUMNS} FROM projects
    WHERE $archived = 'all' OR ($archived = 'true') = (archived_at IS NOT NULL)
    ORDER BY coalesce(last_activity_at, created_at) DESC, id DESC`);
  const select_project = database.prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE key = $key`);
  const select_type_counts = database.prepare(`
    SELECT type, count(*) AS count FROM exercises WHERE project_id = $project_id GROUP BY type`);
  const insert_project = database.prepare(`
    INSERT INTO projects (key, name, description, archived_at, created_at, updated_at)
    VALUES ($key, $name, $description, $archived_at, $now, $now)`);
  const update_project = database.prepare(`
    UPDATE projects SET name = $name, description = $description, archived_at = $archived_at, updated_at = $now
    WHERE id = $id`);
  const rename_project = database.prepare('UPDATE projects SET key = $new_key, updated_at = $now WHERE id = $id');
  const select_project_has_attempts = database.prepare(`
    SELECT EXISTS (SELECT 1 FROM attempts JOIN exercises ON exercises.id = attempts.exercise_id
                   WHERE exercises.project_id = $project_id) AS has_attempts`);
  const delete_project = database.prepare('DELETE FROM projects WHERE id = $id');

  // ---- exercises ----
  const select_exercise_row = database.prepare(`
    SELECT exercises.id, project_id, exercises.key, type, topic, tags_json, content_json, version FROM exercises
    JOIN projects ON projects.id = exercises.project_id WHERE projects.key = $project_key AND exercises.key = $key`);
  const select_exercise_row_by_project = database.prepare(`
    SELECT id, project_id, key, type, topic, tags_json, content_json, version FROM exercises
    WHERE project_id = $project_id AND key = $key`);
  const select_exercise = database.prepare(`
    SELECT exercises.id, exercises.project_id, projects.key AS project_key, exercises.key, type, topic, tags_json, content_json,
           position, version, exercises.created_at, exercises.updated_at,
           ${IS_DONE} AS is_done,
           (SELECT count(*) FROM attempts WHERE exercise_id = exercises.id) AS attempt_count
    FROM exercises JOIN projects ON projects.id = exercises.project_id WHERE projects.key = $project_key AND exercises.key = $key`);
  const select_exercise_items = database.prepare(`
    SELECT exercises.id, exercises.project_id, exercises.key, exercises.type, topic, tags_json, content_json, version,
           exercises.updated_at, ${IS_DONE} AS is_done,
           last.id AS last_id, last.created_at AS last_created_at, last.answer_json AS last_answer_json,
           (SELECT run_status FROM gradings WHERE attempt_id = last.id ORDER BY id DESC LIMIT 1) AS last_grading_status
    FROM exercises LEFT JOIN attempts AS last ON last.id = (SELECT max(id) FROM attempts WHERE exercise_id = exercises.id)
    WHERE exercises.project_id = $project_id AND ($type IS NULL OR exercises.type = $type)
      AND ($tag IS NULL OR EXISTS (SELECT 1 FROM json_each(exercises.tags_json) WHERE value = $tag))
    ORDER BY position, exercises.id`);
  const select_export_rows = database.prepare(`
    SELECT key, topic, tags_json, content_json FROM exercises
    WHERE project_id = $project_id ORDER BY position, id`);
  // The last position in a project; 0 when it has no exercises.
  const select_position = database.prepare(`
    SELECT coalesce(max(position), 0) AS position FROM exercises WHERE project_id = $project_id`);
  const select_positions = database.prepare('SELECT id, key, position FROM exercises WHERE project_id = $project_id ORDER BY position, id');
  const insert_exercise = database.prepare(`
    INSERT INTO exercises (project_id, key, position, type, topic, tags_json, content_json, version, created_at, updated_at)
    VALUES ($project_id, $key, $position, $type, $topic, $tags_json, $content_json, 1, $now, $now)`);
  const update_exercise = database.prepare(`
    UPDATE exercises
    SET type = $type, topic = $topic, tags_json = $tags_json, content_json = $content_json, version = version + 1, updated_at = $now
    WHERE id = $id`);
  const set_position = database.prepare('UPDATE exercises SET position = $position, updated_at = $now WHERE id = $id');
  const select_exercise_has_attempts = database.prepare('SELECT EXISTS (SELECT 1 FROM attempts WHERE exercise_id = $id) AS has_attempts');
  const delete_exercise = database.prepare('DELETE FROM exercises WHERE id = $id');
  const rename_exercise = database.prepare('UPDATE exercises SET key = $new_key, updated_at = $now WHERE id = $id');
  const move_exercise = database.prepare('UPDATE exercises SET project_id = $project_id, position = $position, updated_at = $now WHERE id = $id');
  const select_exercise_by_id = database.prepare(`
    SELECT id, project_id, key, type, topic, tags_json, content_json, version FROM exercises WHERE id = $id`);

  // ---- attempts and gradings ----
  const insert_attempt = database.prepare(`
    INSERT INTO attempts (exercise_id, exercise_version, exercise_snapshot_json, answer_json, time_spent_ms, created_at, updated_at)
    VALUES ($exercise_id, $exercise_version, $exercise_snapshot_json, $answer_json, $time_spent_ms, $now, $now)`);
  const select_attempt = database.prepare(`SELECT ${ATTEMPT_COLUMNS} WHERE attempts.id = $id`);
  const select_attempts = database.prepare(`
    SELECT ${ATTEMPT_COLUMNS}
    WHERE ($project IS NULL OR projects.key = $project)
      AND ($exercise IS NULL OR exercises.key = $exercise)
      AND ($status IS NULL OR ${LATEST_GRADING_STATUS} = $status)
      AND ($since IS NULL OR attempts.created_at >= $since)
      AND ($before IS NULL OR attempts.id < $before)
    ORDER BY attempts.id DESC LIMIT $limit`);
  const select_gradings = database.prepare('SELECT * FROM gradings WHERE attempt_id = $attempt_id ORDER BY id');
  const select_running_grading = database.prepare("SELECT id FROM gradings WHERE attempt_id = $attempt_id AND run_status = 'running'");
  const delete_attempt = database.prepare('DELETE FROM attempts WHERE id = $id');
  const insert_grading = database.prepare(`
    INSERT INTO gradings (attempt_id, ${RUN_INSERT_COLUMNS}, feedback_markdown, created_at, updated_at)
    VALUES ($attempt_id, ${RUN_INSERT_VALUES}, NULL, $now, $now)`);
  // Only a running grading is finished, so a late outcome can never overwrite a finished one.
  const finish_grading = database.prepare(`
    UPDATE gradings SET ${RUN_FINISH_SET}, feedback_markdown = $feedback_markdown, updated_at = $run_finished_at
    WHERE id = $id AND run_status = 'running'`);
  const fail_interrupted = database.prepare(`
    UPDATE gradings
    SET run_status = 'failed', run_error_code = 'interrupted', run_error_message = $message, run_finished_at = $now, updated_at = $now
    WHERE run_status = 'running'`);

  function typeCountsOf(project_id: number): Partial<Record<ExerciseType, number>> {
    const type_counts: Partial<Record<ExerciseType, number>> = {};
    const counts = select_type_counts.all({ project_id }) as { type: ExerciseType; count: number }[];
    for (const { type, count } of counts) type_counts[type] = count;
    return type_counts;
  }

  function summaryOf(row: ProjectRow): ProjectSummary {
    return projectOf(row, typeCountsOf(row.id));
  }

  function projectRowOf(key: string): ProjectRow | undefined {
    return select_project.get({ key }) as ProjectRow | undefined;
  }

  function listProjects(archived: 'false' | 'true' | 'all'): ProjectSummary[] {
    const rows = select_projects.all({ archived }) as unknown as ProjectRow[];
    return rows.map(summaryOf);
  }

  function readProject(key: string): ProjectSummary | null {
    const row = projectRowOf(key);
    if (row === undefined) return null;
    return summaryOf(row);
  }

  function putProject(key: string, { name, description, archivedAt }: Required<ProjectInput>, is_dry_run: boolean): { project: ProjectSummary; change: Change } {
    return inTransaction(database, () => {
      const now = new Date().toISOString();
      const row = projectRowOf(key);
      let change: Change = 'unchanged';
      if (row === undefined) {
        insert_project.run({ key, name, description, archived_at: archivedAt, now });
        change = 'created';
      } else if (row.name !== name || row.description !== description || row.archived_at !== archivedAt) {
        update_project.run({ id: row.id, name, description, archived_at: archivedAt, now });
        change = 'updated';
      }
      return { project: readProject(key) as ProjectSummary, change };
    }, is_dry_run);
  }

  // The same key again is no change.
  function renameProject(key: string, new_key: string, is_dry_run: boolean): ProjectSummary | 'not_found' | 'key_taken' {
    return inTransaction(database, () => {
      const row = projectRowOf(key);
      if (row === undefined) return 'not_found';
      if (new_key === key) return readProject(key) as ProjectSummary;
      if (projectRowOf(new_key) !== undefined) return 'key_taken';
      rename_project.run({ id: row.id, new_key, now: new Date().toISOString() });
      return readProject(new_key) as ProjectSummary;
    }, is_dry_run);
  }

  function deleteProject(key: string, is_with_attempts: boolean): 'deleted' | 'not_found' | 'has_attempts' {
    const row = projectRowOf(key);
    if (row === undefined) return 'not_found';
    const { has_attempts } = select_project_has_attempts.get({ project_id: row.id }) as { has_attempts: number };
    if (has_attempts === 1 && !is_with_attempts) return 'has_attempts';
    delete_project.run({ id: row.id });
    return 'deleted';
  }

  function lastAttemptOf(row: ItemRow): AttemptLine | null {
    if (row.last_id === null) return null;
    const answer = JSON.parse(row.last_answer_json as string) as Answer;
    return {
      id: row.last_id,
      createdAt: row.last_created_at as string,
      gradingStatus: row.last_grading_status,
      historyLine: historyLineOf(answer, row.last_grading_status),
    };
  }

  function itemOf(row: ItemRow): ExerciseItem {
    const { label, preview } = describe(row);
    return {
      id: row.id,
      key: row.key,
      type: row.type,
      label,
      preview,
      topic: row.topic,
      tags: JSON.parse(row.tags_json),
      version: row.version,
      updatedAt: row.updated_at,
      isDone: row.is_done === 1,
      lastAttempt: lastAttemptOf(row),
    };
  }

  function itemsOf(project_id: number, type: ExerciseType | null, tag: string | null): ExerciseItem[] {
    const rows = select_exercise_items.all({ project_id, type, tag }) as unknown as ItemRow[];
    return rows.map(itemOf);
  }

  function listExercises(project_key: string, { type, tag }: { type: ExerciseType | null; tag: string | null }): ExerciseItem[] | null {
    const project = projectRowOf(project_key);
    if (project === undefined) return null;
    return itemsOf(project.id, type, tag);
  }

  function readExercise(project_key: string, key: string): ExerciseDetail | null {
    const row = select_exercise.get({ project_key, key }) as ExerciseDetailRow | undefined;
    if (row === undefined) return null;
    return {
      id: row.id,
      projectId: row.project_id,
      key: row.key,
      position: row.position,
      ...bodyOf(row),
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      projectKey: row.project_key,
      isDone: row.is_done === 1,
      attemptCount: row.attempt_count,
    };
  }

  // Creates or replaces one exercise. A new one goes to the end; an old one stays where it is.
  function upsertExercise(project_id: number, key: string, body: ExerciseBody, now: string): Change {
    const row = select_exercise_row_by_project.get({ project_id, key }) as ExerciseRow | undefined;
    const columns = {
      type: body.content.type,
      topic: body.topic,
      tags_json: JSON.stringify(body.tags),
      content_json: JSON.stringify(body.content),
      now,
    };
    if (row === undefined) {
      const { position: last_position } = select_position.get({ project_id }) as { position: number };
      insert_exercise.run({ project_id, key, position: last_position + 1, ...columns });
      return 'created';
    }
    if (isSameBody(row, body)) return 'unchanged';
    update_exercise.run({ id: row.id, ...columns });
    return 'updated';
  }

  function putExercise(project_key: string, key: string, body: ExerciseBody, is_dry_run: boolean): { exercise: ExerciseDetail; change: Change } | null {
    return inTransaction(database, () => {
      const project = projectRowOf(project_key);
      if (project === undefined) return null;
      const change = upsertExercise(project.id, key, body, new Date().toISOString());
      return { exercise: readExercise(project_key, key) as ExerciseDetail, change };
    }, is_dry_run);
  }

  function renameExercise(project_key: string, key: string, new_key: string, is_dry_run: boolean): ExerciseDetail | 'not_found' | 'key_taken' {
    return inTransaction(database, () => {
      const row = select_exercise_row.get({ project_key, key }) as ExerciseRow | undefined;
      if (row === undefined) return 'not_found';
      if (new_key === key) return readExercise(project_key, key) as ExerciseDetail;
      if (select_exercise_row_by_project.get({ project_id: row.project_id, key: new_key }) !== undefined) return 'key_taken';
      rename_exercise.run({ id: row.id, new_key, now: new Date().toISOString() });
      return readExercise(project_key, new_key) as ExerciseDetail;
    }, is_dry_run);
  }

  // Its attempts point at the exercise, so they move with it.
  function moveExercise(project_key: string, key: string, to_project_key: string, is_dry_run: boolean): ExerciseDetail | 'not_found' | 'no_target' | 'key_taken' {
    return inTransaction(database, () => {
      const row = select_exercise_row.get({ project_key, key }) as ExerciseRow | undefined;
      if (row === undefined) return 'not_found';
      const target = projectRowOf(to_project_key);
      if (target === undefined) return 'no_target';
      if (target.id === row.project_id) return readExercise(project_key, key) as ExerciseDetail;
      if (select_exercise_row_by_project.get({ project_id: target.id, key }) !== undefined) return 'key_taken';

      const { position: last_position } = select_position.get({ project_id: target.id }) as { position: number };
      move_exercise.run({ id: row.id, project_id: target.id, position: last_position + 1, now: new Date().toISOString() });
      return readExercise(to_project_key, key) as ExerciseDetail;
    }, is_dry_run);
  }

  // Puts the exercises with these keys first, in this order; the project's other exercises keep their order after them.
  // Positions become 1, 2, 3... Every key must be one of the project's exercises. Only an exercise whose position
  // changes is written.
  function setOrder(project_id: number, keys: string[], now: string): void {
    const rows = select_positions.all({ project_id }) as { id: number; key: string; position: number }[];
    const row_of_key = new Map(rows.map((row) => [row.key, row]));
    const listed = new Set(keys);
    const others = rows.map((row) => row.key).filter((key) => !listed.has(key));
    const order = [...keys, ...others];
    order.forEach((key, index) => {
      const row = row_of_key.get(key) as { id: number; position: number };
      const position = index + 1;
      if (row.position !== position) set_position.run({ id: row.id, position, now });
    });
  }

  function reorderExercises(project_key: string, keys: string[], is_dry_run: boolean): ExerciseItem[] | null {
    return inTransaction(database, () => {
      const project = projectRowOf(project_key);
      if (project === undefined) return null;
      setOrder(project.id, keys, new Date().toISOString());
      return itemsOf(project.id, null, null);
    }, is_dry_run);
  }

  function deleteExercise(project_key: string, key: string, is_with_attempts: boolean): 'deleted' | 'not_found' | 'has_attempts' {
    const row = select_exercise_row.get({ project_key, key }) as ExerciseRow | undefined;
    if (row === undefined) return 'not_found';
    const { has_attempts } = select_exercise_has_attempts.get({ id: row.id }) as { has_attempts: number };
    if (has_attempts === 1 && !is_with_attempts) return 'has_attempts';
    delete_exercise.run({ id: row.id });
    return 'deleted';
  }

  function importFile(file: ProjectFile, is_dry_run: boolean): ImportResult {
    const { key } = file;
    return inTransaction(database, () => {
      const now = new Date().toISOString();
      const row = projectRowOf(key);
      let project_change: Change = 'unchanged';
      if (row === undefined) {
        insert_project.run({ key, name: file.name, description: file.description, archived_at: null, now });
        project_change = 'created';
      } else if (row.name !== file.name || row.description !== file.description) {
        update_project.run({ id: row.id, name: file.name, description: file.description, archived_at: row.archived_at, now });
        project_change = 'updated';
      }
      const project_id = (projectRowOf(key) as ProjectRow).id;
      const exercises: ImportResult['exercises'] = { created: [], updated: [], unchanged: [] };
      for (const exercise of file.exercises) {
        const { key: exercise_key, ...body } = exercise;
        const change = upsertExercise(project_id, exercise_key, body, now);
        exercises[change].push(exercise_key);
      }
      const keys = file.exercises.map((exercise) => exercise.key);
      setOrder(project_id, keys, now);
      return { dryRun: is_dry_run, project: readProject(key) as ProjectSummary, projectChange: project_change, exercises };
    }, is_dry_run);
  }

  // The project as a format 4 file, every field written out: importing it again changes nothing.
  function exportProject(key: string): ImportFile | null {
    const project = projectRowOf(key);
    if (project === undefined) return null;
    const rows = select_export_rows.all({ project_id: project.id }) as unknown as (ExerciseRow & { key: string })[];
    const exercises = rows.map((row) => ({ key: row.key, ...bodyOf(row) }));
    const project_fields = { key, name: project.name, description: project.description };
    return { format: 4, project: project_fields, exercises };
  }

  function gradingsOf(attempt_id: number): Grading[] {
    const rows = select_gradings.all({ attempt_id }) as unknown as GradingRow[];
    return rows.map(gradingOf);
  }

  function attemptOf(row: AttemptRow): AttemptDetail {
    return {
      id: row.id,
      exerciseId: row.exercise_id,
      exerciseVersion: row.exercise_version,
      exerciseSnapshot: JSON.parse(row.exercise_snapshot_json),
      answer: JSON.parse(row.answer_json),
      timeSpentMs: row.time_spent_ms,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      projectKey: row.project_key,
      exerciseKey: row.exercise_key,
      gradings: gradingsOf(row.id),
    };
  }

  // A grading that has just started: the model chosen, the one serving it not known yet.
  function startGrading(attempt_id: number, { modelId, effort }: GradingSettings, now: string): number {
    const run: ModelRun = {
      status: 'running',
      requestedModelId: modelId,
      servedModelId: null,
      effort,
      thinkingText: null,
      thinkingMs: null,
      errorCode: null,
      errorMessage: null,
      startedAt: now,
      finishedAt: null,
    };
    const inserted = insert_grading.run({ attempt_id, ...runRowOf(run), now });
    return Number(inserted.lastInsertRowid);
  }

  // The snapshot is taken from the row as it is now, in the same transaction as the insert.
  function createAttempt({ exerciseId, answer, timeSpentMs, grading }: NewAttempt): StartedAttempt {
    const now = new Date().toISOString();
    const { attempt_id, grading_id } = inTransaction(database, () => {
      const exercise = select_exercise_by_id.get({ id: exerciseId }) as unknown as ExerciseRow;
      const inserted = insert_attempt.run({
        exercise_id: exerciseId,
        exercise_version: exercise.version,
        exercise_snapshot_json: JSON.stringify(bodyOf(exercise)),
        answer_json: JSON.stringify(answer),
        time_spent_ms: timeSpentMs,
        now,
      });
      const new_attempt_id = Number(inserted.lastInsertRowid);
      let new_grading_id: number | null = null;
      if (grading !== null) new_grading_id = startGrading(new_attempt_id, grading, now);
      return { attempt_id: new_attempt_id, grading_id: new_grading_id };
    });
    return { attempt: readAttempt(attempt_id) as AttemptDetail, gradingId: grading_id };
  }

  // Newest first; one more row than asked tells whether there is a next page.
  function listAttempts({ limit, ...filter }: AttemptFilter): List<AttemptDetail> {
    const rows = select_attempts.all({ ...filter, limit: limit + 1 }) as unknown as AttemptRow[];
    const items = rows.slice(0, limit).map(attemptOf);
    if (rows.length <= limit) return { items };
    const last = items[items.length - 1];
    return { items, nextBefore: last.id };
  }

  function readAttempt(attempt_id: number): AttemptDetail | null {
    const row = select_attempt.get({ id: attempt_id }) as AttemptRow | undefined;
    if (row === undefined) return null;
    return attemptOf(row);
  }

  function deleteAttempt(attempt_id: number): 'deleted' | 'not_found' | 'grading' {
    return inTransaction(database, () => {
      if (select_attempt.get({ id: attempt_id }) === undefined) return 'not_found';
      if (select_running_grading.get({ attempt_id }) !== undefined) return 'grading';
      delete_attempt.run({ id: attempt_id });
      return 'deleted';
    });
  }

  function regrade(attempt_id: number, settings: GradingSettings): StartedAttempt | 'not_found' | 'not_graded_by_ai' | 'grading' {
    const grading_id = inTransaction(database, () => {
      const row = select_attempt.get({ id: attempt_id }) as AttemptRow | undefined;
      if (row === undefined) return 'not_found';
      const answer = JSON.parse(row.answer_json) as Answer;
      if (answer.type === 'flashcard') return 'not_graded_by_ai';
      if (select_running_grading.get({ attempt_id }) !== undefined) return 'grading';
      return startGrading(attempt_id, settings, new Date().toISOString());
    });
    if (typeof grading_id === 'string') return grading_id;
    return { attempt: readAttempt(attempt_id) as AttemptDetail, gradingId: grading_id };
  }

  function finishGrading(grading_id: number, outcome: GradingOutcome): void {
    let error_code: RunErrorCode | null = null;
    let error_message: string | null = null;
    if (outcome.status === 'failed') {
      error_code = outcome.errorCode;
      error_message = outcome.errorMessage;
    }
    // A failed grading keeps what it had written, if anything (the output is "none, or partial").
    let feedback_markdown: string | null = outcome.feedbackMarkdown;
    if (feedback_markdown === '' && outcome.status === 'failed') feedback_markdown = null;
    finish_grading.run({
      id: grading_id,
      run_status: outcome.status,
      run_served_model_id: outcome.servedModelId,
      run_thinking_text: thinkingTextOf(outcome.thinkingText),
      run_thinking_ms: outcome.thinkingMs,
      run_error_code: error_code,
      run_error_message: error_message,
      run_finished_at: new Date().toISOString(),
      feedback_markdown,
    });
  }

  function failInterruptedGradings(): number {
    const result = fail_interrupted.run({ message: INTERRUPTED_MESSAGE, now: new Date().toISOString() });
    return Number(result.changes);
  }

  return {
    listProjects, readProject, putProject, renameProject, deleteProject, listExercises, readExercise, putExercise, renameExercise, moveExercise,
    reorderExercises, deleteExercise, importFile, exportProject, createAttempt, listAttempts, readAttempt, deleteAttempt, regrade,
    finishGrading, failInterruptedGradings,
  };
}
