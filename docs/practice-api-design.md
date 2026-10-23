# Practice API and data model: design review and proposal

> **Note (data model, schema 3):** the data model and the JSON names in this doc are older than
> [data-model-proposal.md](data-model-proposal.md), which the code now follows: camelCase JSON, seven exercise types tagged by
> `content.type`, gradings as their own rows, import format 4 (format 3 still read). The endpoints and their rules below still
> hold, except where that doc changed them (an exercise with attempts is deleted only with `?with_attempts=true`; regrade works
> at any time).

Status: **built** (steps 1 to 5 of §6; step 6, the agent guide, is still to do). Date: 2026-10-19. Where the code differs from
this doc, §9 says how and why. §10 adds rename, move and order, which the first version left out.

This doc reviews the current Practice API and database, then proposes a replacement. It is written for one person, one
machine, one SQLite file. Every choice below has **one** recommendation, the reason, and the cost. Section 8 lists what we
should **not** build.

Who uses the API:

- **You, in the browser** (the Practice page).
- **You, with curl** (quick checks, scripts).
- **An AI agent** (Claude Code in the `ielts` repo): it generates exercise files every day, fixes single exercises, and reads
  your results to plan the next day.

The goal: one clean, predictable API that all three can use with the same JSON.

---

## 1. Review of the current API and data model

### 1.1 What is good (keep it)

- **Strict validation that reports every problem at once**, and **all-or-nothing import** (`import-check.ts:154-190`,
  `store.ts:213-228`). This is the right default for files that an AI writes.
- **Attempts keep a snapshot of the exercise** (`store.ts:235-247`). This is the most important design choice in the
  feature: it makes editing and deleting exercises safe, because old attempts never change.
- **The answer is saved before grading starts**, grading runs on the server, and the SSE stream sends a `snapshot` first and
  then deltas (`ai-grading.ts:64-132`). A page can leave and come back. A restart turns lost gradings into `failed`
  (`store.ts:272-274`). This is a solid async-job design; keep it as it is.
- **Safe storage**: `STRICT` tables with `CHECK`s, schema version in `PRAGMA user_version`, migrations in one transaction,
  `synchronous = FULL`, daily backups (`src/shared/server/sqlite.ts`).
- **Safe network**: loopback only, with a `Host` allow-list (`src/server.ts`).
- **One shared spec** for the file check, used by the page and the server (`import-check.ts:26-58`).

### 1.2 Problems

| # | Problem | Where | Why it hurts |
|---|---|---|---|
| P1 | **Import is the only way to create exercises**, and there is **no update or delete** for projects, exercises or attempts. Only 10 routes. | `routes.ts:148-159` | You cannot fix one typo. You must re-import a whole file as a **new** project. |
| P2 | **Adding a file rejects any key the project already has.** | `store.ts:221-228`, `routes.ts:108-111` | Re-importing a fixed file is impossible. The live DB shows the result: projects 2 "Day 1 - 19/10/2026" and 3 "Day 1 - 19/10/2026 - v2", 23 exercises each; your attempts are only in project 2. The file itself is already at "(v3)". |
| P3 | **Create is not idempotent.** `POST projects` twice makes two projects. | `routes.ts:88-99` | An agent that retries after a timeout makes duplicates. |
| P4 | **The JSON file is sent as a string inside JSON** (`{ "file": "{\"format\":2,...}" }`). | `api.ts:253-260`, `routes.ts:60-64`; the body limit is `4 × MAX_FILE_CHARS` only because of the escaping (`routes.ts:33-34`) | curl cannot send a file with `--data-binary @day-01.json`; you need `jq` to wrap it. The agent must escape 100 KB of JSON. Double encoding is a classic smell. |
| P5 | **Four error shapes.** `text/plain` reason (`routes.ts:43-45`), JSON `{ errors: string[] }` (`routes.ts:62, 110`), an empty 404 for an unknown path (`server/server.ts:545`), `text/plain` "Internal error" (`server/server.ts:552`). | | The client guesses by trying `JSON.parse` (`client.ts:26-34`). An agent cannot tell "bad field" from "not found" without reading English. |
| P6 | **Errors are prose only.** The field path is inside the sentence: `Exercise 3 (choice): content.options: no option is marked correct.` (`import-check.ts:183`). No codes. | `import-check.ts:68-127` | A program (UI or agent) cannot point at the field or react to a kind of error. |
| P7 | **Validation is split.** The file check is in `import-check.ts`; the duplicate-key check is a second, different message built in the route (`routes.ts:109`). | | Two places to change, two message styles. |
| P8 | **Numeric ids only.** URLs use `(\d{1,9})` (`routes.ts:147`). The exercise's human key (`exercises.key`, `UNIQUE(project_id, key)`) is stored but not addressable. Projects have no key at all. | `routes.ts:147-158`, schema | The agent knows `d1-fix-3` (it wrote it) but must first list projects, find the id by name, then load the project to find the exercise id. |
| P9 | **No content version.** `exercises` has no `version` or `updated_at`; an attempt does not record which version it answered. | schema, `store.ts:26-36` | Once edits exist you cannot tell "answered the old wording" from "answered the new one". |
| P10 | **One endpoint does three jobs.** `GET projects/:id` returns project + exercise list + history (`store.ts:203-211`, `api.ts:244-251`). Every screen calls it (`web/exercise.ts:39, 46, 174`). | | Over-fetching is fine at this scale; the real cost is that there is no clean "list exercises" or "list attempts" for anyone else. |
| P11 | **No list of attempts, no export.** | | The agent cannot read "what did I get wrong today" to plan tomorrow, and cannot fetch a project to edit it. This is the most useful agent feature, and it is missing. |
| P12 | **Not discoverable.** The format is in a Markdown doc (served at `/practice/format-guide.md`, `routes.ts:31`). There is no machine-readable schema, no list of limits, no dry run on the server. | | An agent learns the format by trial and error, and an error on a valid file **creates** a project (P3). |
| P13 | **Wrong method gives 404, not 405.** A route only matches with its method (`routes.ts:171-177`). | | Small, but confusing when you try `PUT` and get "not found". |
| P14 | **Small data-model smells.** No `ON DELETE` rules (deletes were never needed). `attempts.summary` stores display text ("Graded", "Almost") (`store.ts:13`, `answers.ts:53-55`). `effort` lives only inside `result_json`, while `model` is both a column and in `result_json`. | schema | Only P14's `ON DELETE` matters for this work; the rest is cosmetic (see §6, step 2). |

