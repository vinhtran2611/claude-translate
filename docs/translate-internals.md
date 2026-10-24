# Translate: how it works

The details behind the Translate page: thinking, side-by-side pairs, the Markdown renderer, printing, the `claude` command,
the warm spare process, the HTTP API, timeouts, the server log and the prompt files. For a short overview, see the
[README](../README.md).

## History sidebar

Every translation that produced any text is saved automatically, including ones that were
cancelled or stopped part way (marked with an amber dot). The sidebar on the left lists them,
grouped by Today, Yesterday, Previous 7 days, Previous 30 days, then by month. Click an entry
to bring it back instantly, without calling Claude; the open entry is highlighted.

A translation runs on the server, not in the page ([translate-background-jobs-design.md](translate-background-jobs-design.md)).
Opening another entry, **New translation**, **Clear**, ⇄, a reload or closing the tab only stops
watching it; it keeps going. Only **Cancel** (beside Translate while it runs), `Esc`, or deleting
the entry stops it. Up to 5 run at once (`MAX_RUNNING_TRANSLATIONS`); one more is refused with an alert. While the page shows a
running translation, its text box is read-only and Translate is disabled: click **New translation**
to start another.

Each row shows at most one dot:

| Dot | Means |
|---|---|
| pulsing accent | still translating; click it to watch it live from where it is |
| solid accent | finished while no page was watching it (or a restart cut it short); cleared when you open it |
| amber | cancelled or stopped part way |

While a listed row is running, the open sidebar reads the list again every 3 s.

| Action | How |
|---|---|
| Show or hide the sidebar | sidebar button top left, or `⌘\` |
| Search | `⌘K`; matches the text and its translation, ignoring diacritics (`giup` finds `giúp`) |
| Move through the list | `↓` from search, then `↑` `↓` `Home` `End`, `↵` to open |
| New translation | **New translation**: clears the page, **Undo** brings it back |
| Delete | trash icon on hover, or `⌫` on a focused entry. **Undo** in the toast within 5 s |

At 1280 px and wider the sidebar is docked beside the page and stays open or closed as you
left it. On narrower windows it opens as a drawer over the page and closes once you pick an
entry.

- Stored in SQLite at `data/translate.sqlite` (built into Node, no install). Set
  `TRANSLATE_DATABASE_PATH` to use another file, e.g. for tests. The old `data/history.sqlite` is
  renamed to it once, after a copy to `data/backups/history-before-rename.sqlite`.
- Every run is saved when it starts and updated when it ends, so a failed or cancelled run is kept
  with its reason (`run.errorCode`, `run.errorMessage`). While it runs, its output so far is saved
  at most every 5 s (`CHECKPOINT_INTERVAL_MS`), so a run the server was stopped in keeps all but the
  last few seconds; it becomes failed with `interrupted` at the next start. The shape is the spec's
  `Translation` ([data-model-proposal.md](data-model-proposal.md) §3.5).
- The list shows the newest 200 entries. Everything is kept until you delete it; to wipe all
  history, stop the server and delete `data/translate.sqlite`.
- The server refuses to start if the file was written by a newer schema than the code knows.
  An older file is upgraded in place on start, after a backup: schemas 2 to 4 added the thinking,
  model, effort and mode columns; schema 5 is the new data model (old failed runs get
  `claude_error` with "Unknown (saved before error details were kept)."); schema 6 adds `is_unread`
  (a schema 5 file gains the column in place; an older file goes straight to 6).

## Thinking

Even at `--effort low` the model sometimes thinks before it translates, mostly on long inputs.
While it does, a **Thinking…** block at the top of the translation streams the model's own
summary of its plan (in English, whatever the direction), and the status reads `Thinking… 6s`.
When the translation starts, the block folds into **✦ Thought for 6s ›** above the first pair;
click it to read the summary again. It is saved with the history entry, and it is never copied
or printed. A run without thinking shows nothing extra.

## Side-by-side pairs

The model splits the input into units the way a reader sees them (heading, paragraph, one
list item, table, code block, quote) and returns each unit as a pair: the unit's source text
(copied exactly, or tidied in Markdown mode), and its translation.

```
<pair type="list_item" level="1" marker="1.">
<source>Ground</source>
<translation>Ground</translation>
</pair>
```

The page draws each pair as one row of two cells, so a source unit and its translation always
start on the same line, and renders each by its type. The code does no Markdown splitting
of its own: plain text, PDF text with hard line breaks and Markdown all go the same way.
Copying the source back costs about twice the output tokens of a plain translation; that is
the price of exact pairing.

- After the run, the words of the left column are checked against the input, ignoring layout and
  Markdown syntax (`src/features/translate/web/source-check.ts`); a unit of type other (page furniture) may sit anywhere but must
  still be there, and a heading whose words are not the next input words counts as a section title Markdown mode added
  and is skipped. If the model changed or dropped a word, a yellow alert shows where the two part.
- In Markdown mode, plain prose of about 100 words or more is also laid out as a document: long paragraphs split
  between sentences, inline enumerations as list items, added `##` section headings and a few bold terms, every
  sentence kept ([markdown-structure-prompt.md](markdown-structure-prompt.md)). Text that is already Markdown, code or
  short is only tidied.
