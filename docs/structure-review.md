# Structure review: files and folders

Date: 2026-10-21. Scope: folders, file sizes, names, tests, docs and imports. The data model is out of scope
(see `docs/data-model-proposal.md`). Line counts are from `git ls-files | xargs wc -l`.

The target layout has no compatibility limits: start script, test command, page URLs and imports may all change.

## 1. Verdict

The structure is mostly clean, and Practice is a good model: one folder per feature, with `server/` and `web/` inside.
But Translate, the biggest feature, still lives in the old root folders `server/`, `web/` and `prompts/`, so the app
has two layouts at once. The fix is one layout for everything: all code under `src/`, and each feature folder holds
its own code, tests, prompts and static files.

## 2. What works well

- `features/practice/` is easy to read: types, `server/`, `web/`, `web/templates/` (one file per exercise type), `prompts/`.
- `shared/` is split into `shared/server/` and `shared/web/`, so it is clear what runs where.
- `test/boundaries.test.ts` enforces the import rules. There are no circular imports.
- Names are consistent: `kebab-case.ts` files, `*.test.ts` tests, plural folder names.
- Most files are under 250 lines and do one job.

## 3. Problems, worst first

1. **Translate is not a feature folder.** Its code is in `server/history-store.ts`, `server/pair-stream-parser.ts`,
   `server/translate-prompt.ts`, `web/` and `prompts/` (see `server/server.ts:352`). A new person must learn two layouts,
   `web/` and `prompts/` sound app-wide but are Translate-only, and the boundary test does not cover Translate.
2. **`server/server.ts` (432 lines) does two jobs.** It starts the app and also holds the whole Translate route
   (`server/server.ts:37-346`). Practice already keeps its routes apart (`features/practice/server/routes.ts:114`).
3. **Two very big page files.** `web/app.ts` (1074 lines) mixes the text box, pairs view, alerts and history sidebar.
   `web/index.html` (1139 lines) is mostly inline CSS (`:12-1003`) that copies the tokens in `shared/web/base.css`,
   so a style change must be made twice.
4. **`features/english-log/` is a stale copy of another project.** It is a Claude Code hook, not part of the app. The copy
   that runs is `~/workspace/english-log/hook.ts`, and it differs. A fix made here changes nothing.
5. **Tests need files that are not in the repo.** `test/markdown.test.ts:155`, `:162` and `:225` read `test/fixtures/*.json`,
   which does not exist. `npm test` fails on a clean clone, so CI does not run tests (`.github/workflows/check.yml:2`).
6. **Each file finds the repo root on its own** by counting `dirname(dirname(...))` (`server/server.ts:21`,
   `features/practice/server/routes.ts:24-26`). Moving a file breaks its paths. Practice also serves a file from
   `docs/` at runtime (`routes.ts:50-53`), so editing a doc changes the app.
7. **`api.ts` is a vague name.** `shared/api.ts` and `features/practice/api.ts` hold only types, but sound like API code.
   And most of `shared/api.ts` is Translate-only, so "shared" no longer means "used by two features".
8. **Tests are far from their code.** All tests sit in a flat `test/`, mixed with helpers (`server-harness.ts`,
   `fake-claude/`). `test/vendor/` is spec data, not third-party code. Finding the test for a file needs a search.
9. **Docs have no index.** `docs/` mixes built designs, an unbuilt proposal (`llm-gateway-design.md`) and finished
   reports (`code-review.md`). Only each file's header says which is which.
10. **Small gaps.** Translate's page is `index.html` + `app.ts`, Practice's is `practice.html` + `practice.ts`.
    `web/fetch-json.ts` and `features/practice/web/client.ts` read API errors in two different ways.

Not a problem: `shared/web/markdown/inline.ts` (864 lines) is one job (a CommonMark parser) and well tested.

## 4. Target structure

### Rules

