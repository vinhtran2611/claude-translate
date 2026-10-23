# Translate background jobs: design

Status: **built**. Phases 1 to 3 are built, with the changes listed in §13. Date: 2026-10-23.

§1 describes the code before this design; its line numbers are of that code.

## 0. Goal

A translation keeps running while you look at something else.
You can start a long document, open an older entry, start a second translation, and come back later.
The entry is then finished, or still streaming, and the page picks up where it is.
Several documents can translate at the same time, like sessions in the Claude app's sidebar.

Out of scope: a run that survives a server restart, and a queue for runs beyond the limit (§6.1).

## 1. What is true today

The page follows one run at a time, and leaving it cancels it.

| Where | What it does |
|---|---|
| `src/features/translate/web/translate.ts:86` | One `activeRequest: AbortController` for the whole page |
| `translate.ts:173` | `showHistoryEntry` aborts it, so opening an entry cancels the run |
| `translate.ts:407` | `translate()` aborts it, so a second translation cancels the first |
| `translate.ts:532` | `swapLanguages` aborts it |
| `translate.ts:584` | `clearWorkspace` aborts it, and New translation calls it (`translate.ts:641`) |
| `translate.ts:369-377` | `cancelTranslation` (Esc) is only an abort; the server learns of it from the closed connection |
| `src/features/translate/server/routes.ts:157-318` | `handleTranslate` holds the whole run in local variables of one request |
| `routes.ts:314-317` | `res.on('close')` saves the run as `cancelled` and stops `claude` |
| `routes.ts:277` | A cancelled run sends no closing event, because nobody is assumed to be listening |
| `src/features/translate/server/history-store.ts:226-229` | The output is written once, at the end (`finishTranslation`) |
| `history-store.ts:230-233` | A row left `running` by a restart becomes `failed` with `interrupted`; it keeps whatever output the row holds, today none |

So the run lives exactly as long as the HTTP connection.

Practice already does it the other way.
A grading and a generation are owned by the server and watched over SSE.
Each keeps a map of live runs with their output so far and their watchers
(`src/features/practice/server/generation.ts:32-41`, `generation.ts:56`, `src/features/practice/server/ai-grading.ts:79`).
A late watcher gets a `snapshot` event first (`generation.ts:140-158`, `ai-grading.ts:154-172`).
A watcher of a run that is no longer live gets `finished` at once and reads the saved row (`generation.ts:143-147`).
The outcome is saved before the watchers are told (`generation.ts:71-85`).
Practice has no signal handler: a stopped server leaves `running` rows, which the next start marks `interrupted`.
This design copies that pattern for Translate, and adds only Cancel and a limit.

## 2. Decision in one paragraph

A translation becomes a **job owned by the server**.
`POST /translate` saves the row, starts the job, then streams it like any other watcher.
Closing a stream only stops watching; it never stops the job.
Only an explicit **Cancel** (button, Esc, or deleting the entry) stops it, through `POST /history/{id}/cancel`.
Any page can re-attach with `GET /history/{id}/events`: it gets a `snapshot` of everything so far, then the live events.
At most 3 jobs run at once; a fourth `POST /translate` is refused with `429`, and the page says so.
While a job runs, its output is saved to SQLite at most every 5 s, so a server crash keeps all but the last few seconds.

```
 page A           page B          server
   |                |               |
   | POST /translate                |
   |------------------------------->| row 41, running
   |<-- snapshot, events... --------|
   |                |               |
   | (opens entry 17: stream closed)|
   |                |               | job 41 runs on
   |                |               |
   |                | GET /history/41/events
   |                |-------------->|
   |                |<-- snapshot --| all so far
   |                |<-- deltas ----| then live
   |                |<-- done ------|
```

## 3. Job lifetime

### 3.1 The jobs module

A new file `src/features/translate/server/translation-jobs.ts` owns every live run.
The body of `handleTranslate` (`routes.ts:178-317`) moves into it, nearly unchanged.
The spare-process code (`routes.ts:75-122`) stays in `routes.ts`.
`createTranslationJobs({ historyStore, takeClaudeProcess, noteClaudeResult })` gets it passed in, so nothing moves and nothing imports `routes.ts`.
`noteClaudeResult` clears the spare's "failed before use" warning on any result, as `onResultMessage` did in `routes.ts`.

```ts
export interface TranslationJobs {
  // Saves the row and starts the run; the row's id. The caller checks
  // isFull() first. Throws when the row cannot be saved.
  start(request: TranslateRequest): number;
  // True when MAX_RUNNING_TRANSLATIONS jobs are live.
  isFull(): boolean;
  // The one rule for "is this run live": it is in the live map.
  isLive(translationId: number): boolean;
  // Streams a run to one page: snapshot, live events, closing event.
  // A run that is not live gets `finished` and the stream ends.
  watch(res: ServerResponse, translationId: number): void;
  // Stops a live run and saves it as cancelled. false when it is not live.
  cancel(translationId: number): boolean;
}
```

