# Server log for background jobs: design

Status: **built**. The lines below are what the server prints; docs/translate-internals.md "Server log" is the user's reference.
"Today" and the `file:line` references below describe the code before this was built.

## 0. Goal

Translate now runs as server-owned jobs (docs/translate-background-jobs-design.md).
A job outlives the page that started it, so the log is the only place that sees a run from start to end.
This doc settles what the log must show about jobs, and nothing more.

Constraints, unchanged from today:

- One line per event, readable in a terminal, the same lines appended to `data/server.log`.
- No logging framework, no new dependency, no JSON lines, no log levels beyond `info`, `warn`, `error`.
- One normal mode. A verbose mode is added only when it clearly pays for itself (§4: it does not).

## 1. What the log cannot tell today

This real run ended with three `succeeded` rows, all read:

```
09:38:51       #1   start     en->vi  10,476 chars  Sonnet 5.5 high  markdown  cold start
09:38:53 WARN       quota     7d 78% (warning), resets Tue 20:00
09:39:07       #2   start     en->vi  706 chars  Sonnet 5.5 high  markdown
09:39:15       #2   done      Sonnet 5.5  high      7.9s  ...  history 64
09:39:51       #3   start     en->vi  1,512 chars  Sonnet 5.5 high  markdown
09:40:04       #1   done      Sonnet 5.5  high     72.5s  ...  history 63
09:40:08       #3   done      Sonnet 5.5  high     17.8s  ...  history 65
```

From these lines alone you cannot tell:

| Gap | Why it matters now |
|---|---|
| Which row a run is, until it ends | A running row is visible in the sidebar; you cannot match it to `#1` |
| How many of the 5 slots are busy | A `429` makes sense only if you can count the live runs |
| Whether a page re-attached | Re-attach is the newest and most fragile path (snapshot, then live tail) |
| Whether a run ended with nobody watching | That decides the unread dot (`translation-jobs.ts:255-256`) |
| Whether checkpoints were saved | That decides what a crash keeps (§4.1 of the jobs design) |
| Why a run was cancelled | Cancel/Esc and deleting the entry both print `cancelled` |
| Which rows a restart cut short | The startup line gives a count only (`routes.ts:159-160`) |
| Which feature `#1` belongs to | Translate, grading and generation each count from 1 (§5) |

## 2. The questions the log answers

Each question has one line or field that answers it.
A field that answers no question below is not added.

| # | Question | Answered by |
|---|---|---|
| Q1 | Which lines belong to one run? | `#n`, unique across features per server process (§5) |
| Q2 | Which history row is run `#n`? | `history N` on `start` (new) and on the closing line (as today) |
| Q3 | How many slots are busy? Why was a run refused? | `k/5 running` on `start` and the closing line; the `429` line names the live rows |
| Q4 | Did a page re-attach to a live run, and what did it get? | `watch` line (new) |
| Q5 | Did the run end with nobody watching, so it is unread? | `unread` on the closing line (new) |
| Q6 | Did checkpoints work? What would a crash lose? | `N checkpoints` on the closing line (new); `history` ERROR when one fails (as today, plus the row) |
| Q7 | Why was a run cancelled? | `by cancel` or `by delete` on the `cancelled` line (new) |
| Q8 | Why did a run fail? | The `error` closing line: errorCode, reason, `last_event`, stderr tail (as today) |
| Q9 | Which rows did a restart cut short, and what did they keep? | The startup `history` WARN lists each row and its saved blocks (changed) |
| Q10 | Where did a row go? | `history` line `N deleted` (new) |
| Q11 | How fast was it, which model served it? | The closing line's model, effort, time, first text, thought, tokens (as today) |

Cut, because they answer no real question:

| Not logged | Why |
|---|---|
| The starting page's own watch | `start` already implies it; only a re-attach is news |
| Each checkpoint | One line per 5 s per run. The count on the closing line says they ran; a failure logs itself |
| `finished` sent to a page for a run that already ended | A harmless race (jobs design §7.2); the page reads the stored row |
| `POST /history/{id}/read` | Clearing the dot is visible in the UI and changes nothing a run depends on |
| Esc versus the Cancel button | Both send the same request; the server cannot tell them apart, and nothing depends on it |

## 3. Event lines for Translate jobs

The column rules of `src/shared/server/log.ts:68-85` stay.
Time is 8 chars, level is padded to 5, `#n` to 4, the event name to 9 (`cancelled` is the widest).
The message is free text, cut to one line of 300 chars; detail lines print under it, indented, after `| `.
New event names stay at 9 chars or fewer.

### 3.1 Lines of one run

| Event | Level | When | Change |
|---|---|---|---|
| `start` | info | the row is saved and the job starts | adds `history N` and `k/5 running` |
| `watch` | info | a page re-attaches with `GET /history/{id}/events` to a live run | new |
| `retry`, `fallback`, `continue` | WARN | as today (`claude-runner.ts:262-266`, `:308`, `:350`) | none |
| `done` | info, WARN | the run succeeded | adds `N checkpoints`, `k/5 running`, `unread` |
| `error` | ERROR | the run failed | the same additions |
| `cancelled` | info | Cancel, Esc, or a delete stopped it | adds `by cancel` or `by delete`, and the same additions |
| `history` | ERROR | a checkpoint or the final save failed | names the row and what the failure means |

`start`, with `k/5 running` counting this run:

```
09:39:07       #2   start     en->vi  706 chars  Sonnet 5.5 high  markdown  history 64  2/5 running
```

`cold start` stays last when present.

`watch`, with how far the run had got when the snapshot was sent and how many pages now watch it:

```
09:39:30       #1   watch     history 63  at 39.0s  18 blocks  1 watching
```

The closing line keeps today's fields and order (`formatRequestSummary` in `translation-jobs.ts`).
`N checkpoints` joins the other counts just before `history N`; the slot count and `unread` go after it:

| Field | Shown | Meaning |
|---|---|---|
| `N checkpoints` | when N > 0 | progress saves during the run (`saveCheckpoint` in `translation-jobs.ts`) |
| `history N` | always | the row, as today |
| `k/5 running` | always | slots in use after this run left the live map |
| `unread` | when no page watched the end | the row was saved with `is_unread = 1` |

`by cancel` or `by delete` takes the place of the failure text, after the duration, as `error` puts its reason there.
It is passed as that same failure text (`cancel` hands `by <cause>` to `finishJob`), so the summary has one slot for "why it ended", not two.

```
09:40:04       #1   done      Sonnet 5.5  high     72.5s  first text 24.1s  thought 22.5s  34 blocks  12,830 tokens  13 checkpoints  history 63  2/5 running  unread
09:41:12       #4   cancelled Sonnet 5.5  high     12.3s  by delete  first text 6.0s  2 blocks  2 checkpoints  history 66  0/5 running
```

The closing line grows by about 35 chars.
That is the price of answering Q3, Q5 and Q6 without new lines.

### 3.2 Lines outside a run

| Event | Level | When | Example message |
|---|---|---|---|
| `history` | WARN | startup found rows left `running` (changed) | `2 translations interrupted by a restart: 63 (18 blocks saved), 65 (nothing saved)` |
| `history` | info | a row was deleted (new) | `66 deleted` |
| `http` | WARN | `429` (changed: names the live rows) | `429 POST /translate: 5/5 running (history 63, 64, 65, 66, 67)` |
| `http` | WARN | `409` on cancel (new) | `409 POST /history/63/cancel: not running` |

The `interrupted` line prints before `ready`, as today.
When many rows were cut short, the list stops after 10 ids and says `and 4 more`.

A `409` is logged because it means a Cancel the page sent did nothing, which the user may report.
Reads that answer `404` stay unlogged, as today.

