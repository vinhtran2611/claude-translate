# LLM gateway: one way to call an LLM, for every feature

Status: **proposal for review**. Nothing here is built yet. Date: 2026-10-19.

## 0. What this design is about

Today two features call `claude -p`: Translate (`server/server.ts:290-470`) and Practice grading
(`src/features/practice/server/ai-grading.ts`). Each one builds its own prompt, checks the model and effort itself, streams to
the page in its own way, and saves the result in its own way. The shared file `src/shared/server/claude-runner.ts` **is**
`claude -p`: it starts the process and reads the CLI's own JSON lines.

This design adds **one layer, the LLM gateway**. Every LLM call in the app goes through it. A feature says **what** it
wants ("run the task `practice.grade` with this input"). The gateway does the **how**: the backend, the model, fallback,
timeouts, streaming, logging and saving.

Result:

- To change the backend (CLI → Anthropic API → a fake for tests), you change **one** place.
- To add an LLM feature, you write **one** small task object and **one** prompt file.
- Every LLM call the app makes is in **one** table.

## 1. Design rules

These rules decide every interface below:

1. **Few parts, one job each.** Provider, Task, Gateway, Record. Nothing else.
2. **Small interfaces.** Each one has at most 5 members. If something can be computed, it is not a parameter.
3. **One way to do each thing.** For example, there is no `run()` next to `start()`, and no "cancel when unwatched"
   flag next to `cancel()`.
4. **Plain names.** `text`, `thinking`, `ok`, `error`. No backend words (`content_block_delta`, `stream_event`) outside the
   backend's own file.
5. **Errors are values for callers.** A run's `result` never throws. You read `ok` and then `output` or `error`.

---

## 2. The picture

```
 Page / curl / agent
        │ HTTP
        ▼
 Features (Translate, Practice, …)        /api/llm  (same gateway, for outside callers)
        │                                    │
        └──────────── llm.start(task, input) ┘
                          │
                          ▼
 ┌────────────────────────────────────────────────────────────┐
 │ Gateway (src/shared/server/llm/)                           │
 │  check settings → queue → stream with fallback → save run  │
 └───────────────────────────┬────────────────────────────────┘
                             │ provider.stream(request, signal)
                             ▼
          claude-cli (today)   ·   anthropic-api (later)   ·   fake (tests)
```

---

## 3. The provider: the only part that knows the backend

```ts
// src/shared/server/llm/provider.ts

export interface LlmRequest {
  model_id: string;
  effort: Effort;            // 'low' | 'medium' | 'high'
  system: string;            // the system prompt
  user: string;              // the user message
}

export type LlmEvent =
  | { type: 'thinking'; text: string }    // a piece of the thinking summary
  | { type: 'text'; text: string }        // a piece of the reply
  | { type: 'retry'; message: string }    // the backend is retrying; for the page and the log
  | { type: 'end'; input_tokens: number | null; output_tokens: number | null };

export interface Provider {
  name: string;   // 'claude-cli', 'anthropic-api', 'fake'
  // Streams the reply. The last event is 'end'. On failure it throws an LlmError.
  // Aborting the signal stops the backend and throws an LlmError of kind 'cancelled'.
  stream(request: LlmRequest, signal: AbortSignal): AsyncIterable<LlmEvent>;
}

export class LlmError extends Error {
  constructor(
    readonly kind: 'timeout' | 'output_limit' | 'backend' | 'cancelled',
    message: string,
  ) { super(message); }
}
```

That is the whole contract: **4 request fields, 4 events, 1 method, 4 error kinds.**

Why each choice:

| Choice | Why |
|---|---|
| `AsyncIterable` + `AbortSignal` | You read it with `for await`, stop it with the signal, and errors are normal exceptions. A fake provider is a few lines. Today's 8 callbacks (`claude-runner.ts:176-187`) go away. |
| One `user` string, not a list of messages | Every call today has exactly one user message. A list can be added later without breaking anyone. |
| No `thinking_done` event | The gateway knows thinking is over when the first `text` arrives. Fewer events for each backend to get right. |
| Rate-limit quota is not an event | It is a CLI detail. The `claude-cli` provider keeps logging it, as today (`claude-runner.ts:331-337`). |
| 4 error kinds | `timeout` (no first token, or a stall), `output_limit` (reply cut off), `backend` (any other backend or process failure, with its message), `cancelled`. The 7 kinds in `ErrorKind` today only change the wording on the page. |