One live run in memory:

```ts
interface LiveTranslation {
  id: number;
  request: TranslateRequest;
  requestNumber: number;              // the log's #n
  startedAt: number;                  // Date.now() at start
  output: TranslationOutput;          // blocks, textOutsideBlocks, thinkingText, thinkingDurationMs
  notice: RunNotice | null;           // the latest retry or fallback (§5.2)
  lastSavedAt: number;                // Date.now() of the last checkpoint, startedAt at first
  hasCheckpointFailed: boolean;       // a failed checkpoint is logged once per run
  run: Run | null;                    // from runClaude; null only until it returns
  firstTextMs: number | null;         // for the closing log line, as before
  outputTokens: number | null;
  watchers: Set<ServerResponse>;
}
```

`run` is `Run | null` because the handlers passed to `runClaude` close over `live`, so `live` exists before `runClaude` returns; `runClaude` calls no handler before then (§5.1).

`TranslationOutput` is the object at `routes.ts:187`, given a name.
The slots in use are the live map's size; there is no separate counter to keep in step.
`finishTranslation` (`routes.ts:235-282`) becomes `finishJob(live, outcome, error)`.
It keeps its guard against a second call (`routes.ts:238`), now the one rule: it returns when `isLive(live.id)` is false.
It saves the row, removes the job from the live map, tells every watcher, then ends their streams.

A save failure at the start is no longer only logged (`routes.ts:204-206`).
A job is keyed by its row id, so `start` throws, nothing starts, and the entry file's catch-all answers `500` and logs it as an `http` error with its stack frames (`src/server.ts`).
`translationId` in `done` and `error` therefore becomes `number`, never `null`.

### 3.2 What starts and stops a job

| Action | Today | With jobs |
|---|---|---|
| Translate | aborts the previous run, starts one | starts a new job; the previous one keeps running |
| Open another entry | cancels the run | stops watching; the job keeps running |
| New translation, Clear | cancel the run | stop watching; the job keeps running |
| Swap ⇄ | cancels the run | stops watching; the job keeps running |
| Reload, close the tab | cancels the run | the job keeps running |
| Esc, **Cancel** button | abort, the server sees the close | `POST /history/{id}/cancel` |
| Delete the entry | deletes the row | cancels the job first, then deletes the row |
| Server stops | the row becomes `interrupted` on the next start | the same, and the row keeps its last checkpoint (§4.1) |

While the page follows a live run, its source text box is read-only and Translate is disabled.
Two reasons, both about one rule ("the right panel shows one entry"):

- Without it, ⌘Enter or a second click on Translate would start a duplicate job of the same text, since Translate no longer replaces the run.
- Typing would make a draft whose target pane still shows another entry's live output; the input handler (`translate.ts:546-560`) has no state for that.

To translate something else, you click **New translation**.
A **Cancel** button (`#cancel-button`) shows beside Translate while the run is live.
It is also the only way to cancel on a touch screen, which has no Esc (`translate.ts:82`).

### 3.3 The page's side

`activeRequest` (`translate.ts:86`) becomes `followedRun`:

```ts
// The one run the page is watching; null when the page shows no live run.
let followedRun: FollowedRun | null = null;

interface FollowedRun {
  translationId: number | null;   // null only until a new run's snapshot names its row
  stream: AbortController;
  startedAt: number;              // from the snapshot's elapsedMs
  requestedModelId: string;       // for the "sent nothing back" alert
  unpairedText: string;           // text outside pairs, as before
  retryNote: string;              // the status line's retry or fallback note, as before
}
```

The page's rule for "the shown run is live" is `followedRun !== null`.
Esc, Cancel, the read-only box and the disabled Translate all read it.
`followedRun` is set the moment Translate is pressed, so a second ⌘↵ during the POST is refused; its `translationId` is `null` until the snapshot arrives, and Esc in that moment does nothing.
The per-run fields that were local variables of `translate()` live on it, so they end with the run.

| New function | Replaces | Does |
|---|---|---|
| `startTranslation()` | `translate()` (`translate.ts:402`) | POST /translate, then `followRun` on the reply body |
| `openLiveRun(translation)` | nothing | shows the entry's text and direction, then GET /history/{id}/events and `followRun` |
| `followRun(id, openStream)` | the read loop (`translate.ts:507-515`) | sets `followedRun`, reads events with `readStreamEvents` |
| `handleRunEvent(run, event)` | `handleStreamEvent` (`translate.ts:446-494`) | as before, plus `snapshot`, `cancelled` and `finished` |
| `stopFollowing()` | every `activeRequest.abort()` | aborts the stream only; the server keeps the job |
| `cancelShownRun()` | `cancelTranslation` (`translate.ts:369`) | POST /history/{id}/cancel; the `cancelled` event updates the page |
| `showSavedRun(run)` | nothing | GET /history/{id} once and shows it as stored: after `finished`, or a stream that ended without a closing event (§5.4) |