- If the reply has no pairs (the model ignored the format), the translation is shown as plain
  text, as before.
- **Edit** returns to the text box (available once the translation finishes); **Copy** gives the
  translation rebuilt as Markdown from the pairs.
- A unit whose text itself contains `</source>` or `</translation>` is cut short there.

### Markdown

`src/shared/web/markdown.ts` is the one Markdown renderer (no dependencies). It is the entry point; each job has its own file under
`src/shared/web/markdown/`: `inline.ts`, `blocks.ts`, `document.ts`, `document-index.ts`, `links.ts` and `render.ts`. The pair's type decides the block;
inside it, inline Markdown follows CommonMark 0.31.2 plus the GitHub extensions people paste:
`~~strikethrough~~`, bare URLs, tables (pipe or tab-separated), task lists and footnotes.

- **Links:** only `http`, `https`, `mailto` and `#anchors` are clickable. A `#anchor` jumps to the
  heading in the source column; one whose heading is not in the text is shown dotted, not clickable.
  Anything else (`javascript:`, relative paths) is shown as text with the target in a tooltip.
- **Footnotes** `[^1]` are numbered in order of first reference and link both ways.
- **Images** are shown as a chip with their alt text; they are never fetched.
- **Raw HTML** is shown as text. A single line break stays a line break.
- **While streaming**, syntax that has opened but not closed at the end of the cell renders as if it
  closed there (`**bol` shows bold), and a marker that cannot be decided yet (`[`, a trailing `*`)
  waits, so raw Markdown never flashes. When the reply ends, every cell renders again strictly.

Tests (plain Node, no packages): the CommonMark spec examples, GFM, the URL policy, and a check that
no raw syntax flashes on every prefix of small made-up documents (`test/fixtures/translations/`):

```
npm test
```

## Printing

`⌘P` on a side-by-side translation prints a paper layout, not the screen:

- A4 portrait, source and translation in two equal columns, 9.5 pt text.
- Each pair stays whole on one page, and a heading never ends a page.
- The top of each page names the two languages over their columns. The bottom shows the
  title (the first line of the source) and `page / pages`. These replace Chrome's own date,
  title and URL.
- Prints in black on white even when the screen is in dark mode. The app UI (sidebar, buttons)
  is left out.
- **Save as PDF** suggests `<title> · Claude Translate.pdf` as the file name.

The print layout covers the side-by-side view only; printing from **Edit** prints the text box
as it is.

## How it works

