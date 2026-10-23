# Practice from a translation: design

Status: **built** (2026-10-23), with the deviations in §13. Written from scratch by a design agent, independent of an
earlier draft.

## 0. Goal and owner decisions

From a finished translation of an English post, one click makes a Practice project for mastering that post's English.

| Decision | Value |
|---|---|
| Unit | One post = one project |
| Types | `flashcard` and `choice` only |
| Mix (full post) | 50: 18 flashcards (vocab), 10 vocab choice, 13 grammar choice, 9 meaning choice |
| Short post | Fewer, same proportions |
| Choice shape | 4 options, exactly one correct, one-line explanation on every option; meaning answers include Vietnamese |
| Grading | Choice stays AI-graded, as today |
| Where | Trigger in Translate; exercises done in Practice |
| Quality bar | `data/practice-imports/t-24-php-security.json`, hand-made from translation 24 |

The sample fixes the shape:

- Keys `fc-`, `vo-`, `gr-`, `me-` + number + slug.
- One `topic` per project.
- Tags are a category plus a subkind: `["vocab","vocab:collocation"]`, `["grammar","grammar:subjunctive"]`.
- A flashcard's `back` is `"<Vietnamese>: <English definition>"`, and its `example` is a sentence from the post.
- A choice carries the post's sentence, either as a `____` gap in `question` or as `context`.

It is 50 exercises (18 + 32), with 13 distinct grammar tags, in 39 KB. The post is 1,860 English words in 40 blocks.

## 1. Options considered

| Question | Options | Choice and why |
|---|---|---|
| Which feature generates | Translate, Practice, a new shared service | **Practice server.** It owns projects, `import-check`, `importFile` and the prompts folder. It already runs `claude -p` in the background for grading (`ai-grading.ts:81`) |
| How the post reaches Practice | (a) Practice server reads `translate.sqlite`; (b) Practice page fetches `/history/{id}`; (c) Translate page POSTs the post it holds | **(c).** (a) breaks the boundary rule (`test/boundaries.test.ts:18`). (b) makes Practice depend on Translate's API. With (c), Translate knows one Practice endpoint. The request type goes in `src/shared/api-types.ts`, as a contract between two features |
| Sync or background | Hold the POST open for 3 to 6 min, or answer `202` and run in the background | **Background**, like a grading (`routes.ts:449`). Closing the tab does not stop it |
| Persist the run | Memory only, or a row | **A row.** The run rules say a model run is saved when it starts, and a running row becomes `interrupted` on restart (`data-model-proposal.md:133-134`). The row also keeps the input, so Try again works from Practice alone |
| Progress | Polling, or SSE | **SSE**, copying the grading watch: `snapshot`, deltas, `finished` (`ai-grading.ts:154-172`, `routes.ts:454`) |
| Invalid output | Automatic retry with the errors, or drop the bad items | **Drop the bad items, no retry** (§4.5). `runClaude` takes one user message (`claude-runner.ts:214`), so a repair turn would resend the whole post plus a 40 KB reply |

## 2. Flow

```
Translate page (translation 24, done, en->vi)
  [Practice] button
    |  POST /api/practice/generations
    |  { translationId, title,
    |    sourceLanguage, blocks }
    v
Practice server
  store.startGeneration -> row, running
  generator.start       -> runClaude(generate.md)
    |  202 { generation }
    |  (409 if running or already made)
    v
Translate opens /practice#/g/{id}
  in a new tab
    |
Practice page
  GET /generations/{id}/stream (SSE)
  "Writing exercises... 23 of 50"
    |
  reply done
    -> checkReply
    -> store.finishGeneration
       (project + exercises + row,
        one transaction)
    v
  event done -> #/p/{projectKey}
```

## 3. Data model

One new table in `data/practice.sqlite`, following the house rules: STRICT, `run_*` columns and checks, time checks,
`<table>_by_<columns>` index names (`data-model-proposal.md:424-433`).

```sql
CREATE TABLE generations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  translation_id INTEGER NOT NULL CHECK (translation_id > 0),
  title          TEXT    NOT NULL CHECK (title <> ''),
  post_json      TEXT    NOT NULL CHECK (json_valid(post_json)),
  target_count   INTEGER NOT NULL CHECK (target_count BETWEEN 1 AND 50),
  project_id     INTEGER REFERENCES projects ON DELETE SET NULL,
  reply_text     TEXT    CHECK (reply_text IS NULL OR reply_text <> ''),
  dropped_count  INTEGER CHECK (dropped_count IS NULL OR dropped_count >= 0),
  <runColumns(true)>, <TIME_COLUMNS>, <RUN_CHECKS>
) STRICT;
generations_by_translation_id_id (translation_id, id)
generations_by_run_status        (run_status)
UNIQUE generations_by_translation_id_running
  (translation_id) WHERE run_status = 'running'
```