`handleRunEvent` stays in `translate.ts`, not in a new `web/run-stream.ts`: it calls a dozen of the page's own functions (`renderTarget`, `setThinking`, `setViewMode`, the alerts, the Practice button), so a separate module would need them all passed in, or a circular import of the page's entry module.
What it read from the request (the text, the requested model) it reads from the snapshot's `translation`, or from the source box, which is read-only while followed.
`openLiveRun` takes the `Translation` the sidebar already read, not only its id.

Opening a sidebar entry still calls `GET /history/{id}`.
When its `run.status` is `running`, the page calls `openLiveRun(translation)` instead of `showHistoryEntry`.

## 4. Persistence

### 4.1 Saving output as it arrives

The run rules already allow a `running` row to hold "none yet, or partial" output (`docs/data-model-proposal.md:127-131`).
So saving progress needs no new column.

```ts
// history-store.ts
// Saves what a running run has produced so far; a row no longer running is left as it is.
saveProgress(id: number, progress: TranslationProgress): void;
```

```sql
UPDATE translations
SET blocks_json = $blocks_json,
    text_outside_blocks = $text_outside_blocks,
    run_served_model_id = $run_served_model_id,
    run_thinking_text = $run_thinking_text,
    run_thinking_ms = $run_thinking_ms,
    updated_at = $now
WHERE id = $id AND run_status = 'running'
```

One rule decides when, with no timer:
after the job folds an output event into `live.output`, it calls `saveProgress` if `CHECKPOINT_INTERVAL_MS` (5,000) has passed since `live.lastSavedAt`.
`finishJob` writes the final row as today, so the last stretch is never left to a checkpoint.

| Constant | Value | Why |
|---|---|---|
| `CHECKPOINT_INTERVAL_MS` | 5,000 | Bounds the loss on a crash to a few seconds of text, at one write per 5 s |

A run that streams nothing writes nothing, and there is no timer to clear.
A crash loses the text since the last write: at most 5 s, plus a gap with no events (up to 60 s, `STREAM_STALL_TIMEOUT_MS`, `src/shared/server/claude-runner.ts:38`).
Each write rewrites `blocks_json` whole.
For the largest input (100,000 chars, `routes.ts:30`) that is about 230 KB per write: the source restated plus the translation.
At one write per 5 s, a 10-minute run writes about 28 MB in total, in a few milliseconds per write.
`PRAGMA synchronous = FULL` (`src/shared/server/sqlite.ts:17`) makes each write durable.
A failed checkpoint is logged once per run and does not stop the job.

A side effect is welcome: the sidebar's output preview (`history-store.ts:240-243`) now works for a running row too.

### 4.2 Schema

Phases 1 and 2 need no schema change.
`RunStatus` keeps its four values; there is no `queued` (§6.1).

Phase 3 (the unread dot, decided yes in §11) needs schema 6, one added column:

```sql
ALTER TABLE translations
  ADD COLUMN is_unread INTEGER NOT NULL DEFAULT 0
  CHECK (is_unread IN (0, 1))
```

No CHECK on an existing column changes, so there is no table rebuild.
`CREATE_TABLES` (`history-store.ts:19-32`) gains the same column for a new file, from one constant (`IS_UNREAD_COLUMN`) that the `ALTER TABLE` uses too.
It is placed last among the columns, after `updated_at`, where `ADD COLUMN` puts it, so a migrated file and a new one have the same column order.

`migrate` (`history-store.ts:150-160`) must then branch, not fall through.
Today every older file ends in `migrateFrom4`, which builds the table from `CREATE_TABLES`.
That table would already have `is_unread`, so a following `ADD COLUMN` would fail.
So: a file at 5 runs the `ALTER TABLE`; a file at 1 to 4 runs the old steps and `migrateFrom4`, which now builds schema 6 directly.
`openDatabase` already backs the file up and runs this in one transaction (`sqlite.ts:22-43`).

| Change | Where |
|---|---|
| `is_unread` | `translations`; 1 when the run ended with no watcher (§7.2) |
| `TranslationSummary.isUnread: boolean` | `src/features/translate/api-types.ts:95` |
| `markRead(id)` | `history-store.ts` |

### 4.3 Rejected: an event log table

A `translation_events (translation_id, seq, name, data_json)` table would allow an exact replay from any offset.
A long document produces tens of thousands of small deltas, so it means tens of thousands of rows per run, and a cleanup job.
The blocks already are the folded state of those events.
A snapshot of the blocks is enough for every reader (§5).

## 5. Reconnect protocol

### 5.1 Snapshot, then the live tail

Every stream of a live run, new or re-attached, has the same shape:

```
snapshot          everything so far
(live events)     block_start, source_delta, ...
done | error | cancelled
```

A stream of a run that is not live is one event, `finished`, as in Practice.
The page then reads `GET /history/{id}` and shows the entry as a stored one.

