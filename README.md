# Claude Translate

A small app that runs on your own computer. It has two pages:

- **Translate**: English ↔ Vietnamese, side by side, like Google Translate. Each paragraph sits next to its translation.
- **Practice**: IELTS writing, grammar and vocabulary exercises. Claude grades your answers and explains your mistakes.

It uses Claude through the `claude` command line tool, with your own Claude subscription. Nothing runs in the cloud
except the model calls; your history and answers stay in a local SQLite file.

## Quick start

```bash
git clone https://github.com/vinhtran2611/claude-translate.git
cd claude-translate
bash start.sh
```

This starts the server and opens http://localhost:8787. Press `Ctrl-C` to stop it.
Another port: `PORT=8788 bash start.sh`.

### What you need

| Need | Check | How to get it |
|---|---|---|
| Node.js 24 or newer | `node --version` | [nodejs.org](https://nodejs.org) |
| Claude Code CLI | `claude --version` | [code.claude.com/docs](https://code.claude.com/docs) |
| The CLI logged in with a Claude subscription | `claude auth status` shows `"authMethod": "claude.ai"` | `claude auth login` |

`start.sh` checks all three and tells you what to fix. There is nothing to install and no build step:
Node runs the TypeScript files directly.

## Translate

1. Paste or type your text. The direction (English → Vietnamese or back) is detected for you; ⇄ swaps it.
2. Press **Translate** or `⌘↵`.
3. Each paragraph, heading, list item or table shows next to its translation, as it streams in.

| You want to | Do this |
|---|---|
| Choose the model and effort | the chip under the title, or `⌘/` (Sonnet 5.5 · Low by default) |
| Fix text that lost its layout (a PDF, an email) | switch the mode chip to **Markdown** |
| Copy the translation | **Copy**, top right |
| Stop a translation | `Esc` |
| Find an old translation | the sidebar on the left; `⌘K` searches it |
| Print or save as PDF | `⌘P` gives a two-column A4 layout |

**Models:** Opus 5.5 for the best tone, Sonnet 5.5 for everyday text, Haiku 5.5 for speed.
**Effort** is how long the model may think first: Low, Medium or High.

Every translation is saved in your history. To change the translation style, edit the files in `src/features/translate/prompts/`;
the next translation uses them, with no restart.

How it works inside (the `claude` command, streaming, timeouts, the API, the log):
[docs/translate-internals.md](docs/translate-internals.md).

## Practice

Open http://localhost:8787/practice, or **Practice** at the top of the page.

1. **Get exercises.** Ask Claude for a JSON file in the [import format](docs/practice-import-format.md). One file is one
   project, for example one day of study. There are five exercise types:

   | Type | For | Graded by |
   |---|---|---|
   | `rewrite` | translate, rewrite, correct mistakes | Claude |
   | `write` | IELTS Task 2 essays | Claude, with estimated bands |
   | `choice` | multiple choice | Claude |
   | `fill` | fill in the blanks | Claude |
   | `flashcard` | vocabulary and rules | you: *Didn't know*, *Almost*, *Knew it* |

   [src/features/practice/examples/example-project.json](src/features/practice/examples/example-project.json) has one of each.
2. **Import it.** On the Projects page, choose **New project** and drop the file. The page lists any problems and imports
   nothing until the file is right. Importing the same file again updates the exercises in place.
3. **Practise.** Write your answer and press **Submit**. Claude's feedback streams in under your answer, and keeps going
   if you close the page. **Try again** makes a new attempt.
4. **Look back.** The sidebar lists your latest attempt for each exercise. Click one to see it exactly as it was.

The grading prompt is [src/features/practice/prompts/grade.md](src/features/practice/prompts/grade.md). Edit it and the next
grading uses it.

### Practice API (for scripts and AI agents)

Everything the page does is also an HTTP API under `/api/practice`: projects and exercises by key, import and export,
attempts and grading. It is made for both people with `curl` and AI agents:

- `GET /api/practice` lists every endpoint, the limits, and links to a JSON Schema for each exercise type.
- Every write accepts `?dry_run=true`: it checks and answers, but saves nothing.
- Writes are safe to repeat: the same `PUT` twice gives the same result.
- Every error has the same shape: `{ "error": { "code", "message", "problems": [{ "path", "code", "message" }] } }`.

```bash
# What is there
curl -s localhost:8787/api/practice

# Check a file, then import it
curl -s -X POST 'localhost:8787/api/practice/import?dry_run=true' -H 'Content-Type: application/json' --data @day-01.json
curl -s -X POST 'localhost:8787/api/practice/import' -H 'Content-Type: application/json' --data @day-01.json

# Read your graded answers in one project
curl -s 'localhost:8787/api/practice/attempts?project=m1-day-01&status=graded'
```

The full design and every endpoint: [docs/practice-api-design.md](docs/practice-api-design.md).

## Your data

| File | What |
|---|---|
| `data/history.sqlite` | your translations |
| `data/practice-v2.sqlite` | your Practice projects, exercises and answers |
| `data/backups/` | a daily copy of both; the newest 30 are kept |
| `data/server.log` | the server log |

`data/` is never committed. To restore a backup, stop the server and copy the backup over the live file.
The server only listens on `127.0.0.1` and refuses requests from other websites.

## Development

```bash
npm install          # only for the checks below; the app itself needs no packages
npm run lint         # Biome: rules and reasons in biome.jsonc
npm run typecheck    # TypeScript
npm test             # Node's test runner, with a fake `claude`
npm run check        # all three
```

GitHub Actions runs the lint, the type check and the tests on every push.

| Folder | What is in it |
|---|---|
| `server/` | the HTTP server and the Translate routes |
| `web/` | the Translate page |
| `src/features/translate/` | the Translate feature: `server/` (history store, reply parser, prompt builder), `prompts/` (the translation prompt and glossary) |
| `src/features/practice/` | the Practice feature: `server/`, `web/`, the grading prompt, the import checker |
| `src/shared/` | code both pages use: running `claude -p`, HTTP and SQLite helpers, repo paths, the Markdown renderer, the model picker |
| `test/` | tests; the server tests run against a fake `claude` |
| `docs/` | design docs |

All code is TypeScript limited to syntax Node can strip (`erasableSyntaxOnly`), so there is no build step.
A feature imports only from itself and `src/shared/` (checked by `test/boundaries.test.ts`).

## Troubleshooting

| Problem | Fix |
|---|---|
| `claude CLI is not logged in` | Run `claude auth login`. |
| `port 8787 is used by ...` | Stop the other program, or run `PORT=8788 bash start.sh`. |
| `... sent nothing within ...` or `... stopped streaming ...` | Look in `data/server.log` for `retry` or `quota` lines, then try again. |
| The page shows strange English labels | Chrome's page translation is on. Turn it off for this site. |