**Summary:** the internals (validation, snapshots, grading) are good. The **API surface** is the weak part: it was built
for one screen flow ("import a file, then answer"), not as a set of resources. The fix is mostly a new surface over the same
store, plus a small schema change (keys and versions).

---

## 2. Resources and data model

### 2.1 The three resources

```
Project (key: "m1-day-01")
 └── Exercise (key: "d1-fix-3", unique inside its project)
      └── Attempt (numeric id; append-only; keeps a snapshot of the exercise)
```

That is all. No new entity types.

### 2.2 Decision: how things are identified

**Recommendation: every project and exercise has a human key, and the API addresses them by key. Attempts keep numeric ids.
The numeric `id` stays as the internal primary key and is still returned in responses.**

- Key format (same for both): `^[a-z0-9][a-z0-9-]{0,63}$`. Examples: `m1-day-01`, `d1-fix-3`.
- Project keys are unique. Exercise keys are unique **inside a project** (two projects may both have `card-1`).
- **Keys change only by an explicit rename** (§10). `PUT` and import never change a key: a new key in a file is a new
  exercise.

Why:

- The agent already chooses the keys (they are in the file). With keys in URLs, the agent writes
  `PUT /projects/m1-day-01/exercises/d1-fix-3` directly, with no lookup. This one choice makes create, update and retry simple
  (see idempotency in §4.2).
- Keys are readable in URLs, logs and the browser address bar.
- Numeric ids stay inside the database for foreign keys (cheap joins, stable even if we ever allow renames) and in
  `localStorage` draft names (`web/drafts.ts:6-7`), so nothing there has to change.
- Attempts have no natural name, so a number is right for them.

Cost: two identifiers per project/exercise. We hide this by using **only keys in URLs**. The numeric `id` appears in
responses as plain data; no endpoint accepts it for projects or exercises.

Why no silent key changes: if keys could change by accident, every saved URL, agent script and file would break silently.
The first version made keys immutable; §10 adds a rename action, because "create new + delete old" loses the attempts.

### 2.3 Decision: exercise content versioning

**Recommendation: one integer `version` per exercise, plus `created_at` / `updated_at`. No history table.**

- `version` starts at 1 and goes up by 1 each time the content really changes (type, topic, tags or content).
- Writing the **same** content again does **not** change `version` or `updated_at`. The server compares the stored JSON with
  the new JSON (both written with the same key order). This makes re-imports quiet and idempotent.
- Each attempt records `exercise_version` next to its snapshot.

Why no history table: attempts already keep the full exercise as it was. That **is** the history that matters (what you
saw when you answered). Old versions nobody answered have no value. The daily backup covers mistakes.

Optional guard: `POST …/attempts` may send `exercise_version` (the version the page showed). If the exercise changed since
(the agent fixed it while you were writing), the server answers `409 exercise_changed`, so you never get graded against
a question you did not see. Cheap, and it matters now that edits exist.

### 2.4 Decision: what is immutable

| Thing | Rule |
|---|---|
| Project key, exercise key | Change only by the rename actions (§10.1, §10.2). |
| Attempt: snapshot, answer, `submitted_at`, `exercise_version` | Never change. |
| Attempt: status, result | Change only by grading: `grading → graded`, `grading → failed`, and `failed → grading` (regrade). This is the current rule (`store.ts:175-182`); keep it. |
| Exercise content, project name/description | Editable. |

### 2.5 Decision: what delete does

| Delete | Recommendation | Why |
|---|---|---|
| **Exercise** | Hard delete the row. Its attempts **stay** (`exercise_id` becomes `NULL`; they keep `exercise_key` and the snapshot). | Your progress history is never lost, and there are no "zombie" rows that every query must filter out. |
| **Attempt** | Hard delete. Refused while it is grading (`409 grading_in_progress`). | It is a leaf: nothing points to it. Useful for test attempts. |
| **Project** | Hard delete of the project, its exercises and its attempts, **but** refused with `409 has_attempts` when it has attempts, unless you add `?with_attempts=true`. For "I am done with it", use **archive** instead. | Deleting a duplicate import (no attempts) is one call. Losing weeks of attempts needs a deliberate second step, which protects you from an agent mistake. |
| **Archive** (project only) | `archived: true` hides a project from the default list. Nothing is deleted. | One project per day means ~180 projects in 6 months. You need a way to hide old ones without losing their attempts. |

Why not soft delete (`deleted_at`) for exercises: it forces a `WHERE deleted_at IS NULL` on every query and makes
"re-create the same key" ambiguous. Attempts already hold everything we need to keep.

### 2.6 Order of exercises

`position` stays. A new exercise from a single `PUT` goes to the end. An **import** sets the order of the exercises in the
file to the file's order; exercises that are not in the file keep their relative order after them. To reorder without a file,
`PUT /projects/{p}/order` (§10.4) uses the same rule.

### 2.7 SQL schema (version 2)

```sql
CREATE TABLE projects (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  key              TEXT    NOT NULL UNIQUE
                           CHECK (length(key) BETWEEN 1 AND 64 AND key NOT GLOB '*[^a-z0-9-]*' AND key NOT GLOB '-*'),
  name             TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  description      TEXT    NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  archived_at      TEXT,                       -- NULL: not archived
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL,
  last_activity_at TEXT                        -- last attempt; NULL until the first one
) STRICT;

CREATE TABLE exercises (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  key          TEXT    NOT NULL
                       CHECK (length(key) BETWEEN 1 AND 64 AND key NOT GLOB '*[^a-z0-9-]*' AND key NOT GLOB '-*'),
  position     INTEGER NOT NULL,
  type         TEXT    NOT NULL CHECK (type IN ('rewrite', 'write', 'choice', 'fill', 'flashcard')),
  topic        TEXT,
  tags_json    TEXT    NOT NULL CHECK (json_valid(tags_json)),
  content_json TEXT    NOT NULL CHECK (json_valid(content_json)),
  version      INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL,
  UNIQUE (project_id, key)
) STRICT;
CREATE INDEX exercises_by_position ON exercises (project_id, position);

CREATE TABLE attempts (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id             INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  exercise_id            INTEGER REFERENCES exercises (id) ON DELETE SET NULL,  -- NULL once the exercise is deleted
  exercise_key           TEXT    NOT NULL,                                     -- kept after a delete
  exercise_version       INTEGER NOT NULL,
  submitted_at           TEXT    NOT NULL,
  type                   TEXT    NOT NULL CHECK (type IN ('rewrite', 'write', 'choice', 'fill', 'flashcard')),
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
) STRICT;
CREATE INDEX attempts_by_exercise ON attempts (exercise_id, id);
CREATE INDEX attempts_by_project  ON attempts (project_id, id);
```