1. `npm start` runs `scripts/start.sh`, which checks requirements, then runs `node src/server.ts`.
2. `src/server.ts` listens on `127.0.0.1` only. `src/features/translate/server/routes.ts` serves the page
   (`src/features/translate/web/translate.html`) at `/` and handles `POST /translate`.
   A file under `src/` is served at its path under `src/` (`src/shared/web/markdown.ts` at `/shared/web/markdown.ts`),
   except the entry file and anything in a `server/` or `prompts/` folder. Every `.ts` file is served as JavaScript
   with its types stripped by Node (`stripTypeScriptTypes`), so there is no build step.
3. Each translation is a job (`src/features/translate/server/translation-jobs.ts`) handed to a `claude -p`
   process. The server reads the `<pair>` tags as they stream (`src/features/translate/server/pair-stream-parser.ts`),
   keeps what has arrived in memory, and forwards it to every page watching as Server-Sent Events.

### The `claude` command

```
claude -p
  --model <chosen model> --effort <chosen effort>
  --tools ""                                   # translate only, no file or shell access
  --setting-sources "" --disable-slash-commands --strict-mcp-config
  --no-session-persistence
  --system-prompt <the translate/prompts/ files, see Changing the translation style>
  --input-format stream-json --output-format stream-json --verbose --include-partial-messages
  --thinking-display summarized                # hidden flag: readable thinking summaries
```

`--thinking-display summarized` is not listed in `claude --help` (checked on 2.1.301). Without it
every thinking delta arrives empty. If a later `claude` drops the flag, every translation fails with
an `exited` error; delete that line in `spawnClaudeProcess` (`src/shared/server/claude-runner.ts`) to recover.

`--setting-sources ""` and the two flags after it keep your `~/.claude/CLAUDE.md`, skills,
plugins and MCP servers out of the request (measured: 5982 input tokens without them,
666 with). `--bare` would do the same but cannot use the subscription login.

### Warm spare process

Starting `claude` takes about 1.3 s. The server always keeps one process started and
waiting, so a translation only pays for the model call:

| | First text on screen | Short sentence done |
|---|---|---|
| Fresh process | ~2.2 s | ~3.0 s |
| Warm spare | ~0.9 s | ~1.4 s |

The model, effort and mode (its prompt) are fixed when a process starts, so the spare is started with
the last translation's settings. The first translation after changing them starts fresh (`cold start`
in the log); the next ones are warm again. A fallback model always starts fresh.

Each process translates exactly once and exits, so nothing carries over between
translations. A waiting process makes no model call, so it uses no subscription usage.
Two translations at the same moment work; the second starts a fresh process.

### API