The helpers are in `model-run.ts:26,32,40`. The running index copies `gradings_by_attempt_id_running`
(`store-schema.ts:63`).

| Column | Notes |
|---|---|
| `translation_id` | An ID from another system (Translate). Not a foreign key: the features use separate files |
| `post_json` | `[{ sourceText, translatedText }]` as sent. Try again and the eval script use it |
| `project_id` | Set on success. Becomes NULL if the project is deleted, so it is in no CHECK |
| `reply_text` | The raw reply, kept on failure too. The run rules allow "none, or partial" output (`data-model-proposal.md:127-131`) |

- **Error code.** Add `'invalid_reply'` to `RunErrorCode` (`src/shared/api-types.ts:23`) and `RUN_ERROR_CODES`
  (`model-run.ts:8`). The CHECKs of existing tables keep their old lists, which is harmless: only `generations` writes
  this code. Update the table in `data-model-proposal.md` §3.3.
- **Migration.** `SCHEMA_VERSION` 3 → 4 (`store-schema.ts:11`). `migrateFrom3` only creates the table and its indexes.
  Call it in `openPracticeStore` with `if (fileSchemaVersion <= 3)` (`store.ts:241-242`), and add the table to
  `CREATE_TABLES`. The daily backup already covers the file (`server.ts:41`).

## 4. The generation task

### 4.1 Plan: how many of each

`words` = the post's English word count. `total = clamp(round(words / 37), 10, 50)`, so 1,860 words gives 50. The total
is split 18:10:13:9 by largest remainder: 50 → 18/10/13/9, 20 → 7/4/5/4, 10 → 4/2/3/1. The plan is in the user
message, so the model writes exactly that many of each.

### 4.2 Prompt: `src/features/practice/prompts/generate.md`

Read at every run, like `grade.md` (`ai-grading.ts:51-54`), so an edit applies without a restart. Its sections:

1. **Role and reader.** A Vietnamese IELTS learner (band 6.5 to 7) who is a developer.
2. **Goal.** Master this post's English. Every item comes from the post.
3. **The four kinds and their subkind tags.**
   - vocab: collocation, formal-word, phrasal-verb, synonym, word-form
   - grammar: tense, passive, conditional, subjunctive, relative-clause, article, linking-word, comparison,
     agreement, verb-form, noun-number...
   - meaning: phrase, sentence, inference
4. **Diversity rules.**
   - No two grammar items test the same point, unless there are more items than points.
   - Spread items over the beginning, middle and end of the post.
   - No phrase is tested twice across kinds.
   - Skip code, names and URLs.
5. **Field rules**, with the limits from `import-check.ts`.
   - flashcard (`import-check.ts:124-130`): `front` ≤300; `back` ≤2,000, as `"<vi>: <en definition>"`; `hint` ≤300;
     `example` ≤1,000, quoted from the post; `explanationMarkdown` ≤5,000, optional.
   - choice (`:108-116`): `question` ≤2,000; `context` ≤5,000; exactly 4 options, each with `text` ≤500 and a one-line
     `explanationMarkdown` ≤1,000.
   - Exactly one option has `"isCorrect": true`.
   - The right meaning option's explanation has the Vietnamese.
   - Wrong options are plausible mistakes a Vietnamese learner would make.
   - `tags`: at most 10, each ≤40 characters (`:151`). Keys match `KEY_PATTERN` (`:20`).
6. **Output.** One JSON object, nothing else: `{ "name": ≤60 chars, "topic": ≤100 chars, "exercises": [...] }`, in the
   order fc, vo, gr, me. Two short examples from the sample: one flashcard and one choice.

### 4.3 Input message

```
Make exercises from this post.
<plan total="50" flashcard="18" vocab="10" grammar="13" meaning="9"/>
<post title="..." translation_id="24">
<block n="1"><en>...</en><vi>...</vi></block>
...
</post>
```

The Vietnamese is sent too, so the glosses match the owner's own translation.

### 4.4 Output check: `checkReply(reply, plan)`

A pure function in `generation-check.ts`. The steps, in order:

1. **Parse.** Trim the reply, strip one ```` ```json ```` fence, and `JSON.parse` it. It must be an object with `name`,
   `topic` and `exercises[]`; otherwise the run fails with `invalid_reply`.
2. **Fill and check each exercise.** Fill `topic` from the top level when it is missing. Run each exercise through
   `checkExerciseInput` (`import-check.ts:669`), which applies every field and type rule.
3. **Extra rules.**
   - The type is `flashcard` or `choice`.
   - A choice has `options.length === 4`, exactly one `isCorrect`, and distinct option texts.
   - `tags[0]` is `vocab` for a flashcard, and `vocab`, `grammar` or `meaning` for a choice.
   - No key is used twice in the reply.
4. **Drop.** An exercise that fails step 2 or 3 is dropped. Its problems are logged with `problemLine`
   (`import-check.ts:710`).
5. **Threshold.** If fewer than 80% of `plan.total` are kept, the run fails with `invalid_reply`, and the message names
   the first three problems. Otherwise it succeeds and saves `dropped_count`.
6. **Warnings only.** These are quality signals for the eval, not reasons to reject:
   - per-kind counts that differ from the plan;
   - fewer than 8 distinct `grammar:*` tags when the total is 50;
   - no Vietnamese letters (`/[ăâđêôơưạ-ỹ]/i`) in a flashcard `back` or in the right meaning option.

The project around the kept exercises:

| Field | Value |
|---|---|
| key | `t-{translationId}-{slug(name)}`, cut to 64 characters |
| name | from the reply |
| description | `Made from translation {id}: "{title}". {n} flashcards and multiple-choice questions on the post's vocabulary, grammar and meaning.`, cut to 500 characters |

### 4.5 Why no automatic retry

- A retry costs another 3 to 6 minutes.
- With a single-message runner, it would resend the post plus the reply.
- Dropping a few bad items still keeps 45 or more good ones.

A failed run offers **Try again**, which starts a fresh run from `post_json`.

### 4.6 Defaults, size and time

| | Value |
|---|---|
| Model and effort | `claude-opus-5-5`, `medium`, set in `generation.ts`. Build step 1 confirms or changes this |
| Output | About 39 KB, around 11k tokens. Far below the 128k limit (`claude-runner.ts:29`) |
| Time | 3 to 6 minutes |
| Input | Up to about 250 KB for a 100k-character post (`translate/server/routes.ts:30`) |
| First token | Pass `firstTokenAllowanceMs` with Translate's formula (`translate/server/routes.ts:181,292`). Without it, a long post hands over to the fallback model after 10 s (`claude-runner.ts:34,274`) |

## 5. Server code

**`src/features/practice/generation-check.ts`** (pure, next to `import-check.ts`):

- `planOf(words: number): GenerationPlan` returns `{ total, flashcard, vocab, grammar, meaning }`.
- `userMessageOf(post: GenerationPost, plan): string`
- `checkReply(reply: string, plan)` returns `{ name, topic, exercises: ExerciseInput[], dropped: Problem[] }` or
  `{ problems: Problem[] }`.
- `projectFileOf(generation, checked, key): ProjectFile`

**`src/features/practice/server/generation.ts`**, modelled on `ai-grading.ts`:

- `createGenerator(store)` returns `{ start(generation), watch(res, id) }`.
- A `liveGenerations` map holds `{ text, startedAt, exerciseCount, watchers }` for each running generation.
- `onText` counts the `"key"` occurrences to get `exerciseCount`, and emits a `progress` event.
- `onDone` runs `checkReply`, then `store.finishGeneration`, then tells the watchers. The result is saved before the
  watchers hear about it, and a save error is logged, never thrown (`ai-grading.ts:93-103`).

**`store.ts`:**

| Method | Transaction | Notes |
|---|---|---|
| `writeProjectFile(file, now)` (private) | none | The body of today's `importFile` |
| `importFile(file, isDryRun)` | `inTransaction(() => writeProjectFile(...))` | Unchanged behaviour. This fixes the nesting problem: `BEGIN IMMEDIATE` cannot nest (`sqlite.ts:98-108`) |
| `startGeneration(input, settings)` | one | Returns `'generating'` when a running row exists, `{ made: projectKey }` when the latest succeeded row still has its project, and the new `GenerationDetail` otherwise |
| `finishGeneration(id, outcome)` | one | On success: pick a free key (`base`, then `base-2`, ...), so an existing project is **never overwritten** (`importFile` would, `store.ts:548-572`); then `writeProjectFile`, then set `project_id`, `dropped_count`, `reply_text` and the run. On failure: the run and `reply_text` |
| `readGeneration(id)`, `listGenerations(translationId)` | none | Joined to `projects.key` |
| `failInterruptedGenerations(): number` | none | Called at start, next to `failInterruptedGradings` (`routes.ts:101`) |
| `retryGeneration(id)` | one | Inserts a new row with the same `translation_id`, `title` and `post_json`. Refused while a run is going |

## 6. HTTP API