Notes:

- `PRAGMA foreign_keys = ON` is already set (`store.ts:142`), so the `ON DELETE` rules work.
- **Tags stay as JSON.** Filtering by tag uses `EXISTS (SELECT 1 FROM json_each(tags_json) WHERE value = $tag)`. A `tags`
  table would be normal form, but at a few thousand rows a scan takes microseconds. Not worth a join table.
- `attempts.project_id` duplicates what `exercise_id` gives, but it must stay: after an exercise is deleted it is the only
  link to the project.
- `effort` becomes a column (it was only inside `result_json`), next to `model`, so `GET /attempts` can filter and show it
  without parsing JSON. `summary` stays as it is (cosmetic; not worth a change).
- **Done** means "this exercise has at least one graded attempt" (any version). Simple and matches today. Cost: fixing a typo
  does not make an exercise "not done" again. That is what you want for typo fixes.

---

## 3. The API

Base path: `/api/practice`. JSON in, JSON out, `snake_case` fields, ISO 8601 UTC times (`2026-10-19T08:30:00.000Z`).

### 3.1 Conventions (the rules every endpoint follows)

1. **URLs name resources by key**: `/projects/{project}/exercises/{exercise}`. Attempts by number: `/attempts/{id}`.
2. **Methods**: `GET` reads, `PUT` creates-or-replaces at a known key (idempotent), `DELETE` removes, `POST` is for actions
   and for things the server names (attempts, import, regrade).
3. **No `PATCH`.** A `PUT` sends the whole object. Exercises and projects are small, and the agent always has the whole
   object. Partial-update rules for nested arrays (`options`, `gaps`) are a common source of bugs; we avoid them completely.
4. **Status codes**: `200` ok, `201` created, `202` accepted (regrade started), `204` deleted (no body), `400` the request is
   wrong, `404` not found, `405` wrong method on a real path, `409` the request is fine but the current state does not allow
   it, `413` body too large, `500` server bug.
5. **One error shape** for every non-2xx answer (§3.3).
6. **Lists** are wrapped: `{ "items": [...] }`, plus `next_before` when there is another page. A bare array can never get a
   new field; a wrapper can.
7. **Strict input**: unknown fields **and unknown query parameters** are `400`, so an agent's typo is never silently ignored.
8. **`?dry_run=true`** on every write that takes a body (`PUT` project, `PUT` exercise, `POST /import`): the server does all
   the checks and reports what would happen, and writes nothing.

### 3.2 Endpoints

`{p}` = project key, `{e}` = exercise key, `{id}` = attempt id.

| # | Method and path | Request | Success | Typical errors |
|---|---|---|---|---|
| 1 | `GET /api/practice` | — | `200` index: API version, links, limits, types (§4.1) | — |
| 2 | `GET /api/practice/schemas/{name}.json` (`exercise`, `import`) | — | `200` JSON Schema | `404 not_found` |
| 3 | `GET /api/practice/grading-options` | — | `200 GradingOptions` (unchanged) | — |
| 4 | `GET /api/practice/projects?archived=false\|true\|all` | default `false` | `200 { items: Project[] }`, newest activity first | `400 invalid` |
| 5 | `PUT /api/practice/projects/{p}` | `{ name, description?, archived? }` | `201 Project` (created) or `200 Project` | `400 invalid` |
| 6 | `GET /api/practice/projects/{p}` | — | `200 Project` | `404 not_found` |
| 7 | `DELETE /api/practice/projects/{p}[?with_attempts=true]` | — | `204` | `404`, `409 has_attempts` |
| 8 | `GET /api/practice/projects/{p}/exercises?type=&tag=` | — | `200 { items: ExerciseItem[] }` in position order | `404`, `400 invalid` |
| 9 | `PUT /api/practice/projects/{p}/exercises/{e}` | `ExerciseInput` | `201 Exercise` or `200 Exercise` | `404` (project), `400 invalid` |
| 10 | `GET /api/practice/projects/{p}/exercises/{e}` | — | `200 Exercise` | `404` |
| 11 | `DELETE /api/practice/projects/{p}/exercises/{e}` | — | `204` | `404` |
| 12 | `POST /api/practice/import` | `ImportFile` (the file itself, as JSON) | `200 ImportResult` | `400 invalid`, `413 too_large` |
| 13 | `GET /api/practice/projects/{p}/export` | — | `200 ImportFile` (with `Content-Disposition: attachment; filename="{p}.json"`) | `404` |
| 14 | `POST /api/practice/projects/{p}/exercises/{e}/attempts` | `{ answer, writing_ms?, model_id?, effort?, exercise_version? }` | `201 Attempt` (`status: "grading"`, or `"graded"` for a flashcard) | `404`, `400 invalid`, `409 exercise_changed` |
| 15 | `GET /api/practice/attempts?project=&exercise=&status=&since=&before=&limit=` | `exercise` needs `project`; `limit` 1–200, default 50 | `200 { items: Attempt[], next_before? }`, newest first | `400 invalid` |
| 16 | `GET /api/practice/attempts/{id}` | — | `200 Attempt` | `404` |
| 17 | `GET /api/practice/attempts/{id}/stream` | — | `200 text/event-stream` (events unchanged: `snapshot`, deltas, `done`/`error`/`finished`) | `404` |
| 18 | `POST /api/practice/attempts/{id}/regrade` | `{ model_id?, effort? }` | `202 Attempt` (`status: "grading"`) | `404`, `409 not_failed`, `400 invalid` |
| 19 | `DELETE /api/practice/attempts/{id}` | — | `204` | `404`, `409 grading_in_progress` |

19 endpoints, each with one job (§10 adds 4 more: rename a project, rename and move an exercise, and the order). A few
notes:

- **#5 and #9 are upserts.** The same `PUT` sent twice gives the same result (the second one is `200`, version unchanged).
  This is what makes the API safe for an agent to retry.
- **#9 needs the project to exist** (`404` otherwise). Only `PUT /projects/{p}` and `POST /import` create projects. This
  catches a typo in the project key instead of creating a stray project.
- **#12 import** is an action on many resources, so it is `POST` with no key in the URL: the file says which project
  (`project.key`). It is still idempotent in effect (upsert by key). Details in §3.5.
- **#14 is nested** because an attempt is "of an exercise"; reads (#15–#19) are flat because an attempt has its own id and
  outlives its exercise. Nested create + flat read is a common, simple pattern.
