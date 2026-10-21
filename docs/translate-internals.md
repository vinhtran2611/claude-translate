# Translate: how it works

The details behind the Translate page: thinking, side-by-side pairs, the Markdown renderer, printing, the `claude` command,
the warm spare process, the HTTP API, timeouts, the server log and the prompt files. For a short overview, see the
[README](../README.md).

## History sidebar

Every translation that produced any text is saved automatically, including ones that were
cancelled or stopped part way (marked with an amber dot). The sidebar on the left lists them,
grouped by Today, Yesterday, Previous 7 days, Previous 30 days, then by month. Click an entry
to bring it back instantly, without calling Claude; the open entry is highlighted.

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

- Stored in SQLite at `data/history.sqlite` (built into Node, no install). Set
  `HISTORY_DATABASE_PATH` to use another file, e.g. for tests.
- The list shows the newest 200 entries. Everything is kept until you delete it; to wipe all
  history, stop the server and delete `data/history.sqlite`.
- The server refuses to start if the file was written by a newer schema than the code knows.
  An older file is upgraded in place on start: schema 2 adds the thinking columns (older entries
  have no thinking), schema 3 the model and effort columns (older entries were all Sonnet 5.5 at Low),
  schema 4 the mode column (older entries were all As pasted).

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
  Markdown syntax (`web/source-check.ts`); a unit of type other (page furniture) may sit anywhere but must
  still be there. If the model changed or dropped a word, a yellow alert shows where the two part.
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

1. `start.sh` checks requirements, then runs `node server/server.ts`.
2. `server/server.ts` serves `web/index.html` on `127.0.0.1` only and handles `POST /translate`.
   Every `.ts` file under `web/` and `src/shared/web/` (for example `web/app.ts` and `/shared/web/markdown.ts`) is served as
   JavaScript with its types stripped by Node (`stripTypeScriptTypes`), so there is no build step.
3. Each translation is handed to a `claude -p` process. The server reads the `<pair>` tags as
   they stream (`src/features/translate/server/pair-stream-parser.ts`) and forwards them to the page as Server-Sent Events.

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
  -> { models: [{ model_id, label, short_label, description }], efforts: [{ effort, label, description }],
       modes: [{ mode, label, description }],
       default_model_id, default_effort, default_mode,
       quota_warning: { status, rate_limit_type, utilization, resets_at } | null }
       quota_warning: the latest reply's rate limit when it warns or rejects; null before the first reply

POST /translate
  body: { "source_language": "en" | "vi", "target_language": "vi" | "en", "text": string,
          "model_id": string, "effort": "low" | "medium" | "high", "mode": "translate" | "translate_markdown" }
        text: non-empty, at most 100000 characters; model_id, effort and mode: one of /translation-options'
        (checked by the server, since the CLI silently ignores an unknown effort); anything else is a 400
  response: text/event-stream
    event: pair_start         data: { "pair_index": number, "pair_type": string, "level": number, "marker": string }
    event: source_delta       data: { "pair_index": number, "text": string }
    event: translation_delta  data: { "pair_index": number, "text": string }
    event: unpaired_delta     data: { "text": string }   reply text outside any pair
    event: retry  data: { "attempt": number, "max_retries": number, "error": string }
                                                    the API is busy and claude is retrying
    event: thinking_delta  data: { "text": string }   the next piece of the thinking summary
    event: thinking_done   data: { "duration_ms": number }   once, when the thinking block closes
    event: fallback  data: { "from_model_id": string, "to_model_id": string }
                                                    the chosen model sent no token in 10 s; the next one down takes over
    event: done   data: { "duration_ms": number, "served_model_id": string, "effort": string, "is_fallback": boolean,
                          "history_id": number | null }
    event: error  data: { "error_kind": string, "message": string, "served_model_id": string, "effort": string,
                          "is_fallback": boolean, "history_id": number | null }
                  error_kind: no_response | stalled | claude_error | output_limit | start_failed | exited
                  history_id: the saved history entry, null when there was no text to save