Under `/api/practice`. camelCase JSON, lowercase query parameters, the one error shape via `sendError` (`http.ts:28`),
and unknown fields rejected (`practice-api-design.md:224-240`).

| Method and path | Body | Result |
|---|---|---|
| `POST /generations` | `GenerationRequest { translationId, title, sourceLanguage, blocks: [{ sourceText, translatedText }] }` | `202 { generation }` |
| `POST /generations/{id}/retry` | none | `202 { generation }` |
| `GET /generations?translation={id}` | | `{ items }`, newest first |
| `GET /generations/{id}` | | `GenerationDetail`, without `postJson` |
| `GET /generations/{id}/stream` | | SSE events: `snapshot`, `progress {exerciseCount}`, `retry`, `fallback`, `done {projectKey}`, `error {message}`, `finished` |

Errors:

- `400 invalid`: `sourceLanguage` is not `en`, `blocks` is empty, the post has fewer than 150 English words, or a block
  has an empty `sourceText`.
- `409 generating`, with `generationId`.
- `409 already_made`, with `projectKey`.
- `413`, via `readRequestJson` (`http.ts:133`).

`MAX_GENERATION_BODY_BYTES = 1_000_000`, listed under `limits` in the index (`routes.ts:49`). The current limits (200 KB
at `request-checks.ts:8`, 256 KB at `routes.ts:37`) are too small for a long bilingual post. `GenerationRequest` and
`GenerationDetail` go in `src/shared/api-types.ts`, because both features read them.

## 7. Pages

### Translate

A ghost button **Practice** next to `#copy-button` (`translate.html:99`). It is shown when all of these hold:

- the target state is `done`;
- `shownHistoryId() !== null` (`history-sidebar.ts:43`, set at `translate.ts:416`);
- the source language is `en`.

On click it is disabled, and it POSTs a title (the first heading block, or else the first 80 characters) and the
blocks it holds. Then:

| Response | Then |
|---|---|
| `202` | opens `/practice#/g/{id}` in a new tab |
| `409 generating` | opens `/practice#/g/{generationId}` |
| `409 already_made` | opens `/practice#/p/{projectKey}` |
| any other error | shows it in the existing alert (`translate.ts:149`) |

### Practice

The route `#/g/(\d{1,9})` in `ROUTES` (`practice.ts:23-29`), and a view `generation-view.ts`:

| State | Shows |
|---|---|
| running | The title, "Writing exercises · 23 of 50", the elapsed time, the model, and "You can close this tab." |
| succeeded | Goes to `#/p/{key}`. Shows "47 of 50 kept" if any were dropped. If the project was deleted, says so and offers **Make again** |
| failed | The reason (`interrupted`, `invalid_reply` or a CLI error), and **Try again** |

## 8. Edge cases

| Case | Behaviour |
|---|---|
| Translation unfinished or failed | No button |
| vi→en | No button; the server answers 400 |
| Translation deleted later | Nothing changes: the post is in `post_json` |
| Very long post (60k+ characters) | 50 items spread over the post; the first-token allowance applies; fits in 1 MB |
| Very short post (<150 words) | 400 `invalid`, with a clear message |
| Project renamed | The link is `project_id`, so it still works |
| Project deleted | `project_id` becomes NULL, and generating again is allowed |
| Key taken | Suffixed `-2`, `-3`, ...; never overwritten |
| Restart mid-run | The row becomes `interrupted`; the page offers Try again |
| Two tabs or a double click | The unique running index makes the second POST a `409 generating`, which opens the same run |
| Output cut off, or a CLI error | Fails with the runner's code; `reply_text` is kept |

## 9. Tests

- **`generation-check.test.ts`**
  - `planOf` at 10, 20 and 50 exercises, and its clamping.
  - `checkReply` on the sample file's exercises as a reply: 50 kept, 0 dropped.
  - Each drop rule: 3 options, 2 correct, a duplicate key, the wrong type.
  - A fenced reply, a non-JSON reply, and the 80% threshold.
  - The key slug and its cut to 64 characters.
- **`store.test.ts`**
  - The migration 3 → 4.
  - `startGeneration` returning `generating` and `made`.
  - `finishGeneration`: all or nothing, a suffixed key, SET NULL when the project is deleted.
  - `failInterruptedGenerations`.
  - `importFile` unchanged.
- **`generation.test.ts`**, like `ai-grading.test.ts` with a fake process: success, `invalid_reply`, watcher events.
- **`boundaries.test.ts`** passes unchanged.

## 10. Build steps (the app works after each)