- **#15 is the agent's main read**: "my graded attempts in `m1-day-01` since this morning", with the full answer and the
  grader's text, to plan tomorrow. Paging is by `before` (an attempt id), not by page number, so new attempts never shift
  pages. `limit` max 200 keeps one answer below ~2 MB even with essays.
- **#17 and #18 keep today's behaviour exactly** (`ai-grading.ts`, `routes.ts:133-144`). Regrade stays "failed only". For a
  second opinion on a graded answer, submit a new attempt; that keeps "attempts are append-only" true.
- **The old "project detail" (`GET projects/:id` with exercises and history) goes away.** The project page calls #6 and #8
  in parallel. The History sidebar is built from #8: each `ExerciseItem` carries its `last_attempt`, so "latest attempt of
  each exercise, newest first" is a client-side sort.

### 3.3 The one error shape

Every non-2xx response with a body (all except `204`) is `application/json` with this shape:

```json
{
  "error": {
    "code": "invalid",
    "message": "The request has 2 problems.",
    "problems": [
      { "path": "/exercises/5/content/options", "code": "no_correct_option",
        "message": "no option is marked correct" },
      { "path": "/exercises/8/content/back", "code": "required",
        "message": "content.back is missing" }
    ]
  }
}
```

- `code`: a stable, machine-readable word. Programs switch on it. Never change a code once it exists.
- `message`: one English sentence for people.
- `problems`: only for `invalid`. One item per problem; **all** problems are listed (the current behaviour, kept).
- `path`: a **JSON Pointer** (RFC 6901) into the request body: `/exercises/5/content/options` means
  `body.exercises[5].content.options` (0-based). For a query parameter it is `?name`, for the key in the URL it is `#key`.

Why JSON Pointer: it is a standard, it is exact (no quoting rules), and any language can follow it to the field. The page
turns it into today's friendly line: `Exercise 6 (choice, d2-pick-1): content.options: no option is marked correct.` (1-based
for people). The agent reads `path` + `code` directly.

Why not RFC 9457 "problem details" (`type`, `title`, `status`, `detail`): the shape above is the same idea with fewer fields.
Its `type` field is a URL nobody will ever open. If you later want the standard, the mapping is one function.

Why `400` for validation and not `422`: one status for "your request is wrong" is easier to remember; `code` says which way
it is wrong.

**Top-level codes:**

| code | status | meaning |
|---|---|---|
| `bad_json` | 400 | body is not valid JSON (message includes line and column) |
| `invalid` | 400 | one or more `problems` |
| `too_large` | 413 | body over the limit |
| `not_found` | 404 | the project, exercise or attempt in the URL does not exist (message names which) |
| `method_not_allowed` | 405 | real path, wrong method (`Allow` header lists the right ones) |
| `has_attempts` | 409 | project delete without `?with_attempts=true` |
| `exercise_changed` | 409 | attempt sent with an old `exercise_version` |
| `not_failed` | 409 | regrade of an attempt that is not `failed` |
| `grading_in_progress` | 409 | delete of an attempt that is grading |
| `internal` | 500 | a bug; details are in the server log, not in the response |

**Problem codes** (inside `problems`): `required`, `unknown_field`, `wrong_type`, `empty`, `too_long`, `too_short`,
`too_many`, `too_few`, `out_of_range`, `not_allowed` (enum), `bad_key` (pattern), `duplicate_key`, `unknown_key` (§10.4), `key_mismatch`,
`no_correct_option`, `fill_markers`, `mistake_not_once`, `unsupported_format`, `unknown_parameter`. Each maps to one branch of
the existing checker (`import-check.ts:68-127`), so this is a refactor of the messages, not new logic.

### 3.4 Shapes

```ts
// The one exercise format: in a file, in PUT, in export. Humans and agents write exactly this.
interface ExerciseInput {
  key: string;            // in PUT: optional, but if present it must equal the URL key (else key_mismatch)
  type: ExerciseType;     // 'rewrite' | 'write' | 'choice' | 'fill' | 'flashcard'
  topic?: string;
  tags?: string[];
  content: ContentByType[ExerciseType];   // unchanged from today (api.ts:9-83)
}

interface Exercise extends Required<ExerciseInput> {
  id: number;             // internal; for drafts in localStorage
  project: string;        // project key
  position: number;
  version: number;
  created_at: string;
  updated_at: string;
  done: boolean;
  attempt_count: number;
}

// A list row: what a person or agent needs to pick an exercise. No content (use GET one, or export).
interface ExerciseItem {
  id: number; key: string; type: ExerciseType;
  kind: string; preview: string;          // "Rewrite sentence", first words (text.ts)
  topic: string | null; tags: string[];
  version: number; updated_at: string;
  done: boolean;
  last_attempt: { id: number; status: AttemptStatus; summary: string | null; submitted_at: string } | null;
}

interface Project {
  id: number; key: string; name: string; description: string; archived: boolean;
  created_at: string; updated_at: string; last_activity_at: string | null;
  exercise_count: number; done_count: number; type_counts: Partial<Record<ExerciseType, number>>;
}

interface Attempt {            // today's AttemptView (api.ts:144-159) plus keys and version
  id: number;
  project: string;             // project key
  exercise: string;            // exercise key (still there after the exercise is deleted)
  exercise_version: number;
  exercise_deleted: boolean;
  submitted_at: string; status: AttemptStatus; summary: string | null; error: string | null;
  writing_ms: number | null;
  snapshot: ExerciseBody;      // renamed from `exercise`, which is now the key
  answer: AnswerByType[ExerciseType];
  result: ResultByType[ExerciseType] | null;
}

interface ImportFile {
  format: 3;
  project: { key: string; name: string; description?: string };
  exercises: ExerciseInput[];  // 1 to 500
}

interface ImportResult {
  dry_run: boolean;
  project: Project;
  project_change: 'created' | 'updated' | 'unchanged';
  exercises: { created: string[]; updated: string[]; unchanged: string[] };   // keys
}
```

### 3.5 Import, exactly

`POST /api/practice/import` with the file as the body:

1. Check the whole file (same checker as `PUT` exercise, run on each item, plus file-level rules: `format`, unique keys in the
   file, 1–500 exercises). Any problem → `400 invalid` with every problem; nothing is written.
2. In **one transaction**:
   - Project `project.key` missing → create it. Present → update `name`/`description` if they differ.
   - Each exercise: key missing → create (version 1). Present and different → replace, `version + 1`. Present and the same →
     nothing.
   - Set positions to the file order; exercises not in the file keep their order after them.