`POST /translate` is `start` followed by `watch` on the same response.
So the page has one code path for a new run and an old one, and the first event tells it the new row's id.

`watch` builds the snapshot from `live.output` and adds the watcher in the same synchronous step.
This needs no event ids, and the claim holds, for three reasons checked in the code:

| Why | Where |
|---|---|
| Node runs one callback at a time, so no `claude` stdout chunk is handled between the two | `claude-runner.ts:365-380` |
| `live.output` is folded from exactly the events sent to watchers, in the same call | `routes.ts:211-230` |
| `runClaude` calls no handler before it returns; it only spawns and adds listeners, so `start` then `watch` misses nothing | `claude-runner.ts:398` |

Text the pair parser holds back (`src/features/translate/server/pair-stream-parser.ts:15-16`) is in neither the snapshot nor any event yet.
It reaches every watcher later as ordinary events, so the page never needs it.

One guard is needed: `watch` returns at once when `res` is already closed.
A page can close its `POST /translate` while the body is still being read; its `'close'` has then fired, and the watcher would stay in the set until the job ends.

### 5.2 New and changed events

Added to `StreamEvents` (`src/features/translate/api-types.ts:54-68`):

```ts
snapshot: {
  translation: Translation;    // the row, with the output so far
  notice: RunNotice | null;    // the latest retry or fallback
  elapsedMs: number;           // since the job started
};
cancelled: { durationMs: number; translationId: number };
finished: {};                  // not live: read GET /history/{id}
```

`RunNotice` is `{ kind: 'retry', attempt, maxRetries, error }` or `{ kind: 'fallback', fromModelId, toModelId }`.
Without it, a page that re-attaches during a retry would show "Translating…" instead of "API busy, retry 2/3…".
The server clears it by the page's own rule: the next block or outside-text event (`translate.ts:450`, `translate.ts:458`).

`done` and `error` keep their data, with `translationId: number`.
`cancelled` is new as a closing event: today nobody is listening when a run is cancelled (`routes.ts:277`), but now another tab may be.

The page applies a snapshot with the existing pieces.
It replays the blocks through `applyBlockEvent` (`src/features/translate/web/pairs-view.ts:128`), as `renderStoredBlocks` (`pairs-view.ts:158`) does, but without its closing `setStreamingCell(null)`.
So the last block stays the streaming cell, and the deltas after it go through `applyBlockEvent` as today.
Then `setThinking` with the snapshot's thinking text.

### 5.3 Endpoints

| Method and path | Reply | Errors |
|---|---|---|
| `POST /translate` | `200` SSE: `snapshot`, events, closing event | `400` as today; `429` with the plain-text reason; `500` when the row cannot be saved |
| `GET /history/{id}/events` | `200` SSE: the same shape, or `finished` | none: an unknown id is not live, so `finished`, and `GET /history/{id}` then answers `404` |
| `POST /history/{id}/cancel` | `204` | `409` with the body `not_running` when it is not live |
| `DELETE /history/{id}` | as today; cancels a live run first | `404` |
| `GET /history/{id}` | unchanged: the saved row; a running row's output is at most one checkpoint old | `404` |
| `POST /history/{id}/read` | `204`, clears `is_unread` (phase 3) | `404` |

`GET /history/{id}` needs no live overlay.
A page that wants the live output of a running row opens its events, whose snapshot comes from memory.

`POST /history/{id}/read` is a POST because it changes a row.
Marking a row read inside `GET /history/{id}` would let a curl or an agent clear the dot.

`readStreamEvents` (`src/features/translate/web/stream-events.ts:13`) stays as it is.
It needs no keep-alive comments: today's streams already stay open for minutes with gaps of up to 60 s (`STREAM_STALL_TIMEOUT_MS`).

### 5.4 When a stream ends without a closing event

That only happens when the server stops.
The page then calls `GET /history/{id}` once and shows what it says, usually `interrupted` after the restart.
If the server cannot be reached, it shows today's `server_unreachable` alert.
It does not retry in a loop: a stopped server cannot resume the run (§7.1).

## 6. Concurrency

### 6.1 The limit

| Constant | Value | Why |
|---|---|---|
| `MAX_RUNNING_TRANSLATIONS` | 3 | The subscription quota is the real limit. It matches the gateway's limit (`docs/llm-gateway-design.md` §5 step 3, Q2) |

`POST /translate` checks `jobs.isFull()` after validating the body and before writing any header.
When it is full, it answers `429` with a plain-text reason, as the `400`s do (`routes.ts:124-127`): "3 translations are already running. Wait for one to finish, or cancel one."
The page shows that reason in a warning alert, "Too many translations at once", so the number lives only on the server.

A slot belongs to a job, not to a process.
A fallback spawns a second process inside `runClaude` (`claude-runner.ts:270`) and stops the first, so it needs no new slot.

