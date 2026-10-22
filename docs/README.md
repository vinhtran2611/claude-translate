# Docs

Every doc here is one of three kinds:

- **built**: it describes code that exists. Keep it up to date when the code changes.
- **proposal**: a design that is not built yet. The code does not follow it.
- **report**: a finished review. It describes the code as it was on its date and is not updated.

| Doc | Status | What it is |
|---|---|---|
| [translate-internals.md](translate-internals.md) | built | How the Translate page works: pairs, the Markdown renderer, printing, the `claude` command, the HTTP API, the server log, the prompt files |
| [practice-proposal.md](practice-proposal.md) | built | The Practice page: exercise types, grading, the data, the layout of `src/features/practice/` |
| [practice-api-design.md](practice-api-design.md) | built | The Practice HTTP API and database. Steps 1 to 5 are built; step 6, the agent guide, is not |
| [llm-gateway-design.md](llm-gateway-design.md) | proposal | One way for every feature to call an LLM |
| [code-review.md](code-review.md) | report | The readability review and what was changed after it |
| [structure-review.md](structure-review.md) | report | The folder-structure review and its move plan; the plan is built |

The Practice import format is not here: it is served by the app, so it lives with the code at
[src/features/practice/static/import-format.md](../src/features/practice/static/import-format.md).