| Rule | Why |
|---|---|
| All app code is in `src/`. The entry is `src/server.ts`. | The usual Node layout. The root keeps only config, docs, scripts and tests. |
| A feature is `src/features/<name>/`. It imports only itself and `src/shared/`. | One place per feature. The boundary test checks it. |
| Inside a feature: `server/`, `web/`, `prompts/`, `static/`. Code that both sides use sits at the feature root. | The same shape in every feature, and in `shared/` (`server/`, `web/`). |
| API types live in `api-types.ts` (in each feature and in `shared/`). | The name says what it holds: types, for the HTTP API. |
| A page is `<feature>.html`, `<feature>.ts`, `<feature>.css` in `web/`. | One naming rule for every page. |
| A unit test sits next to its file: `store.ts` and `store.test.ts`. | A feature carries its own tests. `test/` keeps only what belongs to no single file. |
| Repo paths come from `src/shared/server/paths.ts`. | Moving a file cannot break its paths. |
| A served file's URL is its path under `src/` (`/features/practice/web/practice.ts`). Pages stay at `/` and `/practice`; API paths do not change. | One serving rule, and relative imports resolve the same in `tsc` and the browser. |
| Imports stay relative, with no `#shared/...` aliases. | The browser runs the same files, so aliases would need an import map in every page. |

### Layout