```
GET /translation-options
  -> { models: [{ modelId, label, shortLabel, description }], efforts: [{ effort, label, description }],
       sourceFormats: [{ sourceFormat, label, description }],
       defaultModelId, defaultEffort, defaultSourceFormat,
       quotaWarning: { status, rateLimitType, utilization, resetsAt } | null }
       quotaWarning: the latest reply's rate limit when it warns or rejects; null before the first reply

POST /translate
  body: { "sourceLanguage": "en" | "vi", "targetLanguage": "vi" | "en", "sourceText": string,
          "modelId": string, "effort": "low" | "medium" | "high", "sourceFormat": "plain_text" | "markdown" }
        sourceText: non-empty, at most 100000 characters; modelId, effort and sourceFormat: one of /translation-options'
        (checked by the server, since the CLI silently ignores an unknown effort); anything else is a 400.
        429 (plain-text reason) when 5 translations are already running; no row is saved
  response: text/event-stream: the row is saved, the job starts, and this request watches it. Event names are
  lowercase snake_case; data is camelCase, in the words of the stored Translation (docs/data-model-proposal.md §3.5).
  A live run's stream is always snapshot, the events below, then one closing event (done, error or cancelled).
    event: snapshot  data: { "translation": Translation, "notice": RunNotice | null, "elapsedMs": number }
                     first: the row with everything so far (it names the new id), the latest retry or fallback
                     ({ kind: "retry", attempt, maxRetries, error } | { kind: "fallback", fromModelId, toModelId }),
                     and the time since the run started
    event: block_start         data: { "blockIndex": number, "blockType": string, "level": number, "marker": string | null }
    event: source_delta        data: { "blockIndex": number, "text": string }
    event: translation_delta   data: { "blockIndex": number, "text": string }
    event: outside_text_delta  data: { "text": string }   reply text outside any block (textOutsideBlocks)
    event: retry  data: { "attempt": number, "maxRetries": number, "error": string }
                                                    the API is busy and claude is retrying
    event: thinking_delta  data: { "text": string }   the next piece of the thinking summary
    event: thinking_done   data: { "durationMs": number }   once, when the thinking block closes
    event: fallback  data: { "fromModelId": string, "toModelId": string }
                                                    the chosen model sent no token in 10 s; the next one down takes over
    event: done   data: { "durationMs": number, "servedModelId": string, "effort": string, "isFallback": boolean,
                          "translationId": number }
    event: error  data: { "errorCode": string, "message": string, "servedModelId": string, "effort": string,
                          "isFallback": boolean, "translationId": number }
                  errorCode: no_response | stalled | claude_error | output_limit | start_failed | exited
                  translationId: the saved translation (saved at the start, whatever the outcome)
    event: cancelled  data: { "durationMs": number, "translationId": number }   Cancel, Esc or a delete stopped it
    event: finished   data: {}   the run is not live: read GET /history/:id (only from GET /history/:id/events)

GET  /history/:id/events   -> the same stream for a run that is live, so a page can re-attach (a new page, another
                              tab, a reload); or one `finished` event for any other id, known or not
POST /history/:id/cancel   -> 204, and every page watching gets `cancelled` | 409 not_running
POST /history/:id/read     -> 204, clears the entry's unread dot | 404
```

Closing the request only stops watching: the job runs on, and the page can re-attach with
`GET /history/:id/events`. Only `POST /history/:id/cancel` (**Cancel**, `Esc`) or `DELETE /history/:id`
stops its `claude` process: SIGINT first, SIGKILL if it is still alive 3 s later. A stopped server
cannot resume a run: its rows are marked `interrupted` at the next start, with their last checkpoint.

Timeouts are measured on text, not on the whole run, so a long translation can take as long
as it needs while it keeps streaming:

| Situation | Limit | Then |
|---|---|---|
| The chosen model has sent no first token (thinking or text) | 10 s (`SWITCH_TO_FALLBACK_AFTER_MS`) | it is stopped and the same request, at the same effort, runs on the next model down: Opus 5.5 → Sonnet 5.5 → Haiku 5.5; `event: fallback` tells the page. At most one switch per request |
| The model that took over, or a chosen Haiku 5.5, has sent no first token | 30 s (`LAST_MODEL_FIRST_TOKEN_TIMEOUT_MS`) | error `Haiku 5.5 sent nothing within 30s.` |
| A model that is thinking or writing pauses between tokens | 60 s (`STREAM_STALL_TIMEOUT_MS`) | error `… stopped streaming for 60s.` |

Both first-token limits grow by 1 s per 10k input tokens (`FIRST_TOKEN_MS_PER_INPUT_TOKEN`, tokens estimated
from `CHARS_PER_TOKEN`), since reading a long input delays the first token: 100,000 Vietnamese characters wait
17.7 s before falling back.

A reply that reaches `MAX_OUTPUT_TOKENS` (128k) is continued by `claude` itself, up to 3 times. If the last part
still ends at the limit, the request ends with error `output_limit`; what arrived is kept in history.

Even at `--effort low` the model sometimes thinks before it writes: measured on the same 7,022-character
input, Sonnet's first text came at 2.2 s on one run and at 8.1 s after 6 s of thinking on another, and a
13,867-character input thought for longer than 10 s on Sonnet and 30 s on Haiku. Thinking deltas count as
tokens, so a long think is never mistaken for a stuck model.

Once a model has started streaming it is never replaced.

