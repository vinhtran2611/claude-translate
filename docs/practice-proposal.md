# Practice: design

Practice is a page of the app (`/practice`) for IELTS Writing, grammar and vocabulary practice. You make exercises with Claude as
JSON files (format: [practice-import-format.md](practice-import-format.md)), import each file as a **project**, do the exercises,
and read an evaluation of every answer. It lives in `features/practice/`; common code is in `shared/`.

## 1. Screens

Hash routes, all on `/practice`. `<project>` and `<exercise>` are keys (`m1-day-01`, `d1-fix-3`); `<attempt>` is a number:

| Route | Screen |
|---|---|
| `#/` | Projects: cards with name, "N exercises · M done", type mix and last activity; search; sort; **Show archived**; **New project** |
| `#/new` | Import a file: a `.json` file (choose, drop or paste) that names its project; shows "N exercises for …" or the numbered problems; nothing is imported on a problem; a project that exists is updated in place |
| `#/p/<project>` | Next exercise: the first one not done yet, and the list of those not done; **Export**, **Archive** and **Delete** for the project |
| `#/p/<project>/x/<exercise>` | Do an exercise; **Delete exercise** (its attempts stay) |
| `#/a/<attempt>` | An old attempt, read-only: the problem and your answer as they were, and the evaluation |

The sidebar on the left is Claude Translate's (collapse icon, `⌘K` search, a "new" row, date groups, soft hover and selected rows; a
drawer below 1280px). Inside a project it is the History: **New exercise** (the next one not done), then unsent drafts under *Drafts* and
the latest attempt of each exercise as a two-line preview and one line `type · result`. Outside a project it lists the projects. The row
under the masthead has chips for the project and its progress.

An exercise is **Problem** and **Your answer** side by side (one panel for a flashcard or a fill), and under them the full-width
**Evaluation**: a quiet placeholder before you submit; while the AI works the "Thinking…" disclosure and the words as they stream, drawn
progressively; when done the same text with a collapsed "Thought for 12s", and the model, effort and time in the header; an error and
**Grade again** if it failed. The model and effort control (Translate's) is in the answer's header next to **Submit**. A finished attempt
offers **Try again** (a new attempt) and **Next exercise**. Submitting replaces the URL by `#/a/<attempt>`, so a reload during grading
shows the attempt and joins its stream.

## 2. Types and templates

`features/practice/web/templates/` has one module per type (`rewrite`, `write`, `choice`, `fill`, `flashcard`) with the same few
functions (`empty`, `isBlank`, `isReady`, `problem`, `answer`, `status`, and `evaluation` for a flashcard). The shell
(`exercise.ts`) owns the layout and the phases: answering, grading, graded, failed. A new type is a module there, a place in
`import-check.ts`, and a line in `answers.ts`.

## 3. Grading

Every type but a flashcard is graded by `claude -p` through the shared runner (`shared/server/claude-runner.ts`) with one common
prompt (`prompts/grade.md`), the exercise and the answer. The reply is Markdown, stored as it came with the grader's thinking summary
(`{ text, thinking_text, thinking_ms, model, effort, ms }`) and drawn by Translate's renderer (`shared/web/markdown.ts`, text nodes only).
The model and effort are the person's choice, from the same options as Translate. The answer is saved before grading starts. The server
runs the grading and keeps what it has produced so far in memory; `GET attempts/:id/stream` (Server-Sent Events, Translate's wire format)
sends that first as a `snapshot` and then the rest, so a page can leave and come back, and grading continues if nobody is watching; a server restart turns interrupted gradings
into failed ones (**Grade again** redoes them). Nothing about the reply is parsed, so a history line says only `Graded`.

A flashcard is rated by you (Didn't know, Almost, Knew it); the back is shown in the Evaluation area.

## 4. Data

`data/practice.sqlite` (`PRACTICE_DATABASE_PATH` overrides it), strict tables, schema version 3: the model of
[data-model-proposal.md](data-model-proposal.md). See [practice-import-format.md](practice-import-format.md). Daily backups:
`data/backups/practice-*.sqlite`. On the first start `data/practice-v2.sqlite` is renamed to `data/practice.sqlite` after a
backup; a much older `data/practice.sqlite` found there (never read since practice-v2) is moved to
`data/backups/practice-set-aside.sqlite` first.

## 5. HTTP API (`/api/practice`)

The API and its data model are in [practice-api-design.md](practice-api-design.md): projects and exercises addressed by key
(`/projects/{project}/exercises/{exercise}`), `PUT` to create or replace, `DELETE`, `POST /import` with the file itself as the
body, export, a list of attempts, one error shape (`{ error: { code, message, problems? } }`) and `?dry_run=true` on every write
with a body. `GET /api/practice` lists the version, the limits and the JSON Schemas. The shapes are in `features/practice/api.ts`.

## 6. Code

| Where | What |
|---|---|
| `api.ts`, `text.ts`, `import-check.ts` | shared by server and page: types, kind and preview of an exercise, the file check |
| `server/` | `routes.ts`, `store.ts` (the only code that touches the database), `answers.ts` (answer check, flashcard), `ai-grading.ts` |
| `web/` | `practice.ts` (router: one abort signal per navigation, so a late answer never draws over a newer page), `side.ts`, `exercise.ts`, project and import views, `drafts.ts`, `templates/` |
| `prompts/grade.md` | the grading prompt |
| `examples/example-project.json` | a valid file with every type |

`shared/web/base.css` holds Translate's tokens, masthead, sidebar, buttons, cards and Markdown styles; translate still has its own
inline copy (identical values) and may adopt it later. `shared/web/markdown.ts` and `model-picker.ts` are shared the same way. A feature imports only from itself and `shared/` (`test/boundaries.test.ts`).

## 7. Not in this version

An **Error log** (it needs structured errors, and the evaluation is free text), exercise generation inside the app, editing an
exercise in the page (the API's `PUT` and a re-import do it), speaking, reading and listening.