Why refuse instead of queue:
a queue needs a `queued` run status in every feature's CHECK (a table rebuild), queue-position events, a "started" event, a queued mark, a restart rule for queued rows, and a spare that guesses the next job's settings.
That is about half of the draft design, for the rare fourth document.
The gateway already plans "wait for a free slot" for every feature (`docs/llm-gateway-design.md` §5 step 3), so a queue belongs there, once.

```
 POST /translate
       |
       v
 body valid? --no--> 400
       |
       v
 jobs full? --yes--> 429 too_many_running
       |
       v
 save row --fails--> 500
       |
       v
 takeClaudeProcess, runClaude
       |
       v
 watch(res): snapshot, events
       |
       v
 finishJob: save, unmap, tell, end
```

### 6.2 The warm spare and fallback

Unchanged.
There is still one spare process (`routes.ts:77`).
Its settings are fixed at spawn, so it only helps a job with the same model, effort and source format (`routes.ts:104-111`).
Jobs that start close together with the same settings each take the spare just spawned for them, as today.
A prompt edit restarts the spare, as today (`routes.ts:114-122`).

### 6.3 Practice runs and shared code

Practice gradings and generations do not count against these slots.
They use the same quota, so a shared limit is the gateway's job (Q5).

The live-run registry is now written three times: `ai-grading.ts:79`, `generation.ts:56`, and this module.
The common part is small: the map, `tell`, ending the watchers, and `watch`'s headers and watcher bookkeeping, about 30 lines.
The snapshots and closing events differ in shape per feature.
A shared helper is worth it **later, with the gateway** (`docs/llm-gateway-design.md` §5, step 4), which is the planned single registry.
A helper now would be replaced by it.
Until then `translation-jobs.ts` keeps Practice's shape and names (`start`, `watch`, `finish` saves before it tells), so that step is mechanical.

## 7. Failure cases

### 7.1 Server restart mid-run

The `claude` processes are children of the server, so a stopped server cannot resume a run.
One rule covers every way the server stops, as in Practice:
the rows stay `running`, and the next start runs `failInterruptedTranslations` (`routes.ts:341`), which marks them `failed` / `interrupted`.
That statement leaves `blocks_json` alone (`history-store.ts:230-233`), so each row keeps its last checkpoint.

There is no SIGINT or SIGTERM handler.
A handler that saves every run with all its output cannot be made reliable:
Ctrl-C sends SIGINT to the whole process group, so the `claude` children get it too.
Node may handle a child's `'close'` before the server's own signal handler runs, and `runClaude` then reports `exited` (`claude-runner.ts:387-395`).
A shutdown flag set inside the handler does not help when that `'close'` comes first.
Without a handler, Node exits at once, no run is saved as `exited`, and the restart rule applies.
The cost is at most one checkpoint interval of text per run.

### 7.2 Other cases

| Case | Behaviour |
|---|---|
| `claude` crashes | Unchanged: `runClaude` reports `exited` (`claude-runner.ts:387-395`). `finishJob` saves it, tells the watchers, and frees the slot |
| Two tabs on one run | Both are watchers and get the same events. Cancel in either reaches both as `cancelled`. Only the tab that started it gets its stream from `POST /translate`; the other attaches with `GET .../events` |
| Two tabs, different runs | Each sidebar learns of the other's runs by polling (§8.1) |
| Cancel after the run ended | `finishJob` already removed it from the live map, so the endpoint answers `409 not_running` and the row keeps its outcome. `run.stop()` sets `isFinished` (`claude-runner.ts:402-405`), so no handler fires after a cancel either |
| Run ends between a page's `GET /history/{id}` and its `GET .../events` | The events answer `finished`; the page reads the row again and shows it as stored |
| Delete a live entry | The sidebar's 5 s Undo (`src/features/translate/web/history-sidebar.ts:239-251`) still applies; the job runs on meanwhile. When the DELETE is sent, the server cancels the job and then deletes the row |
| The final save fails | Logged, as today (`routes.ts:258-260`). The row stays `running` in the database while the job has left the live map. Its events answer `finished`, the page shows the row's last checkpoint, and the next start marks it `interrupted` |
| Unread (phase 3) | `finishJob` sets `is_unread = 1` when `live.watchers.size === 0`. A run you watched finish is never unread. `failInterruptedTranslations` also sets it, so the sidebar points at runs a restart cut short |
| Very long document | 100,000 chars (`routes.ts:30`), about 10 minutes at the logged rate (23,029 chars in 144.5 s, `docs/translate-internals.md`, "Server log"). Memory: a few hundred KB per job. A snapshot is about 230 KB, which the replay already draws for a history entry of that size. Checkpoints: §4.1. Timeouts are unchanged |
| A quota rejection | Each running job fails as it would alone, with today's quota alert. Nothing waits, so nothing else fails with it |

### 7.3 The server log

| Event | Change |
|---|---|
| `start` | Unchanged, logged when the job starts |
| `cancelled` | Now means Cancel, Esc or a delete. A page that only stops watching logs nothing |
| `history` | Also covers a failed checkpoint save, logged once per run |
| `http` | `429 POST /translate: 3 translations running`, as a warning, like the `400` line (`routes.ts:125`) |

