# Practice import format (version 4)

One file is one project: a group of exercises (one day, a topic). The file names its project by **key**, so importing a fixed
file again updates that project in place. The format is strict: an unknown field is a problem, and one problem means nothing
is imported. A ready example with every type: `features/practice/examples/example-project.json` (also **Download an example
file** on the Import page). The machine-readable version of this page is the JSON Schema at
`/api/practice/schemas/import.json`. The data model behind it is [data-model-proposal.md](data-model-proposal.md).

```json
{ "format": 4,
  "project": { "key": "m1-day-02", "name": "Day 2 - 20/10/2026", "description": "optional" },
  "exercises": [ { "key": "d2-fix-1", "topic": "transport", "tags": ["passive"], "content": { "type": "rewrite" } } ] }
```

| Field | Required | Notes |
|---|---|---|
| `format` | yes | `4` (a format 3 file is still read: see below) |
| `project.key` | yes | names the project: 1 to 64 of `a-z 0-9 -`, not starting with `-`. Use `m{month}-day-{nn}`, like `m1-day-02` |
| `project.name` | yes | 1 to 80 characters. `description`: optional, up to 500 |
| `exercises` | yes | 1 to 500 items |
| `key` | yes | same rule as `project.key`, unique in the file. It names the exercise inside its project |
| `topic`, `tags` | no | `topic`: short text. `tags`: up to 10 short texts, shown as chips |
| `content` | yes | an object; `content.type` says which kind of exercise it is (below) |

Every text must be non-empty. A field that is not required may be left out, or be `null`: both mean "use the default". The
importer fills in every default, so the stored exercise has them all (and **Export** writes them all out). Texts are limited
(an instruction 1,000 characters, a text to rewrite or a model answer 20,000); the limit is named in the problem line when
you pass it. The file is at most 2 MB. Every field name is camelCase.

## The seven types (`*` = required)

| `content.type` | For | Graded by |
|---|---|---|
| `rewrite` | say a text another way | the AI |
| `translation` | translate Vietnamese into English, or back | the AI |
| `correction` | fix the mistakes in a text | the AI |
| `essay` | free writing: an IELTS Task 2 essay | the AI, with estimated bands |
| `choice` | multiple choice, one answer or several | the AI, with the right answers and explanations from the file |
| `gap_fill` | fill in the blanks, short-answer quiz | the AI, with the accepted answers from the file |
| `flashcard` | vocabulary, facts | you: Didn't know, Almost or Knew it |

`length` is `sentence`, `paragraph` or `multi_paragraph`; it sets how long the answer may be. `constraints` is a list of up to
3 short rules the grader checks (the learner sees them too; default `[]`). `modelAnswer` is a good answer by the author: the
learner sees it after grading (default `null`). Every `explanationMarkdown` is Markdown.

**rewrite**: `instruction*`, `sourceText*`, `length*`, `constraints`, `modelAnswer`.

**translation**: `instruction*`, `sourceText*`, `sourceLanguage*` and `targetLanguage*` (`en` or `vi`, not the same),
`length*`, `constraints`, `modelAnswer`.

**correction**: `instruction*`, `sourceText*` (the answer box starts with it), `length*`, `plantedMistakes`
(`[{ wrongText*, correctText*, explanationMarkdown }]`, each `wrongText` exactly once in `sourceText`; default `[]`),
`constraints`, `modelAnswer`.

**essay**: `instruction*`, `minWords` (default 250), `suggestedMinutes` (a guide, never a limit), `constraints`, `modelAnswer`
(a model essay; the grader is told not to let it set the band).

**choice**: `instruction`, `question*`, `context` (a text the question is about), `options*` (2 to 6 of
`{ text*, isCorrect, explanationMarkdown* }`; `isCorrect` defaults to false). One correct option is single choice; two or more
is multi-select.

**gap_fill**: `instruction`, `textWithGaps*` with markers `{{1}} {{2}}` and so on, `gaps*` (`[{ acceptedAnswers*, hint,
explanationMarkdown }]`, one per marker, in order; `acceptedAnswers` is a list of 1 to 10 texts).

**flashcard**: `front*`, `back*`, `hint`, `example` (plain text), `explanationMarkdown` (up to 5,000 characters: the concept and
a worked explanation, rendered under the answer).

