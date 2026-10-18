# Practice import format (version 2)

One file is one project: a named group of exercises (a week, a topic). The format is strict: an unknown field is a problem,
and one problem means nothing is imported. A ready example with every type: `features/practice/examples/example-project.json`
(also **Download an example file** on the New project page).

```json
{ "format": 2,
  "project": { "name": "IELTS Writing Task 2 – Week 2", "description": "optional" },
  "exercises": [ { "id": "w2-01", "type": "rewrite", "topic": "transport", "tags": ["passive"], "content": { } } ] }
```

| Field | Required | Notes |
|---|---|---|
| `format` | yes | must be `2` |
| `project.name` | yes | 1 to 80 characters. `description`: optional, up to 500 |
| `exercises` | yes | 1 to 500 items |
| `id` | yes | `a-z 0-9 -`, at most 64, unique in the file. It names the exercise inside its project |
| `type` | yes | `rewrite` `write` `choice` `fill` `flashcard` |
| `topic`, `tags` | no | `topic`: short text. `tags`: up to 10 short texts, shown as chips |
| `content` | yes | an object for the type (below) |

Every text must be non-empty. Texts are limited (an instruction 1,000 characters, a text to rewrite or a sample 20,000); the
limit is named in the problem line when you pass it. The file is at most 2 MB.

## The five types (`*` = required)

| Type | Covers | Graded by |
|---|---|---|
| `rewrite` | translate Vietnamese to English, rewrite a sentence, paragraph or essay, error correction | the AI |
| `write` | free writing: an IELTS Task 2 essay | the AI, with estimated bands |
| `choice` | multiple choice, one answer or several | the AI, with the right answers and reasons from the file |
| `fill` | fill in the blanks, short-answer quiz | the AI, with the accepted answers from the file |
| `flashcard` | vocabulary, facts | you: Didn't know, Almost or Knew it |

**rewrite**: `instruction*`, `text*`, `length*` (`sentence`, `paragraph` or `essay`), `source_lang` (`en` or `vi`; `vi` makes it a
translation), `prefill` (the answer box starts with `text`; default false), `constraints` (up to 3 short rules the grader
checks), `mistakes` (`[{ wrong*, right*, note }]`: planted mistakes, error correction; each `wrong` appears once in `text`),
`reference` (a model answer for the grader only).

**write**: `prompt*`, `min_words` (default 250), `minutes` (a guide, never a limit), `sample` (a model essay; the grader is
told not to let it set the band).

**choice**: `question*`, `context`, `options*` (2 to 6 of `{ text*, why*, correct }`). One `correct: true` is single choice;
two or more is multi-select.

**fill**: `text*` with markers `{{1}} {{2}}` and so on, `gaps*` (`[{ answer*, hint, why }]`, one per marker, in order; `answer`
is a text or a list of accepted answers), `instruction`.

**flashcard**: `front*`, `back*`, `hint`, `example`.

```json
{ "id": "m1", "type": "choice", "tags": ["conditionals"], "content": { "question": "If more people ____ buses, roads would be quieter.",
  "options": [ { "text": "use", "why": "Needs a past form." }, { "text": "used", "correct": true, "why": "if + past, would + verb." } ] } }
```

## What is checked

1. `format` is 2, `project.name` is there, there are 1 to 500 exercises, and the file is valid JSON.
2. Every exercise has an `id` (unique in the file), a known `type` and a `content`.
3. Required fields are there, texts are not empty, and unknown fields are rejected, in the exercise and in `content`.
4. `choice`: 2 to 6 options, at least one `correct`, every option has `why`.
5. `fill`: the markers are `{{1}}` to `{{n}}` in order, one per gap. `rewrite`: each `mistakes[].wrong` appears once in `text`.
6. Any problem means nothing is imported. One line per problem: `Exercise 3 (choice): content.options: no option is marked correct.`
   or `Not valid JSON (line 42).`

The page checks the file as you choose it and shows the problems (with **Copy problems**, to give to Claude); the server checks it
again before it stores anything. Adding a file to an existing project (**Add exercises…**) rejects an `id` the project already has.

## How answers are graded

- `rewrite`, `write`, `choice` and `fill` go to `claude -p` with one prompt, `features/practice/prompts/grade.md`, which you can
  edit (it is read at every grading). The request holds that prompt, the exercise as stored (type, topic, tags and the whole
  `content`, so the model sees the right options, accepted answers, reasons, reference and planted mistakes) and your answer. The
  reply is free text. It is shown as written, and an estimated band appears only for essays.
- A `flashcard` is not graded: you flip it and rate yourself.

## Data (`data/practice-v2.sqlite`)

- `projects`: `id`, `name`, `description`, `created_at`, `last_activity_at` (empty until the first attempt).
- `exercises`: `id`, `project_id`, `key` (the file's `id`), `position`, `type`, `topic`, `tags_json`, `content_json`.
- `attempts` (append-only): `project_id`, `exercise_id`, `submitted_at`, `type`, `exercise_snapshot_json` (the exercise as it was),
  `answer_json`, `status` (`grading`, `graded`, `failed`), `result_json` (`{ text, model, ms }` for the AI; `{ rating }` for a
  flashcard), `summary` (the History line: `Graded`, or the rating), `grader` (`ai` or `self`), `model`, `grading_ms`, `error`,
  `writing_ms`, `graded_at`.
- Opening an old attempt reads its row only, so later changes to an exercise never change what you see.
- **History** is the latest attempt of each exercise in the project, newest first. **Drafts** stay in the browser (localStorage).