```

Closing the request (pressing **Translate** again, **Clear**, ⇄ or `Esc` mid-translation)
stops its `claude` process: SIGINT first, SIGKILL if it is still alive 3 s later.

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
GET    /history       -> [{ id, created_at, source_language, target_language, outcome, served_model_id, requested_model_id,
                            effort, mode, input_preview, output_preview }]  newest 200
GET    /history/:id   -> { ...summary, input_text, pairs, unpaired_text, duration_ms, is_fallback,
                            thinking_text, thinking_duration_ms }  | 404
                          served_model_id answered; requested_model_id was chosen; is_fallback when they differ
                          thinking_text '' and thinking_duration_ms null when the model did not think
                          input_text is what was pasted; in mode translate_markdown pairs[].source_text is tidied
DELETE /history/:id   -> 204 | 404
```

Requests whose `Host` header is not `localhost:<PORT>` or `127.0.0.1:<PORT>` get 403, so another
website cannot read your history through DNS rebinding.

### Server log

The server writes its log to the terminal running `start.sh` and appends the same lines, without
colour, to `data/server.log` (next to the history database; `SERVER_LOG_PATH` overrides it), so the log
outlives the terminal tab: `tail -f data/server.log` follows it. Each translation prints a `start` line and exactly one
closing line (`done`, `error` or `cancelled`); `fallback`, `retry` and `quota` lines appear in between
only when they happen. Times are local.

```
--- Sat 2026-10-17 ---
11:30:02            ready     http://localhost:8787  (Ctrl-C stops)
11:30:16       #1   start     en->vi  23,029 chars  Sonnet 5.5 low
11:30:19 WARN       quota     7d 89% (warning), resets Mon 06:00
11:32:41       #1   done      Sonnet 5.5  low     144.5s  first text 15.7s  thought 12.8s  140 pairs  27,745 tokens  history 16
11:40:05       #2   start     en->vi  65 chars  Sonnet 5.5 low
11:40:15 WARN  #2   fallback  Sonnet 5.5 sent no token within 10s, last_event=system/status -> Haiku 5.5
11:40:45 ERROR #2   error     Haiku 5.5   low      40.0s  no_response: sent nothing within 30s, last_event=system/status
```

Columns: time, level (blank, `WARN` or `ERROR`), request number, event, message.
`grep -E 'WARN|ERROR'` keeps only the problems. Colour (WARN yellow, ERROR red) is used on a terminal
only; `NO_COLOR=1 bash start.sh` turns it off.

| Event | Level | Meaning |
|---|---|---|
| `ready` | none | the server is listening |
| `prompt` | none | a file in `src/features/translate/prompts/` changed; the spare process was replaced |
| `spare` | WARN | the waiting `claude` died before a request used it; its stderr follows. Logged once until a spare works again |
| `start` | none | a translation began, with the chosen model, effort and mode; `cold start` when no spare was waiting for those settings (about 1.3 s slower) |
| `retry` | WARN | the API is busy and `claude` retries: attempt/max, error (HTTP status), delay |
| `quota` | WARN, ERROR | subscription usage: window, percent, status, reset time. Logged when the status changes or usage passes another 5 % |
| `fallback` | WARN | the chosen model sent no first token in time; the next one down takes over |
| `continue` | WARN | the reply reached the output-token limit and `claude` asked the model to continue |
| `done` | none, WARN | finished. WARN when the reply had no pairs or text outside them (`unpaired chars`) |
| `error` | ERROR | `error_kind: reason` (see the API section). `last_event` is the last stream-json event `claude` sent; an `exited` error shows its stderr tail below |
| `cancelled` | none | the page closed the request: `Esc`, **Translate** again, **Clear**, ⇄, or the tab closed |
| `history` | ERROR | saving to history failed; the closing line then has no `history` id |
| `stdout` | WARN | `claude` printed a line that is not JSON |
| `http` | WARN, ERROR | 400 bad request, 403 wrong `Host` (once per Host), 500 with the first stack frames |

The closing line lists, in this order and only as far as the request got: model, effort, total time, the
failure, `first text` (time to the first translated text), `thought` (thinking time), pairs,
`unpaired chars`, output `tokens` (thinking included), `history` id.

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

The modes, models and efforts the menus offer, their descriptions, fallbacks and defaults are the
`MODE_OPTIONS` table in `src/features/translate/server/translate-prompt.ts` and the `MODEL_OPTIONS` and `EFFORT_OPTIONS` tables in
`src/shared/server/claude-runner.ts`; restart after
changing them. A new mode also needs its value in the `mode` CHECK of `src/features/translate/server/history-store.ts`.