1. **Output quality first.** `generate.md`, `generation-check.ts` and its tests, the shared request type, and
   `scripts/eval-generation.ts`.
   - The script runs `runClaude` (with the first-token allowance) on a translation's blocks, then `checkReply`, and
     writes `data/practice-imports/t-24-gen.json`.
   - It prints a report against the sample: counts per kind, distinct grammar tags (target ≥10), items dropped,
     coverage over the post's quarters, the share of items with Vietnamese, and the overlap of flashcard fronts.
   - Import the file through the Import page, and do it side by side with `t-24-php-security`.
   - Repeat for Opus/medium, Opus/high and Sonnet/medium, and for a short and a long post. Fix the defaults here.
2. **Schema 4.** The table, `migrateFrom3`, the `invalid_reply` code, the store methods, the `importFile` refactor,
   and their tests.
3. **Server and API.** `generation.ts` and the routes. Try them with curl, including a restart mid-run.
4. **The Practice view** `#/g/{id}`.
5. **The Translate button.**
6. **Docs.** `practice-api-design.md`, `data-model-proposal.md`, `docs/README.md`, and this doc's status.

## 11. Not in v1

- Choosing the model in the UI.
- Other types, or instant grading.
- Regenerating or merging into an existing project.
- Editing the post first.
- vi→en posts.
- Listing or deleting generations in the UI.
- Automatic retry.
- Cancelling a run.

## 12. Open questions

1. **Model and effort default?** Decide in step 1; start at Opus 5.5, medium.
2. **The 80% threshold?** Keep it; revisit after 10 posts.
3. **May a vocab choice reuse a flashcard phrase?** The sample avoids it; forbid it in the prompt.
4. **Archive the project when it is done?** No; the existing Archive works.
5. **Keep `post_json` forever?** At most about 250 KB a run; yes, until size matters.

## 13. As built: deviations and the step 1 result

Step 1 on translation 24 (Opus 5.5, medium): the first run kept 49 of 50 (one `context` placed next to `content`) and
put only 3 items in the post's last quarter. One prompt revision (spread over the quarters by block number; no field
outside `content`) gave 50 of 50 kept, 0 warnings, 18/10/13/9, 13 distinct grammar tags, quarters 10/17/12/11,
Vietnamese in 27 of 27 glosses, in 270 s. The default stays Opus 5.5, medium. Opus/high, Sonnet/medium and the short and
long posts were not run.

| Design | As built | Why |
|---|---|---|
| §4.1: 10 → 4/2/3/1 | 10 → 4/2/2/2 | Largest remainder (3.6/2/2.6/1.8) gives this; ties go to the kind listed first |
| §4.4: `checkReply` returns `{ name, topic, exercises, dropped: Problem[] }` or `{ problems }` | `{ reply: GoodReply, problem: null }` or `{ reply: null, problem: string }`; `GoodReply` has `droppedCount`, `droppedLines` (via `problemLine`) and `warnings` | The pure check makes the lines, the caller only logs them |
| §4.4: Vietnamese test `/[ăâđêôơưạ-ỹ]/i` | adds the Latin-1 marked vowels (`à á â ã è é ...`) | "hoá" in the sample has none of the original letters |
| §3: `migrateFrom3` when `fileSchemaVersion <= 3` | only when `=== 3` | `migrateFrom2` runs `CREATE_TABLES`, which now holds the table |
| §5: `startGeneration` returns `'generating'` / `{ made }` / detail | `{ outcome: 'started', generation }`, `{ outcome: 'generating', generationId }`, `{ outcome: 'made', projectKey }`; also `readGenerationPost` | The 409 needs the running id; Try again needs the post |
| §6: the 409s carry `generationId` / `projectKey` | in the error object (`GenerationConflictBody`); the page's `ApiError` gained `fields` | The one error shape had no room for them |
| §6: request checks | `generationRequestProblems` reuses import-check's field rules (new `fieldProblems`, and `required` on a whole-number spec); a block's `translatedText` must not be empty, so the Translate page leaves out blocks with an empty text | Strict input with the existing checker |
| §7: succeeded "goes to `#/p/{key}`" | goes there when nothing was dropped; otherwise shows "N of M kept" with Open the project | The note would be lost by the jump |
| §7: Translate opens the tab after the answer | opens a blank tab at the click, then sets its address | Browsers block `window.open` after an await |
| §9: `generation.test.ts` with a fake process | `test/integration/practice-generation.test.ts`, through the server with `test/helpers/fake-claude` | A file in `src/` may not import test helpers |
| §9: the sample in tests | copied to `test/fixtures/practice/t-24-php-security.json` | `data/` is not in git |
| §5: slug | `slugOf` moved to `text.ts`; `keyFromName` uses it | One slug function |