```
GET    /history       -> [{ id, sourceLanguage, targetLanguage, sourceFormat, run, createdAt, updatedAt,
                            sourcePreview, outputPreview, isUnread }]  newest 200 (run.thinkingText is left out: null)
                          isUnread: the run ended with no page watching (or a restart cut it short), not opened since
GET    /history/:id   -> Translation: { id, sourceLanguage, targetLanguage, sourceFormat, sourceText, blocks,
                            textOutsideBlocks, run, createdAt, updatedAt }  | 404
                          run is a ModelRun: servedModelId answered, requestedModelId was chosen (a fallback when
                          they differ); thinkingText null when the model did not think; the duration is
                          finishedAt - startedAt. sourceText is what was pasted; with sourceFormat markdown,
                          blocks[].sourceText is tidied. A running row's output is its last checkpoint (at most 5 s
                          old); its events give the live output
DELETE /history/:id   -> 204 | 404; a running translation is cancelled first
```

Requests whose `Host` header is not `localhost:<PORT>` or `127.0.0.1:<PORT>` get 403, so another
website cannot read your history through DNS rebinding.

### Server log

The server writes its log to the terminal running `npm start` and appends the same lines, without
colour, to `data/server.log` (next to the history database; `SERVER_LOG_PATH` overrides it), so the log
outlives the terminal tab: `tail -f data/server.log` follows it. Each translation prints a `start` line and exactly one
closing line (`done`, `error` or `cancelled`); `watch`, `fallback`, `retry` and `quota` lines appear in between
only when they happen. Times are local. Why each line exists, and what is left out on purpose, is in
[server-log-design.md](server-log-design.md).

```
--- Sat 2026-10-24 ---
09:38:40            ready     http://localhost:8787  (Ctrl-C stops)
09:38:51       #1   start     en->vi  10,476 chars  Sonnet 5.5 high  markdown  history 63  1/5 running  cold start
09:38:53 WARN       quota     7d 78% (warning), resets Tue 20:00
09:39:07       #2   start     en->vi  706 chars  Sonnet 5.5 high  markdown  history 64  2/5 running
09:39:15       #2   done      Sonnet 5.5  high      7.9s  first text 2.1s  thought 3.0s  4 blocks  1,512 tokens  1 checkpoint  history 64  1/5 running
09:39:30       #1   watch     history 63  at 39.0s  18 blocks  1 watching
09:40:04       #1   done      Sonnet 5.5  high     72.5s  first text 24.1s  thought 22.5s  34 blocks  12,830 tokens  13 checkpoints  history 63  0/5 running  unread
09:40:20       #3   start     en->vi  65 chars  Sonnet 5.5 low  plain_text  history 65  1/5 running
09:40:30 WARN  #3   fallback  Sonnet 5.5 sent no token within 10s, last_event=system/status -> Haiku 5.5
09:41:00 ERROR #3   error     Haiku 5.5   low      40.0s  no_response: sent nothing within 30s, last_event=system/status  history 65  0/5 running
09:41:12       #4   start     en->vi  9,800 chars  Sonnet 5.5 high  markdown  history 66  1/5 running
09:41:24       #4   cancelled Sonnet 5.5  high     12.3s  by delete  first text 6.0s  2 blocks  2 checkpoints  history 66  0/5 running
09:41:24            history   66 deleted
```

Columns: time, level (blank, `WARN` or `ERROR`), request number, event, message.
The request number `#n` is shared by every feature (Translate, grading, generation) and starts again at 1 after each
restart; the `start` line pairs it with the `history` id, which lasts. `grep '#12 '` finds one run's lines,
`grep 'history 63'` a row's lines across restarts.
`grep -E 'WARN|ERROR'` keeps only the problems. Colour (WARN yellow, ERROR red) is used on a terminal
only; `NO_COLOR=1 npm start` turns it off.