3. Answer `200 ImportResult`. With `?dry_run=true`, steps 1–2 run and the transaction is **rolled back**, so a dry run
   answers exactly what the real run would do, using the same code.

Import **never deletes** exercises that are missing from the file. To remove one, `DELETE` it. Reason: "the file is the full
truth" (a sync/prune mode) is powerful but dangerous: one truncated file from an agent would delete exercises and detach
their attempts. Deleting must be explicit.

Import into an archived project works and does not unarchive it.

### 3.6 Import file format 3

Format 3 = format 2 with two changes:

| Change | Why |
|---|---|
| `project.key` is **required** | The file says where it goes, so re-importing a fixed file updates the same project (fixes P2). |
| Each exercise's `id` is renamed **`key`** | Responses now also have a numeric `id`. Two different things named `id` would confuse people and agents. |

Everything else (types, `content` fields, limits, rules) is unchanged. `"format": 2` files are refused with
`unsupported_format` and a message that says exactly the two edits to make. One format in the server is simpler than two; you
have only a few format-2 files, and the generator prompt is one edit.

---

## 4. Agent-friendliness

### 4.1 Discovery

`GET /api/practice` returns a small index, so an agent with no docs can find everything in one call:

```json
{
  "api": "practice",
  "version": 3,
  "docs": "/features/practice/static/import-format.md",
  "schemas": { "exercise": "/api/practice/schemas/exercise.json", "import": "/api/practice/schemas/import.json" },
  "types": ["rewrite", "write", "choice", "fill", "flashcard"],
  "limits": {
    "import_body_bytes": 2000000, "exercises_per_import": 500, "exercise_body_bytes": 200000,
    "attempt_body_bytes": 262144, "key_pattern": "^[a-z0-9][a-z0-9-]{0,63}$", "attempts_page_max": 200
  },
  "endpoints": [
    { "method": "GET", "path": "/api/practice", "query": [], "about": "This index: version, limits, types and every endpoint." },
    { "method": "GET", "path": "/api/practice/projects", "query": ["archived"], "about": "List projects, newest activity first." }
  ]
}
```

(`endpoints` was added later, §10.5; the example shows two of the 23.)

### 4.2 JSON Schema per exercise type

**Recommendation: generate JSON Schema (draft 2020-12) from the existing spec in `import-check.ts:26-58`, and serve it.**
Do not hand-write the schema, and do not replace the checker with a schema library.

- `exercise.json`: one schema with `oneOf` on `type`; each type is a `$defs` entry (`rewrite`, `write`, …), so an agent can
  read only the part it needs. `import.json` refers to it.