```json
{ "key": "m1", "tags": ["conditionals"], "content": { "type": "choice", "question": "If more people ____ buses, roads would be quieter.",
  "options": [ { "text": "use", "explanationMarkdown": "Needs a past form." },
               { "text": "used", "isCorrect": true, "explanationMarkdown": "if + past, would + verb." } ] } }
```

## What is checked

1. `format` is 4 (or 3), `project.key` and `project.name` are there, there are 1 to 500 exercises, and the file is valid JSON.
2. Every exercise has a `key` (unique in the file) and a `content` with a known `type`.
3. Required fields are there, texts are not empty, and unknown fields are rejected, in the exercise and in `content`.
4. `choice`: 2 to 6 options, at least one with `isCorrect: true`, every option has `explanationMarkdown`.
5. `gap_fill`: the markers are `{{1}}` to `{{n}}` in order, one per gap. `correction`: each `wrongText` appears once in
   `sourceText`. `translation`: the two languages differ.
6. Any problem means nothing is imported. The page shows one line per problem:
   `Exercise 3 (choice, d2-pick-1): content.options: no option is marked correct.` or `Not valid JSON (line 42).` The API
   answers `400` with each problem's JSON Pointer `path` (`/exercises/2/content/options`) and a `code` (`no_correct_option`).

The page checks the file as you choose it and shows the problems (with **Copy problems**, to give to Claude); the server checks it
again before it stores anything.

## Importing again

- A `project.key` that is new makes a project. One that exists updates that project's name and description.
- Each exercise: a new `key` is added; a `key` that exists with different content is replaced and its `version` goes up by 1;
  the same content (in any field order) changes nothing.
- The exercises are put in the file's order. Exercises the file leaves out are **kept** (after the file's ones): importing never
  deletes. To remove one, delete it (the page's **Delete exercise**, or `DELETE /api/practice/projects/{p}/exercises/{e}`; an
  exercise you have answered is deleted only with its answers, `?with_attempts=true`).
- Your answers are never changed: each attempt keeps a copy of the exercise as it was and the version it answered.
- `POST /api/practice/import?dry_run=true` says what would be created, updated or unchanged, and writes nothing.

## Format 3 (still read)

A `"format": 3` file is imported as it is and converted: `rewrite` with `"source_lang": "vi"` becomes a `translation` (into
English), `rewrite` with `"prefill": true` becomes a `correction` (`mistakes` become `plantedMistakes`; with both set, it is a
correction), `write` becomes `essay` (`prompt` → `instruction`, `min_words` → `minWords`, `minutes` → `suggestedMinutes`),
`fill` becomes `gap_fill` (`text` → `textWithGaps`, `answer` → `acceptedAnswers`), `reference` and `sample` become
`modelAnswer`, every `why`, `note` and `explanation` becomes `explanationMarkdown`, `correct` becomes `isCorrect`, and length
`essay` becomes `multi_paragraph`. Export always writes format 4.

A `"format": 2` file is refused. Three edits make it format 3: set `"format": 3`, add a `"key"` to `"project"`, and rename each
exercise's `"id"` to `"key"`.

## How answers are graded

- Every type but `flashcard` goes to `claude -p` with one prompt, `features/practice/prompts/grade.md`, which you can edit (it is
  read at every grading). The request holds that prompt, the exercise as stored (topic, tags and the whole `content`, so the
  model sees the right options, accepted answers, explanations, model answer and planted mistakes) and your answer. The reply is
  free text. It is shown as written, and an estimated band appears only for essays. Each grading is kept; **Grade again** adds a
  new one, and the page shows the latest.
- A `flashcard` is not graded: you flip it and rate yourself. The rating is the result.

## Data (`data/practice.sqlite`, schema version 3)

The tables follow [data-model-proposal.md](data-model-proposal.md) §4: `projects`, `exercises` (`content_json` holds the
content, `type` copies `content.type`), `attempts` (never changed; `exercise_snapshot_json` is the exercise as it was,
`answer_json` the answer) and `gradings` (one row per AI grading, with its `run_*` columns and `feedback_markdown`). Counts,
"done", the last activity and the history line are worked out when read, never stored. **Drafts** stay in the browser
(localStorage). Opening a schema 1 or 2 file migrates it once, after a copy to `data/backups/practice-before-schema-3.sqlite`.