```text
claude-translate/
|-- src/
|   |-- server.ts
|   |-- features/
|   |   |-- translate/
|   |   |   |-- api-types.ts
|   |   |   |-- prompts/
|   |   |   |-- server/
|   |   |   `-- web/
|   |   `-- practice/
|   |       |-- api-types.ts
|   |       |-- prompts/
|   |       |-- static/
|   |       |-- server/
|   |       `-- web/
|   `-- shared/
|       |-- api-types.ts
|       |-- server/
|       `-- web/
|-- test/
|   |-- boundaries.test.ts
|   |-- integration/
|   |-- helpers/
|   `-- fixtures/
|       |-- commonmark/
|       `-- translations/
|-- scripts/
|   `-- start.sh
|-- docs/
|-- data/
`-- README.md, package.json, tsconfig.json, ...
```

### What goes in each folder

| Path | Holds |
|---|---|
| `src/server.ts` | Startup: backups, host check, static files, the feature list, `listen`. |
| `translate/server/` | `routes.ts` (`createTranslateFeature`), `history-store.ts`, `pair-stream-parser.ts`, `translate-prompt.ts` |
| `translate/web/` | `translate.html/.css/.ts`, `history-sidebar.ts`, `pairs-view.ts`, `alert.ts`, `settings-menus.ts`, ... |
| `translate/prompts/` | `core.md`, `style-*.md`, `source-translate*.md`, `glossary.tsv` |
| `practice/` root | `api-types.ts`, plus `import-check.ts` and `text.ts` (used by server and page) |
| `practice/static/` | `example-project.json`, `import-format.md` |
| `shared/api-types.ts` | Effort and model options, the API error shape, and the shared Translate block types |
| `shared/server/` | `claude-runner`, `http`, `log`, `sqlite`, `paths` |
| `shared/web/` | `ui`, `fetch-json`, `markdown/`, `model-picker`, `base.css`, `favicon.svg` |
| `test/integration/` | Tests through the real server with a fake `claude` |
| `test/helpers/` | `server-harness.ts`, `fake-claude/` |
| `test/fixtures/` | `commonmark/` (spec data), `translations/` (made-up saved translations) |
| `docs/` | Designs and reports, plus a `README.md` index that gives each doc's status: built, proposal or report |
| `data/` | Runtime data, ignored by git. Unchanged. |

Test command: `node --test "src/**/*.test.ts" "test/**/*.test.ts"`. The server must not serve `*.test.ts` files.

## 5. Move plan

One commit per step. Run `npm run check` after each. Each step also fixes imports, `tsconfig.json`, the boundary test,
the README folder table and doc paths that it changes. No step touches `data/`.

| # | Change | Problem |
|---|---|---|
| 1 | Write made-up fixtures in `test/fixtures/translations/` (see below). Add `npm test` to CI. | 5 |
| 2 | Delete `features/english-log/` and `test/english-log.test.ts`. | 4 |
| 3 | Add `shared/server/paths.ts`; replace every `dirname(dirname(...))` with it. | 6 |
| 4 | Move `shared/` to `src/shared/` and `features/practice/` to `src/features/practice/`. | - |
| 5 | Move `server/history-store.ts`, `pair-stream-parser.ts`, `translate-prompt.ts` to `src/features/translate/server/`, and `prompts/` to `src/features/translate/prompts/`. | 1 |
| 6 | Move the Translate route (`server/server.ts:37-346`) to `src/features/translate/server/routes.ts`. Move the rest to `src/server.ts`. | 2 |
| 7 | Serve every file at its path under `src/`. | - |
| 8 | Move `web/` to `src/features/translate/web/`; rename `index.html`, `app.ts` to `translate.html`, `translate.ts`. Move `favicon.svg` to `src/shared/web/`. | 1, 10 |
| 9 | Rename `api.ts` to `api-types.ts`. Move Translate-only types to `src/features/translate/api-types.ts`. | 7 |
| 10 | Move the inline CSS to `shared/web/base.css` (common parts) and `translate/web/translate.css` (the rest). | 3 |
| 11 | Split `translate.ts` into `translate.ts`, `history-sidebar.ts`, `pairs-view.ts`, `alert.ts`. | 3 |
| 12 | Move `web/fetch-json.ts` to `src/shared/web/`; use it in Practice's `client.ts` too. | 10 |
| 13 | Move `practice/examples/` and `docs/practice-import-format.md` to `src/features/practice/static/`. | 6 |
| 14 | Move `test/server-harness.ts` and `test/fake-claude/` to `test/helpers/`, and `test/vendor/` to `test/fixtures/commonmark/`. | 8 |
| 15 | Move unit tests next to their code (see below). Change the test command; stop serving `*.test.ts`. | 8 |
| 16 | Move `start.sh` to `scripts/start.sh`; `npm start` runs it. | - |
| 17 | Add `docs/README.md`, the doc index. | 9 |

### Step 1: the fixtures

`test/markdown.test.ts` reads six missing files (`entry-28` to `entry-32`, `fixture`). Each is a saved translation:
a list of blocks, each with source and translation text. The new files are short, made up, and cover the same cases:

| New file | Must cover |
|---|---|
| `table-of-contents.json` | `[text](#fragment)` links, GitHub-style heading slugs, some links with no matching heading |
| `footnotes.json` | a reference `[^1]` and its definition |
| `documents.json` | headings, nested lists, tables, code, quotes, bold and links that stream with no raw syntax showing |
| `edge-cases.json` | `**Source:**text`, `[collapsed][]` with no definition, and `[the spec][cm]` whose `[cm]: ...` arrives in a later block |

In the same commit, update the numbers the test expects (16 links, 9 resolved, blocks 3, 9 and 41) to match.

### Step 15: where each test goes

| Test now | Goes to |
|---|---|
| `test/http.test.ts` | `src/shared/server/http.test.ts` |
| `test/markdown.test.ts` | `src/shared/web/markdown/markdown.test.ts` |
| `test/source-check.test.ts` | `src/features/translate/web/source-check.test.ts` |
| `test/translate-page.test.ts` | split: `translate/web/detect-language.test.ts`, `translate/web/pairs-markdown.test.ts` |
| `test/practice-import.test.ts` | `src/features/practice/import-check.test.ts` |
| `test/practice-grading.test.ts` | `src/features/practice/server/ai-grading.test.ts` |
| `test/practice-store.test.ts` | `src/features/practice/server/store.test.ts` |
| `test/practice-web.test.ts` | split: `practice/web/format.test.ts`, `drafts.test.ts`, `templates/templates.test.ts`; the base.css check to `shared/web/base-css.test.ts` |
| `test/translate-server.test.ts`, `practice-server.test.ts`, `practice-api.test.ts` | `test/integration/`, same names |
| `test/boundaries.test.ts` | stays; now checks all of `src/` |

## 6. Owner decisions

1. English log: it lives only in `~/workspace/english-log`; this repo drops its copy (step 2).
2. Fixtures: small made-up files, committed; CI runs `npm test` (step 1).
3. `data/` stays in the repo folder, ignored by git.
4. `data/practice.sqlite` is left alone for now.
