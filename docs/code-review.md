# Code review: readability

This review looks for code that is hard to read. It does not look for bugs.
Every fix keeps the behaviour the same: the same HTTP API, the same database,
the same import format, the same prompts and the same page.

The baseline before any change: `npm run check` passes lint and typecheck, and the
tests are 146 pass and 2 known failures (two markdown tests read `test/fixtures/`,
which is not in the repo).

## The main problems, worst first

### 1. `shared/web/markdown.ts` is one 1,084-line file

It holds five different jobs: the inline parser, the block parser, the parser for
whole documents, the cross-pair index, and the DOM renderer. You must scroll
through all of them to find one.

- `parseInline` (line 245) is one 320-line function. Many lines do two or three
  things, for example line 383:
  `if (next === '\n') { flushText(); append(...); position += 2; while (...) position++; continue; }`.
- `plainTextOf` (line 595) is a nested ternary four levels deep.
- `tableBlockOf` (line 730) picks the alignment with a nested ternary.

**Fix:** split it into `shared/web/markdown/` with one file per job: `inline.ts`,
`blocks.ts`, `document.ts`, `document-index.ts`, `links.ts`, `render.ts`.
`markdown.ts` stays as the one entry point, so no import changes. Then put one
statement on each line in `parseInline`, and give each construct (backslash,
code span, entity, `<`, `]`) its own small function. Replace the nested ternaries
with `if` and `switch`.

### 2. `web/app.ts` is one 1,419-line file

It mixes language detection, Markdown rebuilding, alert wording, the history
sidebar, the translate stream, the settings menus and keyboard shortcuts.

- `translate()` (line 769) is 125 lines. It reads the server-sent events and
  handles nine event kinds in one `if / else if` chain inside a `while` loop.
- `composePairsMarkdown` (line 307) ends with a nested ternary for the separator.
- `alertForError` (line 363) is a long list of one-line `if`s that return objects.
- The progress text (line 795) is a nested ternary.

**Fix:** move the parts that do not touch the page's state into their own files:
`web/detect-language.ts`, `web/pairs-markdown.ts`, `web/alert-text.ts`,
`web/stream-events.ts` (reads the event stream). In `translate()`, move the event
handling into `handleStreamEvent()`. Replace nested ternaries with small named
steps.

### 3. `server/server.ts` does five jobs in 566 lines

The prompt files, the `<pair>` stream parser, the warm spare process, the
translate request, and the HTTP router all live together.

- `createPairStreamParser` (line 143) is a 90-line state machine in the middle of
  the server file.
- `handleTranslate` (line 290) is 160 lines: request checks, stream handling,
  history saving and logging.
- The log level (line 397) is a nested ternary.

**Fix:** move the parser to `server/pair-stream-parser.ts`, the prompt and mode
list to `server/translate-prompt.ts`, and the spare process to
`server/spare-process.ts`. Move the request checks into `checkTranslateRequest()`.

### 4. `features/practice/server/store.ts`: schema, migration and queries in one closure

- The schema and the schema-1 migration (lines 21-123) sit above the store, but
  only `openPracticeStore` uses them.
- Many SQL strings are one long line (lines 298, 308, 323, 362).
- `exportProject` (lines 590-594) builds objects with `...(x ? {} : { x })`
  spreads, three on one line.
- `keyFromName` (line 75) chains seven string calls on two lines.

**Fix:** move the schema and the migration to `store-schema.ts`. Write long SQL on
several lines. Build the exported objects step by step. Name the steps in
`keyFromName`.

### 5. `features/practice/server/routes.ts`: helpers and checks mixed with handlers

- The query and body helpers (lines 74-154) are not about any one route.
- `putOrder` (line 307) checks the `keys` list inline, inside the handler.
- `FILES` (line 30) is a `Map` built from spreads and `as const` on long lines.

**Fix:** move the helpers to `request-checks.ts`. Move the `keys` checks into
`orderProblems()`. Build `FILES` and `MODULES` with plain loops.

### 6. `features/practice/import-check.ts`: checks and JSON Schema in one file

- The field specs, the checks and the JSON Schema builder share one file.
- `checkRelations` (line 196) builds a 200-character message on one line.
- `checkExercise` (line 230) returns a cast object with four fields on one line.
- `nameOf` (line 107) is a nested ternary.

**Fix:** move the JSON Schema builder to `import-schema.ts`, next to the field
specs it reads. Break the long lines into named steps.

### 7. `shared/server/claude-runner.ts`: one 75-line stdout handler

`runModel` (line 233) handles every stream-json message kind in one long
`if / else if` chain inside the `data` callback. `last_event_kind` (line 302) is a
nested ternary.

**Fix:** move the chain into `handleMessage(message)`, and the event kind into
`eventKindOf(message)`.

### 8. `test/markdown.test.ts`: very long lines and a nested-ternary helper

- `blockText` (line 124) is a seven-level nested ternary.
- Lines 59-71 pack the CommonMark loop into dense one-liners.
- Lines 85-92 repeat `parseCellBlocks('table', '', 0, ..., { is_streaming: false, link_definitions: new Map() })`.

**Fix:** write `blockText` as a `switch`. Add a `tableOf(text)` helper. Name the
steps in the CommonMark loop.

### 9. `test/practice-store.test.ts`: the schema-1 fixture is a wall of SQL

Lines 399-432 build an old database with very long `INSERT` lines.

**Fix:** one row per line with named helpers, so you can see what each row is.

### 10. Small things in many files

- `{ a; b; }` blocks written on one line, mostly in `markdown.ts` and `app.ts`.
- `try { ... } catch {}` on one line for `localStorage` in `app.ts`.
- `web/app.ts` has its own copy of the copy and check icons that `shared/web/ui.ts`
  already has.
- `features/practice/server/ai-grading.ts` lines 23-24: a whole answer format on
  one line.

**Fix:** one statement per line; use the shared icons.

## What I will not change

- The CommonMark algorithms themselves (`processEmphasis`, the delimiter stack).
  They follow the reference implementation step by step. Rewriting them would
  make them harder to check against the spec.
- The translate page's model menu is a second copy of
  `shared/web/model-picker.ts`, with a mode menu and a quota line added. Merging
  them would change how the page behaves, so it is left as it is.
