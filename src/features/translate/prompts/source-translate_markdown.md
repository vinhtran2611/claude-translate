<mode name="markdown">
In this mode source is the input laid out as a structured Markdown document that reads like a well-formatted engineering doc, built only from the input's own words. Change the layout, never the content: every word, number, symbol and punctuation mark of the input stays exactly once, in order. Nothing is summarized, shortened, merged away, reworded or added, apart from the section headings described below. Full content comes before structure: when a list, heading or split would need a word dropped, changed or added, leave that part a plain paragraph. The page checks the left column against the input word by word, so a changed or dropped word shows up as an error.

Decide first which case the input is:
- Tidy only: the input already uses Markdown (lines that start with #, -, *, 1., > or ```, or a | table), is code, or is shorter than about 100 words. Apply <tidy> and keep the units the input has.
- Restructure: plain prose of about 100 words or more. Apply <tidy>, then <structure>.

<tidy>
The input often lost its layout on the way here (PDF, web page, email).
- Choose each unit's type and level from how it reads. A short line that names what follows is a heading, trailing colon kept. Lines that start with a bullet character or a number are list items, and the marker is always written as "-" or "1.", whatever the input used ("•", "1)", "a.").
- Join lines broken only for width. Keep line breaks the author meant (an address, a poem, code).
- Rejoin a word hyphenated at a line end, and keep a hyphen that belongs to the word.
- Fence code and commands as code.
- Give page furniture (running header, page number, URL line) its own pair of type other. When it cuts a sentence in two, join the sentence and put the furniture right after that paragraph.
- Leave typos and misread letters as they are, and leave sentences that look out of order where they are.
</tidy>

<structure>
- Paragraphs: split a paragraph of more than about 4 sentences or 80 words into paragraphs of 2 to 4 sentences, one point each. Split only between sentences, never inside one.
- Lists: when a sentence enumerates with markers in the text ("1) ... 2) ...", "(a) ... (b) ..."), the words before the first marker stay a paragraph, each item becomes a list_item with marker "1.", and the input's markers are dropped. When consecutive sentences open with "First", "Second" and so on, each may become a list_item. Joining words stay at the end of the item they follow ("and", "or", a comma); add no punctuation. A comma series inside a sentence stays a sentence.
- Headings: where the text turns to a new topic, give it a level 2 heading. When the text already has a short line that names what follows ("As for my take..."), that line is the heading. Otherwise add one before the paragraph that starts the topic: 2 to 6 words that name the topic with the text's own terms, not the paragraph's opening words, with no claim, opinion or fact of your own, and no trailing colon. Topics usually change every 3 to 6 paragraphs. Put no heading before the opening paragraph, and none in a text under about 300 words. An added heading is the only text you may add.
- Bold: mark with ** the few key terms the text defines or keeps returning to, at most one per section, at their first appearance.
- Quotes: a quoted sentence the author sets apart (speech, a cited line) may become its own quote unit, quotation marks kept.
- Tables: only for input already laid out in rows and columns, never built from prose.
- Add no links, italics, code spans, quotation marks, separators or empty units.

The translation has the same units as source: one pair per unit, the same type, level and marker, the same bold terms, and an added heading translated like any heading.

Each of these decisions is local, so make it when you reach that spot while writing the pairs: where this paragraph ends, whether this sentence enumerates, whether the topic changes here. Do not outline the text, count paragraphs or draft headings in advance; start the first pair right away.
</structure>

<example>
Input:
Data ingest:
The pipeline reads raw events from the compu-
ter network and writes them
to the data store.
• first item
• second item

Units, with their source:
- heading (level 2): Data ingest:
- paragraph: The pipeline reads raw events from the computer network and writes them to the data store.
- list_item (marker "-"): first item
- list_item (marker "-"): second item
</example>

<example>
Input:
The 5000 users saw a huge perfor-
Page 3
mance gain.

Units: a paragraph with source "The 5000 users saw a huge performance gain.", then an other unit with source "Page 3".
</example>

<example>
Input, English into Vietnamese (the middle of a longer post):
Caching helped a lot. We tried two layers: 1) an in-memory LRU and 2) a Redis cluster. The LRU cut p50 latency in half. Redis mostly helped p99, because cold keys no longer hit the database. Neither fixed writes, though. Writes still go straight to Postgres and lock the hot rows. Next quarter we will look at batching them.

Reply:
<pair type="paragraph">
<source>Caching helped a lot. We tried two layers:</source>
<translation>Caching giúp ích rất nhiều. Bọn mình đã thử hai lớp:</translation>
</pair>
<pair type="list_item" level="1" marker="1.">
<source>an in-memory LRU and</source>
<translation>một LRU in-memory và</translation>
</pair>
<pair type="list_item" level="1" marker="1.">
<source>a Redis cluster.</source>
<translation>một Redis cluster.</translation>
</pair>
<pair type="paragraph">
<source>The LRU cut p50 latency in half. Redis mostly helped p99, because cold keys no longer hit the database.</source>
<translation>LRU giảm p50 latency đi một nửa. Redis chủ yếu giúp p99, vì cold key không còn đánh thẳng vào database nữa.</translation>
</pair>
<pair type="heading" level="2">
<source>Writes</source>
<translation>Phần ghi</translation>
</pair>
<pair type="paragraph">
<source>Neither fixed writes, though. Writes still go straight to Postgres and lock the **hot rows**. Next quarter we will look at batching them.</source>
<translation>Nhưng cả hai đều không giải quyết được write. Write vẫn đi thẳng vào Postgres và khoá các **hot row**. Quý sau bọn mình sẽ tính chuyện batch chúng lại.</translation>
</pair>
</example>
</mode>
