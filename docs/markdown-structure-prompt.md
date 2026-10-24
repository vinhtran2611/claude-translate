# Markdown mode: structured output

Status: proposal. The prompt and source-check change are on branch `translate/markdown-structure`, not merged.

## Goal

Markdown mode should give two columns that read well when rendered.
The left column is the input laid out as a structured document, in its own language.
The right column is the translation with the same units, pair by pair.
Nothing is summarized, shortened, merged away or reworded.
Every sentence of the input is still there, in order.

Before this change, the mode only tidied the input.
Plain prose with no Markdown came back as long plain paragraphs.
History row 87 (an 8,207-char post) came back as 9 paragraphs, the longest 2,497 chars.

```
before                         after
------                         -----
paragraph (95)                 paragraph (95)
paragraph (964)                paragraph (361)
paragraph (1,690)              paragraph (194)
...                            paragraph (231)
                               paragraph (179)
                               ## Sutton's different architecture
                               paragraph (429)
                               ...
```

## The change

| File | Change |
|---|---|
| `src/features/translate/prompts/source-translate_markdown.md` | Main rule first; a tidy-only or restructure decision; `<tidy>` (the old rules) and `<structure>` (new); a worked example from plain input to pairs |
| `src/features/translate/prompts/core.md` | "Add no formatting the source lacks" now says it is about a translation and its source, so Markdown mode may add bold to source |
| `src/features/translate/web/source-check.ts` | A heading whose words are not the next input words is skipped |
| `src/features/translate/web/source-check.test.ts` | Four tests: list split with bold, added headings, an existing heading, a heading that replaced or moved words |
| `src/features/translate/server/translate-prompt.ts` | The Mode menu description |

Plain-text mode (`source-translate.md`) is unchanged.

## Decisions

### Q1. Headings: added headings, skipped by the source check

Option (b) was chosen.
Prose rarely has a phrase that works as a heading, so option (a) gives almost no headings.
Option (c) gives no headings, and the user asked for them.
The prompt lets the model add a level 2 heading of 2 to 6 words where the topic changes.
The heading uses the text's own terms and makes no claim of its own.
When the text already has a short line that names what follows ("As for my take..."), that line becomes the heading.

The source check skips a heading whose words are not the next input words.
This needs no new block type, attribute or parser change.
It lets nothing else through.
A heading that replaced input words leaves those words missing from their place, so the check still fails.
A sentence moved into a heading is also still missing from its place.
The only thing it allows is a pure insertion of heading words.
The rule applies in both modes, but plain-text mode never adds headings.

### Q2. Splitting and lists

| Structure | Rule | Why the check passes |
|---|---|---|
| Paragraph split | Over about 4 sentences or 80 words, split into 2 to 4 sentences, only between sentences | Layout is ignored |
| Inline list | "both 1) X and 2) Y": the lead-in stays a paragraph, each item a `1.` list item, joining words stay at the end of their item | `1)` is block syntax; no word is added or dropped |
| Sentence list | Consecutive sentences opening "First", "Second" may each be a list item | Same words |
| Bold | `**term**` for at most one key term per section | Inline Markdown is ignored |
| Quote | A quoted sentence set apart may be a quote unit, quotation marks kept | `>` is a marker |
| Table | Only for input already in rows and columns | Pipes are ignored |

A comma series inside a sentence stays a sentence, because a list would need the commas dropped.
When a structure would need a word dropped, changed or added, the part stays a plain paragraph.

### Q3. When not to restructure

The prompt first decides which case the input is.

| Input | Treatment |
|---|---|
| Already Markdown (lines starting with `#`, `-`, `*`, `1.`, `>`, a fence, or a `\|` table) | Tidy only |
| Code | Tidy only |
| Under about 100 words | Tidy only |
| Plain prose of about 100 words or more | Tidy, then structure |
| Under about 300 words | No added headings |

### Q4. Cost

The visible reply barely grows: more pairs add tag overhead, and headings and bold add a few words.
On row 87 the reply text went from 19,331 to 18,934 chars.
The cost is thinking: at effort low, the first draft of the prompt made the model plan the whole document before writing.
That draft used 18,620 output tokens against 7,237 before.
The prompt now says each decision is local and asks the model to start the first pair right away.
That brought it to 11,835 tokens, about 1.6 times the old cost on a long input.
Short and Markdown inputs are not restructured, so their cost is unchanged.

### Q5. Prompt shape

The main rule comes first: layout changes, content does not, and the page checks it.
Then comes the case decision, then `<tidy>` and `<structure>` as separate tagged sections.
Each rule names a measurable limit (sentences, words, heading length) instead of a vague word.
The worked examples keep the two tidy cases and add one restructure case.
That example shows a split paragraph, an inline list, an added heading and a bold term, as full pairs with translations.

## Trial

Run with the app's system prompt assembly, the `claude` CLI flags of `claude-runner.ts`, Sonnet 5.5, effort low.
Sentences were counted by splitting the input at `.`, `?` and `!` and finding each sentence in the left column, in order.

| Input | Prompt | Pairs | Sentences kept | Untranslated pairs | Source check | Output tokens |
|---|---|---|---|---|---|---|
| Row 87, 8,207 chars | before | 9 paragraphs | 70/70 | 0 | pass | 7,237 |
| Row 87 | first draft | 27 paragraphs, 6 headings, 2 list items | 70/70 | 0 | pass | 18,620 |
| Row 87 | second draft | 26 paragraphs, 6 headings, 2 list items | 69/70 | 0 | fail: "labs" became "lab" | 15,027 |
| Row 87 | final | 26 paragraphs, 4 headings | 70/70 | 0 | pass | 11,835 |
| Row 44, 276 chars, short | final | 1 paragraph, as before | 3/3 | 0 | pass | 286 |
| Row 38, 662 chars, a Markdown list | final | 1 paragraph, 7 list items, as before | 10/10 | 0 | pass | 1,226 |

The before rows for 44 and 38 are the app's saved results (effort high), not new runs.
The second draft's changed word is a model slip, and the source check caught it as designed.
The final run on row 87 did not turn "both 1) ... and 2) ..." into a list, though the first draft did.
One run per prompt is a small sample, so the cost and the list behaviour may vary.