## 8. UI

### 8.1 The sidebar

Each row shows one mark, in this order of priority:

| State | Mark | aria-label suffix | Tooltip adds |
|---|---|---|---|
| running | pulsing accent dot, `.history-running-mark` (still under `prefers-reduced-motion`) | "(translating)" | "Translating · 2m 14s" |
| unread (phase 3) | solid accent dot, `.history-unread-mark` | "(new)" | "Finished while you were away" |
| partial | amber dot, the existing `.history-partial-mark` (`history-sidebar.ts:104-109`) | "(partial)" | " · partial", as today |

An unread failed run shows the unread dot first.
Once it is opened, it shows the amber dot as before.
`createHistoryItem` (`history-sidebar.ts:88`) picks the mark from `summary.run.status` and `summary.isUnread`.

While the sidebar is open and any listed row is running, it calls `loadHistory` every `HISTORY_POLL_MS` (3,000).
One list read is one query on a local file, and the running mark and preview then lag by at most 3 s.
The page also calls `loadHistory` on every closing event of the run it follows, as it does today on `done` (`translate.ts:479`).
It calls it on the snapshot too, so a new run is listed, with its running mark, as soon as it starts: without that, a docked sidebar with no running row would not poll, and the new run could not be found there after leaving it.
The poll stops when the sidebar closes, and after a failed read until the next load.
The elapsed time in the tooltip and in the status line is worded by one helper, `formatElapsed` (`src/shared/web/ui.ts`): "8s", then "2m 14s".

### 8.2 The right panel for a live entry

| Shown entry | Source box | Target | Status line (`#run-info`) | Buttons |
|---|---|---|---|---|
| running, no output yet | its text, read-only | skeleton bars, live thinking if any | `Thinking… 8s` or `Translating… 8s` | Translate disabled, Cancel |
| running, with output | its text, read-only | the pairs so far, caret on the last cell | `Translating… 2m 14s · Esc to cancel` | Translate disabled, Cancel |
| finished | as today | as today | as today | as today |

The elapsed time comes from `snapshot.elapsedMs`, then the page's own one-second timer (`translate.ts:497`).
When a run ends while it is shown, the page does what it does today on `done` (`translate.ts:475-485`): the source check, the Practice button, the history refresh.
On `cancelled` it does what `cancelTranslation` does today (`translate.ts:373-376`).
Opening a finished unread entry calls `POST /history/{id}/read` (phase 3); the sidebar does it, since it holds the summary's `isUnread`, and clears the dot at once.
Edit stays disabled while it is live, as it is today during a run (`translate.ts:295`).

## 9. Alternatives considered

| Option | For | Against | Verdict |
|---|---|---|---|
| **A. Keep request-scoped, just stop aborting.** The page keeps several fetches open and draws only the shown one | Smallest change | A reload or a closed tab still kills every run. The page must keep state for runs it does not show. A second tab sees nothing | Rejected |
| **B. Jobs in the server process, SQLite rows, SSE snapshot + tail** | The pattern Practice already uses. One process to run. Survives reloads and tab switches | A server restart still ends the runs | **Recommended** |
| **C. A separate worker process** that owns the `claude` children | Runs survive a server restart | Two processes to start and supervise. Both write one SQLite file, so it needs WAL mode and locking care. IPC for the live stream. Much more code for a one-user app that restarts rarely | Rejected for now |
| **D. A persisted job queue polled by workers** | Survives anything | The same costs as C, plus polling latency | Rejected |

| Beyond the limit | For | Against | Verdict |
|---|---|---|---|
| **Refuse with `429`** | No new status, no schema change, nothing to restart or pause | The fourth document waits for you, not for a slot | **Recommended** |
| A FIFO queue in memory | Start many and walk away | A `queued` status and a table rebuild, two more events, a queued mark, restart and quota rules for waiting jobs | Later, in the gateway |

| Transport | For | Against | Verdict |
|---|---|---|---|
| **SSE, snapshot on every connect** | One code path for new and old runs. No event log to keep. Fits `readStreamEvents` as it is | A re-attach resends up to ~230 KB | **Recommended**: re-attaching is a human action, and loopback is fast |
| SSE with event ids and `Last-Event-ID` | Resends only what was missed | Needs an in-memory log of every delta per job, or §4.3's table | Not needed: the snapshot is cheap |
| Polling `GET /history/{id}` | No streaming code | Choppy text, and a long document resends 230 KB every second | Used only for the sidebar list |
| A live sidebar stream (`GET /history/events`) | No polling | One more stream type and event set, for a list that 3 s polling already keeps fresh | Rejected |
| WebSocket | Two-way | Node has no built-in WebSocket server; the repo has no dependencies | Rejected |

## 10. Phases

