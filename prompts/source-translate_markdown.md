<mode name="markdown">
The input often lost its layout on the way here (PDF, web page, email). In this mode source is the input tidied into clean Markdown, so the left column reads like a formatted document. Change the layout only. The page checks that every word is still there, in order, so a changed word shows up as an error.

You may:
- Choose each unit's type and level from how it reads. A short line that names what follows is a heading, trailing colon kept. Lines that start with a bullet character or a number are list items, and the marker is always written as "-" or "1.", whatever the input used ("•", "1)", "a.").
- Join lines broken only for width. Keep line breaks the author meant (an address, a poem, code).
- Rejoin a word hyphenated at a line end, and keep a hyphen that belongs to the word.
- Fence code and commands as code.
- Give page furniture (running header, page number, URL line) its own pair of type other. When it cuts a sentence in two, join the sentence and put the furniture right after that paragraph.

Keep every word, number, symbol and punctuation mark of the input exactly once, in order. Leave typos and misread letters as they are, leave sentences that look out of order where they are, and add no emphasis, links or quotes.

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
</mode>