### 3.1 `claude-cli` = today's runner, moved

`claude-runner.ts` becomes `src/shared/server/llm/providers/claude-cli.ts`. It keeps its hard-won details: the safe flags,
stream-json reading, the stall timer, `max_tokens` handling and quota logging (`claude-runner.ts:31-50, 128-157, 209-386`).

It also takes over **the warm spare process**, which is Translate-only code today (`server.ts:240-282`). The provider
keeps one warm process for the last settings it ran, invisibly. Nothing in the interface mentions it, and grading gets
warm starts too.

**Fallback to a smaller model moves out**, into the gateway (§5). It is a rule about models, not about the CLI.

### 3.2 The model list: where the backend is chosen

```ts
// src/shared/server/llm/models.ts
export const MODELS: Model[] = [
  { model_id: 'claude-opus-5-5',   label: 'Opus 5.5',   provider: 'claude-cli', fallback: 'claude-sonnet-5-5' },
  { model_id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', provider: 'claude-cli', fallback: 'claude-haiku-5-5' },
  { model_id: 'claude-haiku-5-5',  label: 'Haiku 5.5',  provider: 'claude-cli', fallback: null },
];
export const EFFORTS: Effort[] = ['low', 'medium', 'high'];
export const DEFAULTS = { model_id: 'claude-sonnet-5-5', effort: 'low' as Effort };
```

**To change the backend, you change `provider` here.** No feature changes. This list replaces `MODEL_OPTIONS`,
`EFFORT_OPTIONS` and the two copies of "model must be one of…" (`server.ts:308-317`, `practice/server/routes.ts:80-86`).

Before you ever switch, know this: `claude -p` runs on your **subscription** (a 5-hour and 7-day quota, no bill per call).
The API needs an **API key and is paid per token**. The design makes switching easy; it does not make the costs the same.

---

## 4. The task: what one kind of call is

```ts
// src/shared/server/llm/task.ts
export interface Task<Input, Output = string> {
  name: string;                       // 'translate', 'practice.grade', 'evaluate'
  system(input: Input): string;       // the system prompt (usually: read a Markdown file)
  user(input: Input): string;         // the user message, built from the input
  output?: Spec;                      // set it: the reply must be JSON of this shape. Leave it out: the reply is text.
  input?: Spec;                       // set it: the task can also be called over HTTP (§7), and its input is checked
}
```

**5 members, 3 of them functions you would write anyway.** A task knows nothing about backends, streaming or saving.

Example, the whole Practice grading task:

```ts
// src/features/practice/server/tasks.ts
const PROMPT_PATH = join(FEATURE_DIRECTORY, 'prompts', 'grade.md');

export const gradeTask: Task<{ exercise: ExerciseBody; answer: Answer }> = {
  name: 'practice.grade',
  system: () => readFileSync(PROMPT_PATH, 'utf8'),          // read at each run: a prompt edit applies at once
  user: ({ exercise, answer }) => userMessageOf(exercise, answer),   // today's function, ai-grading.ts:28-32
};
```

Why:

| Choice | Why |
|---|---|
| **Each feature owns its tasks** | The prompt and the meaning of the reply belong to the feature (Practice knows what an exercise is). It also keeps the rule in `test/boundaries.test.ts`: features import from `src/shared/`, never from each other. |
| `system` and `user` are functions | They cover every case: one file, several files joined (Translate's `core.md` + style + glossary, `server.ts:79-86`), or text built from the input. No special "prompt files" field to learn. |
| `output: Spec` for JSON | One field says "I want JSON of this shape". The gateway does the rest (§5.2). `Spec` is the same small checker as the Practice import (`import-check.ts:12-21`), moved to `src/shared/`: one way to describe a shape in the whole app. |
| `input: Spec` only for HTTP | Inside the server, the feature already checked its input (Practice checks answers in `answers.ts`). The spec is needed only when a stranger (curl, agent) sends the input. **Having an `input` spec is also the rule for "may be called over HTTP"**, so there is no second flag to keep in sync. |
| No "defaults" per task | The model and effort come from the caller (the page's picker) or `DEFAULTS`. One place, not one per task. |

---

## 5. The gateway: the rules every call shares

```ts
// src/shared/server/llm/gateway.ts
export interface Llm {
  // Checks the settings and starts the run (it may wait in the queue). Throws LlmInputError for a bad model, effort or input.
  start<Input, Output>(task: Task<Input, Output>, input: Input, options?: RunOptions): Run<Output>;
  // Sends a run's live events to a page as Server-Sent Events: what it has so far first, then the rest.
  watch(run_id: number, res: ServerResponse): void;
}

export interface RunOptions {
  model_id?: string;     // default: DEFAULTS.model_id
  effort?: Effort;       // default: DEFAULTS.effort
  caller?: string;       // for the record, e.g. 'practice:attempt:12'
}

export interface Run<Output> {
  id: number;                              // the run's row in data/llm.sqlite
  events: AsyncIterable<RunEvent>;         // live events, for a feature that streams them itself (Translate); ignore it if you don't
  result: Promise<RunResult<Output>>;      // when it ends; never rejects
  cancel(): void;
}

export type RunEvent =
  | { type: 'thinking'; text: string }
  | { type: 'thinking_done'; ms: number }
  | { type: 'text'; text: string }
  | { type: 'retry'; message: string }
  | { type: 'fallback'; from_model_id: string; to_model_id: string };

export type RunResult<Output> =
  | { ok: true;  output: Output; text: string; thinking: string; thinking_ms: number | null; model_id: string; ms: number }
  | { ok: false; error: { kind: LlmError['kind'] | 'bad_output'; message: string }; model_id: string | null; ms: number };
```

**2 methods on the gateway, 4 members on a run, 2 result shapes.** `model_id` in the result is the model that really
answered (after a fallback, it is the smaller one).

What `start` does, in order:

1. **Check** the model and effort against `MODELS`, and the input against `task.input` if there is one.
2. **Save** a run row (`queued`) and log one `start` line, with a request number as today.
3. **Wait for a free slot**: at most 3 runs at once. Today nothing stops twenty gradings from starting twenty `claude`
   processes at once.
4. **Stream** from the model's provider. **Fallback rule:** no `thinking` or `text` within 10 s → cancel and start the model's
   `fallback` once, with the same effort (today's rule, `claude-runner.ts:36-43`). The wait is longer for a long prompt:
   +1 s per ~4,000 characters, for every task (today only Translate has this, `server.ts:332`).
5. **Keep what it has so far in memory** and send it to watchers. A watcher who joins late gets a `snapshot` first. This is
   today's grading behaviour (`ai-grading.ts:39-132`), now for every task.
6. **End**: build the output (text, or JSON, §5.2), save the row, log one line, resolve `result`.

**A run keeps going until it ends or someone calls `cancel()`.** Nobody watching does not stop it. Translate stops its run
when the page closes by calling `run.cancel()` itself, as it does today (`server.ts:466-469`). That is one rule for all
runs, and each feature decides when to stop its own.

**On server start**, runs left `queued` or `running` become failed ("The server stopped while running"), like
`failInterruptedGradings` (`store.ts:272-274`), once for all features.

### 5.1 How the two features use it

Practice grading, after the attempt is saved:

```ts
const run = llm.start(gradeTask, { exercise: attempt.exercise, answer: attempt.answer },
                      { ...settings, caller: `practice:attempt:${attempt.id}` });
store.setRunId(attempt.id, run.id);
void run.result.then((result) => store.finishGrading(attempt.id, result));
```

`GET attempts/:id/stream` becomes `llm.watch(attempt.run_id, res)`. `ai-grading.ts` shrinks to `userMessageOf`.

Translate, in its request handler:

```ts
const run = llm.start(translateTask, { text, source_language, target_language, mode }, { model_id, effort, caller: 'translate' });
res.on('close', () => run.cancel());
for await (const event of run.events) {
  if (event.type === 'text') sendOutputEvents(pair_parser.push(event.text));   // its own pair parser, unchanged
  else sendEvent(res, event.type, event);                                       // thinking, retry, fallback: passed on
}
const result = await run.result;
```

Its spare-process code (`server.ts:240-282`) goes away: the provider does it.

### 5.2 JSON output

If a task has `output`, the gateway:

1. adds one line to the system prompt: "Reply with one JSON object of this shape:" and the shape as JSON Schema;
2. at the end, removes a Markdown code fence if there is one, parses the JSON, and checks it with the `Spec`;
3. if that fails, the result is `{ ok: false, error: { kind: 'bad_output', … } }`. The raw text is still saved in the run
   row, so you can see what went wrong.

No automatic retry at first (open question Q3).

### 5.3 Inside the server, call the module, not HTTP

"Every call goes through the gateway" means features call `llm.start` in the same process. They do **not** call the
server's own HTTP port: that would add JSON encoding, a socket and new ways to fail, and give nothing. HTTP (§7) is the same
gateway for callers **outside** the server.

---

## 6. The record: `data/llm.sqlite`

One file for the gateway, with the same safety rules as the others (`src/shared/server/sqlite.ts`) and a daily backup.

```sql
CREATE TABLE prompts (
  hash       TEXT PRIMARY KEY,          -- first 16 hex characters of sha256(text)
  text       TEXT NOT NULL,
  first_used TEXT NOT NULL
) STRICT;

CREATE TABLE runs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  task               TEXT    NOT NULL,                  -- 'practice.grade'
  caller             TEXT,                              -- 'practice:attempt:12', 'http'
  status             TEXT    NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
  provider           TEXT    NOT NULL,                  -- 'claude-cli'
  requested_model_id TEXT    NOT NULL,
  model_id           TEXT,                              -- the model that answered; differs after a fallback
  effort             TEXT    NOT NULL,
  prompt_hash        TEXT    NOT NULL REFERENCES prompts (hash),
  input_json         TEXT    NOT NULL CHECK (json_valid(input_json)),
  output_text        TEXT,                              -- the raw reply
  thinking_text      TEXT,
  thinking_ms        INTEGER,
  error_kind         TEXT,
  error_message      TEXT,
  input_tokens       INTEGER,
  output_tokens      INTEGER,
  ms                 INTEGER,
  created_at         TEXT    NOT NULL,
  finished_at        TEXT
) STRICT;
CREATE INDEX runs_by_task ON runs (task, id);
```

| Choice | Why |
|---|---|
| **`prompt_hash`, with each distinct prompt stored once** | For any result you can see the exact system prompt that made it, and compare grading before and after an edit of `grade.md`. No version numbers to bump by hand. Storing the prompt in every row would repeat ~10 KB per call. |
| **No `output_json` column** | The JSON is the reply text. It is parsed again when needed. One fewer column to keep in sync. |
| **Features keep their own copy** of what matters to them (an attempt's result text, a translation's pairs), and link to the run with `run_id` | The run is the technical record (how it was made); the feature row is the meaning. A feature never breaks because the gateway's table changed. The text is stored twice, a few KB per call: fine. |
| **Keep every run** | ~50 calls a day × ~10 KB ≈ 200 MB a year at worst. Add a cleanup later only if it matters. |

---

## 7. The HTTP API: `/api/llm`

Same error shape as the Practice API (`docs/practice-api-design.md` §3.3): `{ error: { code, message, problems? } }`.

| Method and path | Request | Success | Errors |
|---|---|---|---|
| `GET /api/llm/models` | — | `200 { models, efforts, defaults }` | — |
| `GET /api/llm/tasks` | — | `200 { items: [{ name, input_schema, output_schema? }] }`: only tasks with an `input` spec | — |
| `POST /api/llm/runs` | `{ task, input, model_id?, effort? }` | `202 Run`; with `?wait=true`, `200 Run` when it has ended | `400 invalid`, `404 not_found` |
| `GET /api/llm/runs?task=&status=&before=&limit=` | — | `200 { items: Run[], next_before? }`, newest first | `400 invalid` |
| `GET /api/llm/runs/{id}` | — | `200 Run` | `404 not_found` |
| `GET /api/llm/runs/{id}/stream` | — | Server-Sent Events: `snapshot`, then the `RunEvent`s, then `done` or `error` | `404 not_found` |
| `POST /api/llm/runs/{id}/cancel` | — | `200 Run` | `404 not_found`, `409 not_running` |

**7 endpoints.** A `Run` in JSON is the row of §6, with `input_json` shown as `input`: `{ id, task, status, model_id, effort,
input, output_text, error, ms, created_at, … }`.

- **The page** uses `GET /models` for every model picker (it replaces `GET /api/practice/grading-options` and Translate's
  model data) and `…/stream` to follow a run.
- **You and agents** use it to try a task, or to read "every grading today, with model and time".
- **`POST /runs` accepts only tasks with an `input` spec.** `practice.grade` has none, so it cannot be started from
  outside without an attempt to save it into.

```bash
curl -s -X POST 'localhost:8787/api/llm/runs?wait=true' -H 'Content-Type: application/json' \
  -d '{"task":"evaluate","input":{"text":"I think it not good enough.","criteria":"grammar"}}'
```

---

## 8. A first new task: `evaluate`

The first task built only on the gateway. It proves the design and covers "evaluate anything":

```ts
export const evaluateTask: Task<{ text: string; criteria: string }, Evaluation> = {
  name: 'evaluate',
  system: () => readFileSync(EVALUATE_PROMPT_PATH, 'utf8'),
  user: ({ text, criteria }) => `Criteria: ${criteria}\n\n<text>\n${text}\n</text>`,
  input: { kind: 'object', fields: { text: text(20_000, true), criteria: text(1_000, true) } },
  output: { kind: 'object', fields: {
    summary: text(2_000, true),
    issues: list({ kind: 'object', fields: { quote: text(500, true), fix: text(500, true), why: text(1_000, true), category: text(40, true) } }, 0, 50),
  } },
};
```

The issues have a fixed shape, so later they can be counted. That is what the planned Practice error log needs
(`practice-proposal.md` §7).

---

## 9. What I would NOT build

| Not building | Why |
|---|---|
| Calling the gateway over HTTP from inside the server | §5.3. |
| A framework (LangChain and similar) | The runner already does what you need, in code you understand. |
| Tools, agent loops, chat sessions | Every call today is "text in, text out" (`--tools ''`). |
| A message list in `LlmRequest` | One `user` string covers every call. Add a list when a feature needs a follow-up question. |
| Per-task default model or effort | One `DEFAULTS`; the page's picker chooses. |
| Several providers for one model, load balancing | One user. One provider per model. |
| A response cache | The same input rarely repeats, and a retry usually wants a new answer. |
| A database job queue, workers | An in-memory queue with a limit of 3 is enough. A restart marks unfinished runs failed. |
| A prompt editor page | Prompts are Markdown files in git. `prompt_hash` gives you their history. |
| Automatic retry on bad JSON | Q3. |

---

## 10. Migration plan (small steps, the app works after each)

1. **Provider.** Create `src/shared/server/llm/` with `provider.ts`, `models.ts`, `providers/claude-cli.ts` (from
   `claude-runner.ts`) and `providers/fake.ts`. Keep a thin `runClaude` wrapper over the new provider, so Translate and
   grading do not change yet.
2. **Gateway and record.** `task.ts`, `gateway.ts`, the run store and `data/llm.sqlite` with a daily backup. Tests with the
   fake provider: fallback, stall, cancel, a late watcher gets the snapshot, a restart fails unfinished runs, bad JSON gives
   `bad_output`.
3. **Practice grading** uses `gradeTask`. Add `attempts.run_id` (it fits in step 2 of the Practice API migration).
   `ai-grading.ts` shrinks to `userMessageOf`.
4. **Translate** uses `translateTask` and `run.events`. Its spare code goes into the provider. Add `translations.run_id`.
   This is the riskiest step (Translate is the most used and most tuned), so it comes after grading has proved the gateway.
   The Translate characterization tests must stay green.
5. **`/api/llm`**, and every model picker reads `GET /api/llm/models`. Remove `GET /api/practice/grading-options` and the
   duplicate checks.
6. **The `evaluate` task.**
7. **Only if you decide to:** `providers/anthropic-api.ts` (the official SDK, the API key in an environment variable, never
   in the repo), and change `provider` in `MODELS`.

Deleted at the end: `claude-runner.ts` (moved), `ai-grading.ts` except `userMessageOf`, Translate's spare code
(`server.ts:240-282`), the duplicate settings checks (`server.ts:308-317`, `practice/server/routes.ts:78-86`).

---

## 11. Open questions (with my recommendation)

**Q1. Is switching to the Anthropic API a real plan?**
*Recommendation:* no, just keep the door open. Build steps 1–6. The CLI on your subscription is cheaper for you. When you
need the API, it is one provider file.

**Q2. How many runs at once?**
*Recommendation:* 3. Your quota is the real limit, and 3 parallel gradings already finish a day's exercises quickly.

**Q3. Retry once when a JSON task returns bad JSON?**
*Recommendation:* not at first. Check how often `bad_output` happens in the `runs` table. If it is more than about 2 %, add
one retry that shows the model its problems.

**Q4. Where does the code live?**
*Recommendation:* the gateway in `src/shared/server/llm/` (every feature needs it, and features may import only from
`src/shared/`). The `/api/llm` routes go in `server/server.ts`, which already puts the features together. Each feature's tasks
stay in the feature.