Each phase ships on its own and leaves the app working.
Tests run with `npm test` (`node --test "src/**/*.test.ts" "test/**/*.test.ts"`, `package.json`).
Integration tests use the fake `claude` in `test/helpers/fake-claude/claude`.
Its `FAKE:stream=` scenario streams a reply 250 ms per piece, and `FAKE:stall` sends one token and then nothing.
`FAKE:retry` (added for the retry test) reports one API retry and then sends nothing.

### Phase 1: server-owned jobs, re-attach and cancel

The server and the page change together: with the old page, Esc would no longer cancel.
No schema change.

- `translation-jobs.ts` as in §3.1, with `takeClaudeProcess` passed in.
- `res.on('close')` (`routes.ts:314`) only removes the watcher.
- `POST /translate`: the limit check, `500` on a failed save, then a `snapshot` event (it carries the new id), then the stream as today.
- `GET /history/{id}/events` with the snapshot + tail of §5, and `finished` for a run that is not live.
- `POST /history/{id}/cancel`, and the `cancelled` closing event.
- `DELETE /history/{id}` cancels a live run first.
- Page: `followedRun`, `stopFollowing` at the four abort sites, `openLiveRun` from the sidebar, Esc and `#cancel-button` call `cancelShownRun`. `web/run-stream.ts`.
- Page: the read-only source box and disabled Translate while following (§3.2); the `429` alert.
- Sidebar: the running mark, and polling while a listed row is running (§8.1).
- Update `docs/translate-internals.md`: the API, the "Closing the request" paragraph (`docs/translate-internals.md:202-203`), the `cancelled` log line.

Tests (`test/integration/translate-server.test.ts`):

- Closing the stream after the first event does not stop the run: the row ends `succeeded` with every block.
- The first event is `snapshot`, with the row's id and status `running`.
- A watcher that joins midway (`FAKE:stream`) gets a snapshot, then the rest. The snapshot's blocks plus the later deltas equal the full reply.
- Two watchers both get `done`. A cancel reaches the other watcher as `cancelled`.
- Watching a finished run, or an unknown id, gives one `finished` event, then the stream ends.
- Watching during a retry: the snapshot's `notice` is the retry.
- `POST /history/{id}/cancel` on a `FAKE:stall` run: the row is `cancelled` with its partial blocks, and the stream ends with `cancelled`.
- Cancel of a finished run, or of an unknown id, is `409 not_running`.
- A fourth run while three `FAKE:stall` runs go is `429`, and no row is saved for it.
- Deleting a live run stops its process and removes the row.

### Phase 2: checkpoints

No schema change: it writes existing columns.

- `saveProgress` (§4.1), called from the job's fold step under the `CHECKPOINT_INTERVAL_MS` rule.

Tests:

- `history-store.test.ts`: `saveProgress` writes a running row and ignores a finished one; `failInterruptedTranslations` keeps the saved blocks.
- Integration: a `FAKE:stream` reply that lasts longer than one interval; kill the server with SIGKILL after 6 s, start it again; the row is `interrupted` with its partial blocks.

### Phase 3: the unread dot (schema 6)

Built: the open question in §11 was answered yes.

- Schema 6 (§4.2): `is_unread` by `ALTER TABLE`, `markRead`, `isUnread` in the summary.
- `finishJob` and `failInterruptedTranslations` set it; `POST /history/{id}/read` clears it.
- The unread mark in the sidebar; opening an unread entry marks it read.

Tests:

- `history-store.test.ts`: a schema 5 file migrates to 6 with the same rows, ids and sequence, after a backup; a schema 4 file migrates straight to 6. `is_unread` is set and cleared.
- Integration: a run that ends unwatched is unread; `POST .../read` clears it; a run watched to the end is not unread.

## 11. Decisions

**Q1. How many translations at once?**
3 (`MAX_RUNNING_TRANSLATIONS`).
It is the gateway's number, so the two limits agree when the gateway takes over, and a fourth is refused, not lost.

**Q2. Should Clear and New translation cancel a run the page is showing?**
No: they only stop watching.
Cancel is the one way to stop a run, so a click meant to start fresh never throws away a long run; the run stays in the sidebar.

**Q3. Esc cancels a long background run with one key. Keep it?**
Keep Esc, with no confirmation.
Esc only cancels the run on screen, as today, and a cancelled run keeps its partial output; a 30 s threshold and a dialog would be a special case for one key.

**Q4. After a restart, should queued runs that never started start again?**
There is no queue, so nothing waits.
Interrupted runs are never restarted automatically: a run that spends quota by itself after a restart would surprise you, and Translate again is one click.

**Q5. Do Practice gradings and generations share the 3 slots?**
No, not in this design.
A shared limit belongs in the gateway, the planned single place for runs; a cross-feature counter now would be a second copy of it.

**Q6. On a quota rejection, should the queue pause instead of failing every waiting job?**
Moot: with no queue, no job waits, so a rejection fails only the jobs already running, each with today's quota alert.
Pausing belongs with the gateway's slot wait.