| Event | Level | Meaning |
|---|---|---|
| `ready` | none | the server is listening |
| `prompt` | none | a file in `src/features/translate/prompts/` changed; the spare process was replaced |
| `spare` | WARN | the waiting `claude` died before a request used it; its stderr follows. Logged once until a spare works again |
| `start` | none | a translation began, with the chosen model, effort and source format, its `history` id and the slots in use counting it (`2/5 running`); `cold start` when no spare was waiting for those settings (about 1.3 s slower) |
| `watch` | none | a page re-attached to a running translation (`GET /history/{id}/events`): how far the run had got (`at 39.0s`, blocks) and how many pages now watch it. The page that started the run, and a page that stops watching, log nothing |
| `retry` | WARN | the API is busy and `claude` retries: attempt/max, error (HTTP status), delay |
| `quota` | WARN, ERROR | subscription usage: window, percent, status, reset time. Logged when the status changes or usage passes another 5 % |
| `fallback` | WARN | the chosen model sent no first token in time; the next one down takes over |
| `continue` | WARN | the reply reached the output-token limit and `claude` asked the model to continue |
| `done` | none, WARN | finished. WARN when the reply had no blocks or text outside them (`chars outside blocks`) |
| `error` | ERROR | `errorCode: reason` (see the API section). `last_event` is the last stream-json event `claude` sent; an `exited` error shows its stderr tail below |
| `cancelled` | none | the run was stopped: `by cancel` (**Cancel** or `Esc`, one request) or `by delete` (deleting the entry). A page that only stops watching logs nothing |
| `history` | none, WARN, ERROR | none: `66 deleted`. WARN at startup: the rows a restart cut short, each with the blocks its last checkpoint kept (`63 (18 blocks saved), 65 (nothing saved)`; after 10 ids, `and N more`), printed before `ready`. ERROR: saving a row failed, naming it and what that means: `63 checkpoint failed: ...` (once per run) or `63 save failed: ...` |
| `stdout` | WARN | `claude` printed a line that is not JSON |
| `http` | WARN, ERROR | 400 bad request, 429 `POST /translate: 5/5 running (history 63, 64, 65, 66, 67)`, 409 `POST /history/63/cancel: not running`, 403 wrong `Host` (once per Host), 500 with the first stack frames (also when a new run's row cannot be saved) |

The closing line lists, in this order and only as far as the request got: model, effort, total time, the
failure or cancel cause, `first text` (time to the first translated text), `thought` (thinking time), blocks,
`chars outside blocks`, output `tokens` (thinking included), `checkpoints` (progress saves; left out when none),
`history` id, the slots still in use once this run has left (`0/5 running`), and `unread` when no page watched the end.

## Changing the translation style

The system prompt is assembled from files in `src/features/translate/prompts/`, in this order, each wrapped in its own XML tag
(Anthropic's prompting guidance): `core.md` (`<role>`, `<task>`, `<input_handling>`, `<output_format>` with worked
examples), `style-vi.md` (`<style_guide>` with the `{{glossary}}` placeholder), `style-en.md`, then the mode's
`source-translate.md` or `source-translate_markdown.md`. `glossary.tsv` is data: one `term<TAB>rule` per
line (`keep` leaves the English word in Vietnamese text, anything else is the Vietnamese form); `#` lines
are comments, and the server renders it into a `<glossary>` block at the placeholder. Add a term by adding a line.
The server notices a change to any of them within a second
and replaces the spare process, so the next translation uses the new prompt with no restart.

The prompt is a condensed version of the `translate` skill in
`~/.claude/skills/translate/SKILL.md`: keep technical terms in English when a Vietnamese
engineer would say them in English, and write natural Vietnamese rather than English
traced word by word. Changes to the skill do not reach this app; copy them over by hand.

The source formats (the Mode menu), models and efforts the menus offer, their descriptions, fallbacks and defaults are the
`SOURCE_FORMAT_OPTIONS` table in `src/features/translate/server/translate-prompt.ts` and the `MODEL_OPTIONS` and
`EFFORT_OPTIONS` tables in `src/shared/server/claude-runner.ts`; restart after changing them. A new source format also
needs its value in the `SourceFormat` type and the `source_format` CHECK of `src/features/translate/server/history-store.ts`.