## 4. Noise budget

| Run | Lines |
|---|---|
| A run you watch to the end | 2: `start`, `done` |
| A run you leave and come back to | 3: `start`, `watch`, `done` |
| A run with a busy API | 2 plus one `retry` per retry |
| Three runs at once, switching between them | 6 plus one `watch` per re-attach |

`quota` stays a shared line, printed only when it reads differently (`claude-runner.ts:317`).

So a typical run costs 2 lines, and at most a few more for things that really happened.
A day of use stays readable with `tail -f data/server.log`.

### No verbose mode

A verbose switch (for example `LOG_VERBOSE=1`) would add each checkpoint and `finished` for ended runs.
None of them answers a question in §2 that the normal lines do not.
A switch also doubles what a bug report must say ("was verbose on?") and needs a branch at every call site.
If a bug in the stream protocol ever needs them, a temporary `log()` call while fixing it is cheaper.

## 5. Correlation

### 5.1 One counter for `#n`

Today each feature counts its own runs:
`translateRequestCount` (`translation-jobs.ts:34`), `gradingRequestCount` (`ai-grading.ts:19`), `generationRequestCount` (`generation.ts:25`).
A `retry #1` line from `claude-runner.ts:308` may then belong to a translation or to a grading.

The fix is one counter in `log.ts`, `nextRequestNumber()`, used by all three.
`#n` is then unique among lines of one server process.
It restarts at 1 after each `ready`, so it is never a key across restarts.

The `#n` column is 4 wide (`log.ts:74`), which fits `#999`.
Past that, a line shifts one char right; that is accepted rather than widening every line.

### 5.2 `#n` and the history id

| Key | Lives | Use it to |
|---|---|---|
| `#n` | one server process | find every line of one run: `grep '#12 ' data/server.log` |
| `history N` | the database, forever | find a row's runs across restarts: `grep 'history 63' data/server.log` |

The `start` line holds both, so either key leads to the other.
`retry`, `fallback` and `continue` carry `#n` only, which is enough once `start` maps it.

### 5.3 Across a restart

A restart prints the date header, the `interrupted` line, then `ready`.
The `interrupted` line uses history ids, because the old `#n` values mean nothing in the new process.

```
09:42:10       #5   start     en->vi  9,800 chars  Sonnet 5.5 high  markdown  history 67  1/5 running
--- Sat 2026-10-24 ---
09:43:02 WARN       history   1 translation interrupted by a restart: 67 (21 blocks saved)
09:43:02            ready     http://localhost:8787  (Ctrl-C stops)
```

`grep 'history 67'` finds both the `start` and the `interrupted` line.
The `(N blocks saved)` part answers Q9: whether the checkpoints reached the database before the stop.

## 6. Error lines

The rule: one line says what failed, which run, and the cause; detail lines hold only a short tail.
No request bodies, no source text, no full stream-json.

| Failure | Line |
|---|---|
| The run fails | `ERROR #n error` with model, effort, time, `errorCode: reason`, `last_event`, and the closing fields; an `exited` error adds the stderr tail, at most 6 lines (`LOG_DETAIL_MAX_LINES`, `log.ts:8`). Unchanged apart from §3.1 |
| A checkpoint fails | `ERROR #n history  63 checkpoint failed: <message>; a crash keeps the last good one`, once per run |
| The final save fails | `ERROR #n history  63 save failed: <message>; the row stays running until a restart marks it interrupted` |
| The row cannot be saved at start | As today: `ERROR http 500 POST /translate: <message>` with the first stack frames (`src/server.ts:141`) |
| Startup marking fails | Throws, as today: the server stops at startup |

Today's `history` errors (`translation-jobs.ts:225`, `:259`) carry `#n` but not the row.
Adding the row id and the consequence lets you act without reading the code.

## 7. Practice

Adopt one part now:

- `nextRequestNumber()` in `ai-grading.ts:83` and `generation.ts:60`. It is a two-line change and fixes Q1 for every feature.

Leave the rest for when Practice is next changed:

- Its startup lines (`src/features/practice/server/routes.ts:109-112`) could list the ids, as Translate's will.
- Its closing lines already name their row (`generation N`, `attempt N`), so Q2 already holds.
- Practice has no slot limit and no unread mark, so Q3 and Q5 do not apply.

## 8. Tests

Today no test reads log output, and the design does not need a log capture.
The lines are built from pure string functions, so the tests check those.

| Test | File | Asserts |
|---|---|---|
| Closing line fields | `translation-jobs.test.ts` (new) | `formatRequestSummary` keeps today's order; adds `N checkpoints` only when N > 0; `unread` only when set; `by delete` sits where a failure would |
| Start line | same | `formatStartLine` (new, pure) gives `history N  k/5 running` and ends with `cold start` when set |
| Interrupted rows | `history-store.test.ts` | `failInterruptedTranslations` returns each running row's id and saved block count, and marks them as before |
| Interrupted line | `translation-jobs.test.ts` | `formatInterruptedLine`: the list of ids and blocks, cut after 10 with `and N more` |
| Column alignment | `src/shared/server/log.test.ts` (new) | `formatLogLine` (exported) pads level, `#n` and event so the message starts at the same column for `#1` and `#999`, `start` and `cancelled` |

Tests compare whole strings, so a change of wording is a deliberate change of the test.
No test spawns `claude` or reads `console.log`.

## 9. Implementation plan

| File | Change |
|---|---|
| `src/shared/server/log.ts` | add `nextRequestNumber()`; export `formatLogLine` for its test |
| `src/features/translate/server/translation-jobs.ts` | use `nextRequestNumber()`; `LiveTranslation` gains `checkpointCount`; `formatStartLine` (new) adds `history N  k/5 running`; `formatRequestSummary` takes `checkpointCount`, `runningCount`, `isUnread`, and the cancel cause as its `failureText` (§3.1); `formatRunningCount` (one place for `k/5 running`) and `formatInterruptedLine` (new, pure, next to the other line formatters); `saveCheckpoint` counts and names the row on failure; `finishJob` computes `isUnread` once, for the save and the line, and names the row on a failed save; `watch(res, id, isReattach)` logs `watch` for a re-attach to a live run; `cancel(id, cause)` with `cause: 'cancel' \| 'delete'`; `liveIds()` for the `429` line |
| `src/features/translate/server/history-store.ts` | `failInterruptedTranslations()` returns `{ id, blockCount }[]`, using `RETURNING id, json_array_length(blocks_json)` on the same `UPDATE`, sorted by id because `RETURNING` sets no order |
| `src/features/translate/server/routes.ts` | the interrupted line lists rows; the `429` line names live rows; the cancel route passes `'cancel'` and logs a `409`; the delete route passes `'delete'` and logs `N deleted`; `handleTranslate` calls `watch(res, id, false)`, the events route `watch(res, id, true)` |
| `src/features/practice/server/ai-grading.ts`, `generation.ts` | use `nextRequestNumber()` in place of their own counters |
| `docs/translate-internals.md` | the "Server log" example and event table follow §3 |
| tests | §8 |

Steps, each one commit that passes `npm run check`:

1. The shared counter, in all three features.
2. `history N` and `k/5 running` on `start`; the new closing fields; the cancel cause.
3. The `watch` line.
4. The interrupted list, the `429` ids, `deleted`, `409`, and the row ids in `history` errors.
5. The tests, and the internals doc.

## 10. Decision: no `leave` line

The question was whether to log `leave` (a page stops watching a live run).
Decided: no.
Every sidebar click would print a line, and it answers no question in §2: the closing line's `unread` gives the end state, and a later `watch` shows the page came back.
`watch()`'s `close` handler says so in a comment, so the line is not added back by accident.