**Q7. Is the unread dot enough, or do you also want a browser notification or a count in the tab title?**
No notification and no title count.
The running mark already shows what is in flight, and the unread dot (Q8) points at what finished while you were away.

**Q8. Do you want the unread dot (phase 3)?**
Yes (decided 2026-10-23).
A run that finished while no page watched it keeps a dot until you open it, for one column, one endpoint and one mark.
Without it, a finished run would simply lose its running mark, and you would find it as the newest row.

## 12. Review notes

| Change | Why |
|---|---|
| Removed the FIFO queue, `queued` status, `queue_position` and `run_started` events, queued mark, sidebar-button count, and the "spare follows the next queued job" rule; a fourth run gets `429` | About half the design served the rare fourth document. The gateway already plans a slot wait for every feature, so the queue is built once, there |
| Schema 6 is one `ALTER TABLE ADD COLUMN`, not a table rebuild, and only for the optional unread dot | The rebuild was needed only to add `queued` to a CHECK. Noted the `migrate` fall-through that would break an `ADD COLUMN` after `migrateFrom4` |
| Checkpoint: a throttle in the fold step (`CHECKPOINT_INTERVAL_MS`), no trailing timer, no `thinking_done` / `fallback` triggers, no test-only env var | One rule instead of four triggers and a timer to clear; the test streams past one interval instead |
| Removed the SIGINT/SIGTERM handler, `Feature.stop()`, `stopAll` and `isShuttingDown` | The flag cannot win the race when a child's `'close'` is handled before the signal handler. One restart rule, as Practice has, keeps the last checkpoint |
| Removed `liveTranslation` and the live overlay in `GET /history/{id}` | The events' snapshot already gives the live output; one way to read a live run |
| Not live: one `finished` event, as Practice does, instead of a database snapshot plus a rebuilt closing event | Reuses Practice's pattern and the existing stored-entry path; no closing event to reconstruct from a row |
| Added `isLive(id)` (the live map) as the one server rule, and `followedRun !== null` as the one page rule | The draft decided "live" in several places (row status, queue, `isTranslating`) |
| The spare-process code stays in `routes.ts` and is passed in | Moving it bought nothing; passing it avoids a circular import |
| Confirmed the "no event ids" claim, with the three reasons in §5.1, and added the closed-`res` guard in `watch` | The claim holds; a watcher added to an already-closed response would leak until the job ends |
| A failed save at the start answers `500`; `translationId` is never `null` | A job is keyed by its row id; today's "log and run on" (`routes.ts:204-206`) has no id to key on |
| Kept the read-only source box, with the reason restated | Without it, ⌘Enter or Try again starts duplicate jobs of the same text, now that Translate no longer replaces the run |
| Cancel button beside Translate, not in its place | Translate is disabled while following anyway; touch screens have no Esc |
| Merged phases 1 and 2; removed phase 5 (live sidebar SSE) | Phase 1's static "still translating" view was throwaway work. 3 s polling of one local query keeps the sidebar fresh |
| Shared job helper: later, with the gateway | About 30 common lines; the gateway is the planned single registry and would replace a helper written now |
| Fixed citations: the sidebar delete is `history-sidebar.ts:239-251`; `FAKE:stall` sends one token, then nothing | Checked against the code |

## 13. As built

Where the code differs from the reviewed design, and why. The sections above are updated to match.

| Change | Why |
|---|---|
| No `web/run-stream.ts`; `handleRunEvent` stays in `translate.ts` (§3.3) | It drives a dozen of the page's own functions; a module of its own would need them all passed in, or a circular import of the entry module |
| `followedRun.translationId` is `number \| null`, and the record also holds the run's start time, requested model, outside text and retry note (§3.3) | Translate must be blocked from the click on, before the snapshot names the row; the per-run fields were `translate()`'s locals |
| `openLiveRun(translation)` takes the row the sidebar read (§3.3) | It needs the text and direction before the snapshot arrives, and the sidebar has just read them |
| `LiveTranslation.run` is `Run \| null`; `createTranslationJobs` also takes `noteClaudeResult` (§3.1) | The handlers close over `live`, so it exists before `runClaude` returns; the spare's warning flag lives in `routes.ts` |
| A failed save at the start throws to the entry file's catch-all, which answers `500` (§3.1) | One place already answers and logs an unexpected failure |
| `429` and `409` carry plain text, with no separate error code (§5.3, §6.1) | Translate's endpoints answer in plain text, as the `400`s do; the page tells them apart by status |
| The page reloads the sidebar on the snapshot too (§8.1) | Otherwise a new run is not listed until it ends, and cannot be re-opened from the sidebar |
| The status line and tooltip word elapsed time as "2m 14s" with one helper, `formatElapsed` (§8.1, §8.2) | The design's examples use minutes; the old line counted seconds only |
| `is_unread` is the last column in `CREATE_TABLES` (§4.2) | `ADD COLUMN` puts it last in a schema 5 file, so both read the same; a test compares the two column lists |