- Every field gets `maxLength`, `minItems`/`maxItems`, `enum`, `pattern`, `additionalProperties: false`, and a `description`
  taken from the doc (for example flashcard `explanation`: "Markdown, up to 5,000 characters: the concept and a worked
  explanation, rendered under the answer").
- The three rules JSON Schema cannot express (a `choice` needs a correct option; `fill` markers match gaps; each
  `mistakes[].wrong` appears once in `text`) go in the `description` of that type. The server still checks them.

Why generate: the spec is already a small data structure (`text`, `oneOf`, `list`, `object`…). A ~60-line function turns it
into JSON Schema. One source of truth: the schema can never disagree with the checker.

Why not use a validator library (ajv): it is a dependency in a no-build, no-framework app, it cannot express the three
relation rules anyway, and its error messages are worse than ours.

Example (flashcard part, generated):

```json
{
  "type": "object", "additionalProperties": false,
  "required": ["key", "type", "content"],
  "properties": {
    "key":   { "type": "string", "pattern": "^[a-z0-9][a-z0-9-]{0,63}$" },
    "type":  { "const": "flashcard" },
    "topic": { "type": "string", "minLength": 1, "maxLength": 100 },
    "tags":  { "type": "array", "maxItems": 10, "items": { "type": "string", "minLength": 1, "maxLength": 40 } },
    "content": {
      "type": "object", "additionalProperties": false, "required": ["front", "back"],
      "properties": {
        "front":       { "type": "string", "minLength": 1, "maxLength": 300 },
        "back":        { "type": "string", "minLength": 1, "maxLength": 2000 },
        "hint":        { "type": "string", "minLength": 1, "maxLength": 300 },
        "example":     { "type": "string", "minLength": 1, "maxLength": 1000 },
        "explanation": { "type": "string", "minLength": 1, "maxLength": 5000,
                         "description": "Markdown: the concept and a worked explanation, shown under the answer." }
      }
    }
  }
}
```

(`minLength: 1` approximates "non-empty"; the checker also refuses whitespace-only text.)

### 4.3 Idempotency

- `PUT` project, `PUT` exercise and `POST /import` are **idempotent by key**: sending the same thing twice changes nothing
  the second time. An agent can always retry them.
- `POST …/attempts` is **not** idempotent (a retry makes a second attempt and a second grading). Only the page submits
  answers, and it disables **Submit** while sending. Not worth an `Idempotency-Key` mechanism (see §8).
- `DELETE` is idempotent in effect; a second call returns `404`, which a retry can treat as success.

### 4.4 Limits (one table, also in `GET /api/practice`)

| Limit | Value | Today |
|---|---|---|
| Import body | 2 MB | 2 MB file, sent as an escaped string (body up to 8 MB) |
| Exercises per import | 500 | 500 |
| `PUT` exercise body | 200 KB | — |
| Attempt / regrade body | 256 KB | 256 KB (`routes.ts:36`) |
| Field lengths | as in `import-check.ts:26-58` (in the schema) | same |
| `GET /attempts` page | 50 default, 200 max | — |

### 4.5 curl for an agent

All examples assume the server at `http://localhost:8787` (allowed by the Host check).

```bash
# What is there, and the rules
curl -s localhost:8787/api/practice
curl -s localhost:8787/api/practice/schemas/exercise.json

# Check a file without writing anything
curl -s -X POST 'localhost:8787/api/practice/import?dry_run=true' \
  -H 'Content-Type: application/json' --data-binary @day-02.json

# Import it (safe to run again after fixing the file: same keys update in place)
curl -s -X POST localhost:8787/api/practice/import \
  -H 'Content-Type: application/json' --data-binary @day-02.json

# Fix one exercise
curl -s -X PUT localhost:8787/api/practice/projects/m1-day-01/exercises/d1-fix-3 \
  -H 'Content-Type: application/json' \
  -d '{"type":"rewrite","topic":"sentence structure","tags":["rule-b"],
       "content":{"instruction":"Fix the comma splice.","text":"I like it, it is cheap.","length":"sentence","prefill":true}}'

# Delete one exercise (its attempts stay)
curl -s -X DELETE localhost:8787/api/practice/projects/m1-day-01/exercises/d1-fix-9

# Get a project back as a file, edit it, re-import it
curl -s localhost:8787/api/practice/projects/m1-day-01/export > day-01.json

# Read today's graded results to plan tomorrow
curl -s 'localhost:8787/api/practice/attempts?project=m1-day-01&status=graded&since=2026-10-19'
```

### 4.6 CLI or MCP wrapper?

**Recommendation: build neither now. Write a short "agent guide" instead** — a Claude Code skill (or a section in the
`ielts` repo's `CLAUDE.md`) with the curl recipes above and the rule "always dry-run first, then import".

Why:

- The agent you use is Claude Code, which has a shell. curl + the JSON Schema + clear errors is all it needs. Every endpoint
  above is one curl line.
- An MCP server is a second program to run, configure and keep in sync with the API (tool schemas, error mapping). For one
  user that is pure cost.
- A CLI mostly re-wraps curl. Its only real gain would be nicer output for you, and `jq` already gives that.

When to change this: if you start managing exercises from an app **without a shell** (Claude Desktop chat, claude.ai), then
a small MCP server with ~5 tools (`import`, `put_exercise`, `delete_exercise`, `export`, `list_attempts`) becomes worth it,
because it is the only way in. Because the API is already clean, that server would be ~150 lines of pass-through.

---

## 5. Exercise types

No change to the five types or their `content` fields (`api.ts:9-83`, `import-check.ts:26-49`):

| Type | Content (required `*`) | Graded by |
|---|---|---|
| `rewrite` | `instruction*`, `text*`, `length*`, `source_lang`, `prefill`, `constraints`, `mistakes`, `reference` | AI |
| `write` | `prompt*`, `min_words`, `minutes`, `sample` | AI |
| `choice` | `question*`, `context`, `options*` (2–6 of `{ text*, why*, correct }`) | AI |
| `fill` | `text*` with `{{n}}` markers, `gaps*`, `instruction` | AI |
| `flashcard` | `front*`, `back*`, `hint`, `example`, `explanation` (Markdown, up to 5,000 characters, from commit e67f03b) | you |

Answers (`AnswerByType`) and results (`ResultByType`) are unchanged. Adding a type later stays what it is today: one
template module, one entry in the spec (the schema follows automatically), one line in `answers.ts`.

**Changing an exercise's type with `PUT` is allowed.** Old attempts keep their own snapshot and type. A draft in
`localStorage` for the old type is already ignored (`web/drafts.ts:35-38` checks the type and shape).

---

## 6. Migration plan

Small steps. After each step all tests pass and the app works. Steps 1–3 add things; step 5 removes the old things.

**Step 0 — Backup.** The daily backup exists; the migration code also copies the file to
`data/backups/practice-v2-before-schema-2.sqlite` before it changes anything.

**Step 1 — One error shape (no URL changes).**
- Add `sendError(res, status, code, message, problems?)` in `src/shared/server/http.ts`.
- `import-check.ts` returns `{ path, code, message }[]` instead of strings; add `problemLine(problem, exercises)` that builds
  today's friendly line for the page.
- Replace `reject()` and `{ errors }` in `routes.ts`; return `405` for a known path with the wrong method; make the server's
  own 404/500 use the shape for `/api/` paths.
- Client: `ApiError` reads `error.code` / `problems`; delete the JSON-guessing in `client.ts:26-34`.

**Step 2 — Schema version 2** (`SCHEMA_VERSION = 2`, one migration in `store.ts`).
- `projects`: add `key`, `archived_at`, `updated_at`. Keys for the existing rows are made from the name (`test`,
  `day-1-19-10-2026`, `day-1-19-10-2026-v2`, with `-{id}` on a clash) — see open question Q1 for better ones.
- `exercises`: add `version = 1`, `created_at = updated_at =` the project's `created_at`.
- `attempts`: SQLite cannot change a foreign key, so rebuild the table (create `attempts_new`, copy with `exercise_key` from
  `exercises.key`, `exercise_version = 1`, `effort` from `result_json`, drop, rename, re-create indexes). 8 rows today.
- Rebuild `exercises` the same way to add `ON DELETE CASCADE`, and `projects` for the `key` constraints.
- The old routes keep working on the new tables (they ignore the new columns).

**Step 3 — New endpoints next to the old ones.** Add all of §3.2 (keys in URLs, `PUT`/`DELETE`, import format 3, export,
attempts list, schemas, index, `dry_run`). The old 10 routes still answer. Tests for every new endpoint, including:
re-import is `unchanged`; changed content bumps `version`; deleting an exercise keeps its attempts readable; dry run writes
nothing.

**Step 4 — Move the page to the new API.**
- Import view sends the parsed file object to `POST /import` (dry run as you type is still the local checker; the server
  answers the same).
- Project page: `GET /projects/{p}` + `GET /projects/{p}/exercises`; the History sidebar sorts `last_attempt`.
- Hash routes use keys: `#/p/m1-day-01`, `#/p/m1-day-01/x/d1-fix-3` (attempts stay `#/a/123`). Drafts keep their numeric
  key in `localStorage`, so no draft is lost.
- Add the small UI pieces: **Archive** and **Delete** on a project, **Delete** on an exercise, **Export**. (Editing an
  exercise in the page: see Q3.)

**Step 5 — Delete the old surface.**
- Routes: `POST projects`, `GET projects/:id` (the combined one), `POST projects/:id/exercises`, `GET exercises/:id`,
  `POST attempts` (flat). Store: `readProject`'s combined detail, `addExercises` and its `duplicate_keys` result.
- Types: `ImportRequest`, `ProjectDetail`, `HistoryItem`, `FileExercise`/`ProjectFile` (replaced by `ImportFile`).
- Code: `checkedFile`, `MAX_IMPORT_BODY_BYTES`, `problemsOf`, the `file`-as-string handling, format 2 in the checker.
- Update docs: `practice-proposal.md` §5 points here; `practice-import-format.md` becomes format 3;
  `examples/example-project.json` becomes format 3.
- Outside this repo: update the `ielts` generator prompt (`project.key`, `key` instead of `id`) and edit
  `month-1-writing/day-01.json` to format 3.

**Step 6 — Agent guide** (§4.6), in the `ielts` repo.

Each step is one commit. Steps 1 and 2 are independent; 3 needs 1 and 2; 4 needs 3; 5 needs 4.

---

## 7. Open questions (with my recommendation)

**Q1. Keys and clean-up for your three existing projects?**
Today: `1 Test` (30 exercises, 4 attempts), `2 Day 1 - 19/10/2026` (23, 4 attempts), `3 Day 1 - 19/10/2026 - v2` (23, no
attempts).
*Recommendation:* the migration gives project 2 the key **`m1-day-01`**, then you delete project 3 (no attempts: one call)
and delete or archive `Test`. Then put `"key": "m1-day-01"` in `day-01.json` (v3) and import it: the 23 exercises update in
place and your 4 attempts stay linked. Use `m{month}-day-{nn}` for all future files.

**Q2. One project per day, or one per month?**
*Recommendation:* keep one per day (`m1-day-01`). It matches your files, keeps imports small, and archive handles the
growing list. Tags (`day-1`, `rule-a`) already let you cut across days.

**Q3. Edit an exercise in the page?**
Options: a form per type (much UI work), or a JSON text box using the same checker (small), or no page editor (fix with the
agent or curl).
*Recommendation:* start with **no page editor**. Your workflow is "Claude fixes the file, re-import". If you find yourself
fixing typos by hand often, add a JSON box (`GET` exercise → edit → `PUT`, problems shown inline) — about one day of work.

**Q4. Should `done` reset when an exercise's content changes?**
*Recommendation:* no. Most edits are typo fixes. If a change is big enough to need a new try, give it a new key.

**Q5. Cross-project search (`GET /exercises?tag=rule-a` across all projects)?**
*Recommendation:* not now. Per-project lists plus export cover today's needs. Add it later in one endpoint if the agent
needs "all my `rule-b` exercises this month".

**Q6. Should the agent be allowed to delete projects that have attempts?**
*Recommendation:* the API allows it only with `?with_attempts=true`; in the agent guide, tell the agent never to use that
flag without asking you.

---

## 8. What I would NOT build (and why)

| Not building | Why |
|---|---|
| Auth, users, roles, rate limits | One user on loopback with a Host allow-list. |
| `PATCH` / JSON Merge Patch | Objects are small; `PUT` whole objects is simpler and has no nested-array merge rules. |
| `ETag` / `If-Match` for exercises | One person, rare edits. `version` is shown; `exercise_changed` covers the one race that matters (answering while it is edited). |
| An exercise history / revisions table | Attempt snapshots already keep every version you actually answered. |
| `Idempotency-Key` for attempts | Only the page submits answers, and it disables Submit while sending. |
| Import "sync" mode that deletes missing exercises | One bad file could wipe exercises. Deletes are explicit. |
| A `tags` table, full-text search | A few thousand rows; `json_each` and client-side filters are instant. |
| Page-number pagination for every list | Only attempts can grow large; `before` + `limit` there is enough. |
| `/v1/` in URLs | You control every client. The file has its own `format` number; the index reports the API `version`. |
| OpenAPI document | The table in §3.2 + JSON Schemas + the index cover agents and humans. An OpenAPI file is a second description to keep in sync. |
| MCP server or CLI | §4.6: curl is enough for Claude Code. Revisit if you need a shell-less client. |
| A validator library (ajv) | Generate the schema from our spec; keep our checker and its messages. |
| Soft delete | Attempts keep their snapshots; soft delete adds a filter to every query. |
| Renaming the database file | `practice-v2.sqlite` is only a name; the schema version is inside the file. |

---

## 9. Notes from building it

Small differences from the text above, each the simplest fix that keeps its intent:

- **Step 3 changed three shared paths at once.** `GET /attempts/{id}`, `POST /attempts/{id}/regrade` and `GET /projects` had the
  same paths in the old and new APIs, so they answered in the new shapes (`Attempt` with `snapshot`; `{ items }`) from step 3,
  and the page read those shapes from then on.
- **An unknown `?project` in `GET /attempts` is a `404`**, like a key in a URL, not an empty list, so a typo is not silent.
- **A dry-run `PUT` answers with the status a real one would** (`201` or `200`), with the object as it would be.
- **`PUT /projects/{p}` accepts `"description": ""`**, because `GET` gives `""` for no description and a `GET` -> `PUT` round
  trip must work. Everywhere else a text must be non-empty.
- **The key rule is checked in the URL only for `PUT`** (`400` with path `#key`); a `GET` or `DELETE` with a key that cannot
  exist is simply a `404`.
- **`FileExercise` and `ProjectFile` stay** as the checker's output (texts trimmed, `topic` and `tags` filled in); `ImportFile`
  is the file as written. Only the old request and response types were deleted.
- **JSON errors give line and column** by walking the refused text with the JSON grammar, because V8 names a position only for
  some mistakes.

---

## 10. Rename, move and order

The first version could not rename a key, move an exercise or reorder exercises without losing attempts or re-importing.
This section closes those gaps with the same rules as §3.1: one error shape, `?dry_run=true` on every write, strict input,
and one new error code:

| code | status | meaning |
|---|---|---|
| `key_taken` | 409 | a rename or a move would give a key that is already used |

All of them are actions on one resource, so they are `POST` (rule 2 in §3.1), except the order, which is replaced whole
with `PUT`. A dry run answers exactly what the real call would, as everywhere else.

### 10.1 Rename a project

`POST /api/practice/projects/{p}/rename` with `{ "key": "m1-day-01" }` → `200 Project` (with the new key).

- Errors: `404` (no such project), `409 key_taken`, `400 invalid` (`/key` is `required`, `wrong_type` or `bad_key`; any
  other field is `unknown_field`).
- The same key again is `200` and changes nothing.
- Attempts and exercises point at the project's numeric `id`; the key is only shown. So nothing else changes and every
  attempt stays linked: `GET /attempts?project={new}` lists them all.
- Old URLs with the old key (and the page's `#/p/{old}` bookmarks) answer `404`. Files with the old `project.key` would
  import as a new project, so change the key in the file too.
- Why not `PUT /projects/{p}` with a new `"key"` in the body: `PUT` means "this object, at this URL". A key in the body
  that differs from the URL would mean "move it", which is surprising, and a typo in it would rename by accident.

Design Q1 is now two calls:

```bash
curl -s -X POST localhost:8787/api/practice/projects/day-1-19-10-2026/rename -H 'Content-Type: application/json' -d '{"key":"m1-day-01"}'
curl -s -X DELETE localhost:8787/api/practice/projects/day-1-19-10-2026-v2
```

### 10.2 Rename an exercise

`POST /api/practice/projects/{p}/exercises/{e}/rename` with `{ "key": "d1-fix-3" }` → `200 Exercise` (with the new key).

- Errors: `404` (no such project or exercise), `409 key_taken` (the key is used in the same project), `400 invalid` (as in
  §10.1).
- Content, `version`, `updated_at` and `position` do not change: the exercise is the same, only its name is new.
- **Its attempts get the new key too** (`attempts.exercise_key`). They are already linked by `exercise_id`, so this is not
  needed for the link; it is needed so that `GET /attempts?project={p}&exercise={new}` finds them and every attempt shows
  the key the exercise has now. The snapshot has no key, so it does not change.
- Attempts of an exercise that was **deleted** earlier and had the same old key are not touched (`exercise_id` is `NULL`):
  they belong to that other exercise.

### 10.3 Move an exercise to another project

`POST /api/practice/projects/{p}/exercises/{e}/move` with `{ "project": "m1-day-02" }` → `200 Exercise` (in its new
project).

- Errors: `404` (no such exercise, or no project to move to; the message says which), `409 key_taken` (the other project
  already has an exercise with this key: rename one of them first, §10.2), `400 invalid`.
- The exercise keeps its key, content, `version` and numeric `id` (so a draft in `localStorage` is kept). It goes to the
  **end** of the other project, like a new exercise from `PUT`.
- **Its attempts move with it** (`attempts.project_id`), so it stays done, and `GET /attempts?project={new}` lists them.
  Both projects' `last_activity_at` is set again from their attempts.
- Moving to the project it is already in is `200` and changes nothing.
- Why no `"key"` in the same call (move and rename at once): two small actions are easier to read and to check with a dry
  run. On a clash, rename first, then move.

### 10.4 Order of exercises

`PUT /api/practice/projects/{p}/order` with `{ "keys": ["d1-fix-3", "d1-card-1"] }` → `200 { items: ExerciseItem[] }` (the
whole list in its new order, as `GET …/exercises` gives it).

- The listed keys come first, in this order; the project's **other exercises keep their order after them**. Positions
  become 1, 2, 3… To set the whole order, list every key; to move one exercise to the top, list only it.
- Errors: `404` (no such project), `400 invalid` with every problem: `/keys` `required` or `wrong_type`; `/keys/{i}`
  `unknown_key` (not an exercise of this project), `duplicate_key`, `wrong_type`.
- Idempotent: the same `PUT` again gives the same order. Nothing else changes (`version`, `updated_at`).
- Why the whole order and not "set the position of one exercise": one call says the full intent, a retry is safe, and it is
  exactly the import rule (§2.6), so both use one function in the store. Moving one exercise is still one call.
- Why `PUT` on `/order`: the order is a small sub-resource that is replaced whole. `GET` on it is not needed (the exercise
  list is already in order), so `GET` is a `405`.

**Import keeps following the file's order**, also for exercises that already exist (as built, §2.6 and §3.5). The file is
the full intent of the agent that wrote it; if a re-import kept the old order, a fixed file could never change the order.
Exercises that are not in the file keep their order after the file's ones.

### 10.5 Every endpoint in the index

`GET /api/practice` now has `endpoints`: one item per endpoint, `{ method, path, query, about }`, for example
`{ "method": "POST", "path": "/api/practice/projects/{p}/rename", "query": ["dry_run"], "about": "Give a project a new key: { key }. Attempts stay linked." }`.
`{p}` is a project key, `{e}` an exercise key, `{id}` an attempt's number; `query` lists the parameters the endpoint takes
(any other is a `400`).

The list is made from the server's own route table: each route is written with this readable path and its line, and the
URL pattern is made from the path. So the list cannot miss an endpoint or show a wrong path. 28 endpoints today (with the
five generation endpoints of §11).

### 10.6 The new endpoints, together

| Method and path | Body | Success | Typical errors |
|---|---|---|---|
| `POST /api/practice/projects/{p}/rename` | `{ key }` | `200 Project` | `404`, `409 key_taken`, `400 invalid` |
| `POST /api/practice/projects/{p}/exercises/{e}/rename` | `{ key }` | `200 Exercise` | `404`, `409 key_taken`, `400 invalid` |
| `POST /api/practice/projects/{p}/exercises/{e}/move` | `{ project }` | `200 Exercise` | `404`, `409 key_taken`, `400 invalid` |
| `PUT /api/practice/projects/{p}/order` | `{ keys }` | `200 { items: ExerciseItem[] }` | `404`, `400 invalid` |

All four take `?dry_run=true`.

### 10.7 Not built

| Not building | Why |
|---|---|
| Rename by `PUT` with a new key in the body | Surprising, and a typo would rename by accident (§10.1). |
| Move and rename in one call | Two small calls are clearer; a clash says "rename first" (§10.3). |
| Set one exercise's `position` | `PUT /order` with one key does the same, with one rule for import and API (§10.4). |
| Redirects from an old key to the new one | Needs a table of old keys forever. Keys change rarely, by you, on purpose. |
| Moving many exercises in one call | Not needed yet; one call per exercise is fine at this size. |
| The page UI for rename, move and order | The task is the API; the page can call these endpoints later. |

## 11. Generations: a project from a translation

Built from [practice-from-translation-design.md](practice-from-translation-design.md) (schema 4). A generation is a
model run that writes a project of flashcards and multiple-choice questions from a finished en→vi translation. It runs
in the background like a grading; the post is kept in the row, so Try again needs only the id.

| Method and path | Body | Success | Typical errors |
|---|---|---|---|
| `POST /api/practice/generations` | `GenerationRequest { translationId, title, sourceLanguage: "en", blocks: [{ sourceText, translatedText }] }` | `202 { generation }` | `400 invalid` (not `en`, no blocks, under 150 English words), `409 generating` (with `generationId`), `409 already_made` (with `projectKey`), `413 too_large` |
| `GET /api/practice/generations?translation={id}` | — | `200 { items: GenerationDetail[] }`, newest first | `400 invalid` |
| `GET /api/practice/generations/{id}` | — | `200 GenerationDetail` (no post, no reply) | `404` |
| `POST /api/practice/generations/{id}/retry` | none | `202 { generation }` | `404`, `409 generating` |
| `GET /api/practice/generations/{id}/stream` | — | `200 text/event-stream`: `snapshot`, `progress { exerciseCount }`, `retry`, `fallback`, `done { projectKey }`, `error { message }`, `finished` | `404` |

The body limit is 1 MB (`limits.generationBodyBytes`). A made project gets the key `t-{translationId}-{slug of its name}`,
or that key with `-2`, `-3`... when it is taken: a generation never overwrites a project. Deleting the project sets the
generation's `projectKey` to null, and the translation can then make a project again.

