// Tests for src/shared/web/markdown.ts (npm test, or node --test src/shared/web/markdown/markdown.test.ts), no packages.
// Spec data and saved translations are read from test/fixtures/commonmark/ and test/fixtures/translations/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { TranslatedBlock } from '../../api-types.ts';
import type { Block, DocumentIndex, InlineNode, LinkDefinition } from '../markdown.ts';

interface SpecExample {
  markdown: string;
  html: string;
  example: number;
  section: string;
}

// The repo's test/ folder: the fixture paths below are relative to it.
const TEST_DIRECTORY_URL = new URL('../../../../test/', import.meta.url);
const here = (path: string): URL => new URL(path, TEST_DIRECTORY_URL);
const readJson = <Data>(path: string): Data => JSON.parse(readFileSync(here(path), 'utf8')) as Data;
const ENTITIES = readJson<Record<string, { characters: string } | undefined>>('./fixtures/commonmark/html-entities.json');
// The renderer decodes named references through a textarea, as the browser does; node gets the WHATWG table instead.
// Set before markdown.ts is imported below, the way the page has a document before it loads the module.
globalThis.document = {
  createElement: () => {
    let value = '';
    return { set innerHTML(html: string) { value = ENTITIES[html]?.characters ?? html; }, get value() { return value; } };
  },
} as unknown as Document;
const { parseInline, parseCellBlocks, parseDocumentBlocks, documentIndexOf, linkTargetOf, normalizeLabel, definitionOf, plainTextOf } = await import('../markdown.ts');

const escapeHtml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const encodeHref = (url: string | null): string => encodeURI(url ?? '').replace(/%25([0-9a-fA-F]{2})/g, '%$1');
function htmlOf(nodes: InlineNode[]): string {
  return nodes.map((node) => {
    if (node.kind === 'text') return escapeHtml(node.text);
    if (node.kind === 'line_break') return '<br />\n';
    if (node.kind === 'code') return `<code>${escapeHtml(node.text)}</code>`;
    if (node.kind === 'strong' || node.kind === 'em' || node.kind === 'del') return `<${node.kind}>${htmlOf(node.children)}</${node.kind}>`;
    if (node.kind === 'autolink') return `<a href="${escapeHtml(encodeHref(node.destination))}">${escapeHtml(node.text)}</a>`;
    if (node.kind === 'link') return `<a href="${escapeHtml(encodeHref(node.destination))}"${node.title === null ? '' : ` title="${escapeHtml(node.title)}"`}>${htmlOf(node.children)}</a>`;
    if (node.kind === 'image') return `<img src="${escapeHtml(encodeHref(node.destination))}" alt="${escapeHtml(node.alt)}"${node.title === null ? '' : ` title="${escapeHtml(node.title)}"`} />`;
    if (node.kind === 'footnote_ref') return `<sup>${escapeHtml(node.label)}</sup>`;
    throw new Error((node as { kind: string }).kind);
  }).join('');
}

const INLINE_SECTIONS = new Set(['Backslash escapes', 'Entity and numeric character references', 'Code spans', 'Emphasis and strong emphasis',
  'Links', 'Images', 'Autolinks', 'Raw HTML', 'Hard line breaks', 'Soft line breaks', 'Textual content']);
// Spec examples whose CommonMark output differs because GFM autolink literals are on (https://github.github.com/gfm/#autolinks-extension-).
const GFM_AUTOLINK_EXAMPLES = new Set([608, 611, 612]);

test('CommonMark 0.31.2 inline examples: every single-paragraph example passes or is a named deviation', () => {
  const counts = { eligible: 0, pass: 0, soft_break: 0, raw_html_as_text: 0, gfm_autolink: 0 };
  const failures: string[] = [];
  for (const example of readJson<SpecExample[]>('./fixtures/commonmark/commonmark-spec-0.31.2.json')) {
    if (!INLINE_SECTIONS.has(example.section)) continue;
    // Link definitions go to the parser's options; the rest must be one paragraph with no block syntax.
    const linkDefinitions = new Map<string, LinkDefinition>();
    const paragraphs: string[] = [];
    for (const block of example.markdown.replace(/\n$/, '').split(/\n\n+/)) {
      const definition = definitionOf(block);
      if (definition?.kind !== 'link_definition') {
        paragraphs.push(block);
        continue;
      }
      const label = normalizeLabel(definition.label);
      if (!linkDefinitions.has(label)) linkDefinitions.set(label, definition);
    }
    if (paragraphs.length !== 1) continue;
    const paragraph = paragraphs[0];
    const hasBlockSyntax = /^( {4}|\t|[#>]|[-*+] |\d+[.)] |```|~~~|<\w)/m.test(paragraph) || /^(=+|-+)\s*$/m.test(paragraph);
    if (hasBlockSyntax) continue;
    counts.eligible++;

    const inlineText = paragraph.replace(/^ +/gm, '').replace(/ +$/, '');
    const actual = `<p>${htmlOf(parseInline(inlineText, { linkDefinitions }))}</p>\n`;
    // The renderer shows a soft break as a line break, on purpose.
    const expectedWithBreaks = example.html.replace(/<p>([\s\S]*?)<\/p>/g, (_: string, inner: string) => {
      return `<p>${inner.replace(/(?<!<br \/>)\n/g, '<br />\n')}</p>`;
    });
    // Raw HTML is shown as text, on purpose: the output still has text, just no tags from the input.
    const visibleText = actual.replace(/<br \/>\n/g, '\n').replace(/<[^>]+>/g, '');
    const isRawHtmlAsText = /<[a-zA-Z!?/]/.test(example.markdown) && /</.test(actual) && visibleText !== '';
    if (actual === example.html) {
      counts.pass++;
    } else if (actual === expectedWithBreaks) {
      counts.soft_break++;
    } else if (isRawHtmlAsText) {
      counts.raw_html_as_text++;
    } else if (GFM_AUTOLINK_EXAMPLES.has(example.example)) {
      counts.gfm_autolink++;
    } else {
      const expected = JSON.stringify(example.html);
      failures.push(`#${example.example} ${JSON.stringify(example.markdown)} expected ${expected} got ${JSON.stringify(actual)}`);
    }
  }
  console.log('commonmark inline', JSON.stringify(counts));
  assert.deepEqual(failures, []);
});

// The blocks of a finished 'table' cell.
function tableCellBlocks(text: string): Block[] {
  return parseCellBlocks('table', '', 0, text, { isStreaming: false, linkDefinitions: new Map() });
}

// The table block a 'table' cell parses to; fails the test when it parses to anything else.
function tableOf(text: string): Extract<Block, { kind: 'table' }> {
  const block = tableCellBlocks(text)[0];
  assert.ok(block.kind === 'table', `expected a table, got ${block.kind}`);
  return block;
}

test('a GFM table reads its column alignments from the delimiter row', () => {
  const table = tableOf('| abc | defghi |\n:-: | -----------:\nbar | baz');
  assert.deepEqual(table.alignments, ['center', 'right']);
  assert.equal(htmlOf(table.bodyRows[0][1]), 'baz');
});

test('an escaped pipe stays inside its table cell', () => {
  const table = tableOf('| f\\|oo |\n| ------ |\n| b `\\|` az |');
  assert.equal(htmlOf(table.headerCells[0]), 'f|oo');
  assert.equal(htmlOf(table.bodyRows[0][0]), 'b <code>|</code> az');
});

test('a delimiter row with the wrong number of cells is not a table', () => {
  assert.equal(tableCellBlocks('| abc | def |\n| --- |\n| bar |')[0].kind, 'paragraph');
});

test('tab-separated rows, as pasted from a document, are a table', () => {
  const table = tableOf('Domain\tExample\nVision\tViT');
  assert.deepEqual(table.headerCells.map(htmlOf), ['Domain', 'Example']);
});

test('only "~~" strikes through; a single "~" stays text', () => {
  assert.equal(htmlOf(parseInline('~~Hi~~ Hello, ~about~ 5')), '<del>Hi</del> Hello, ~about~ 5');
});

test('GFM autolink literals: a www link drops its trailing dot; an address ending in "-" is no address', () => {
  const linkHtml = 'Visit <a href="http://www.commonmark.org/a.b">www.commonmark.org/a.b</a>.';
  assert.equal(htmlOf(parseInline('Visit www.commonmark.org/a.b.')), linkHtml);
  assert.equal(htmlOf(parseInline('a.b-c_d@a.b-')), 'a.b-c_d@a.b-');
});

test('URL policy', () => {
  const anchorIds = new Set(['md-overview']);
  assert.deepEqual(linkTargetOf('#overview', anchorIds), { href: '#md-overview', isExternal: false });
  assert.equal(linkTargetOf('#6-prospects', anchorIds), null);
  assert.deepEqual(linkTargetOf('#6-prospects', null), { href: '#md-6-prospects', isExternal: false });
  assert.equal(linkTargetOf('https://example.com/a b', anchorIds)?.href, 'https://example.com/a%20b');
  assert.equal(linkTargetOf('mailto:team@example.com', anchorIds)?.isExternal, true);
  for (const unsafe of ['javascript:alert(1)', 'java\tscript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,x', 'file:///etc/passwd', './docs/setup.md', '/x']) {
    assert.equal(linkTargetOf(unsafe, anchorIds), null, unsafe);
  }
});

test('document index: GitHub slugs, footnote order, a table of contents', () => {
  const entry = readJson<{ blocks: TranslatedBlock[] }>('./fixtures/translations/table-of-contents.json');
  const index = documentIndexOf(entry.blocks);
  const fragments = entry.blocks.flatMap((pair) => [...pair.sourceText.matchAll(/\]\(#([^)]+)\)/g)].map((match) => match[1]));
  const resolved = fragments.filter((fragment) => index.anchorIds.has(`md-${fragment}`));
  // The notes stop at section 5, so the 5 links to prospects, the appendix and sources have no heading to point at.
  assert.equal(fragments.length, 13);
  assert.equal(resolved.length, 8);
  const essay = documentIndexOf(readJson<{ blocks: TranslatedBlock[] }>('./fixtures/translations/footnotes.json').blocks);
  assert.equal(essay.footnoteNumbers.get('1'), 1);
  assert.ok(essay.anchorIds.has('md-fn-1') && essay.anchorIds.has('md-fnref-1'));
});

test('document index: numbered list items count up, though the model writes "1." for each', () => {
  const pairOf = (blockType: TranslatedBlock['blockType'], level: number, marker: string | null): TranslatedBlock => {
    return { blockType, level, marker, sourceText: 'text', translatedText: 'text' };
  };
  const pairs = [
    pairOf('paragraph', 0, null),
    pairOf('list_item', 1, '1.'),
    pairOf('list_item', 2, '1.'),
    pairOf('list_item', 2, '1.'),
    pairOf('list_item', 1, '1.'),
    pairOf('list_item', 2, '-'),
    pairOf('list_item', 1, '1.'),
    pairOf('paragraph', 0, null),
    pairOf('list_item', 1, '3.'),
    pairOf('list_item', 1, '1.'),
  ];
  const listNumbers = documentIndexOf(pairs).listNumbers;
  const shown = pairs.map((_pair, pairIndex) => listNumbers.get(pairIndex) ?? null);
  // A nested list starts again from 1 under each parent; a paragraph ends the list; a list keeps its first number.
  assert.deepEqual(shown, [null, 1, 1, 2, 2, null, 3, null, 3, 4]);
});

// The text a reader sees in a block.
function blockText(block: Block): string {
  switch (block.kind) {
    case 'paragraph':
    case 'heading':
      return plainTextOf(block.children);
    case 'list_item':
      return `${block.marker.text} ${block.blocks.map(blockText).join(' ')}`;
    case 'quote':
      return block.blocks.map(blockText).join(' ');
    case 'list':
      return block.items.map((item) => item.map(blockText).join(' ')).join(' ');
    case 'table': {
      const rows = [block.headerCells, ...block.bodyRows];
      return rows.map((row) => row.map(plainTextOf).join(' ')).join(' ');
    }
    case 'footnote_definition':
      return `${block.label} ${plainTextOf(block.children)}`;
    case 'code_block':
      return block.text;
    case 'link_definition':
      return `${block.label} ${block.destination}`;
    default:
      return '';
  }
}
const visibleOf = (blocks: Block[]): string => blocks.map(blockText).join(' ').replace(/\s+/g, ' ').trim();

// Every prefix of every cell, with the index the app holds live (the pairs completed before this one); a frame is
// unstable when it shows text the cell's final render does not start with. Text only: style flips and reflow are not seen.
export function streamingStabilityOf(pairs: TranslatedBlock[]): {
  frames: number; unstableFrames: number; cells: number; unstableCells: string[]; endOfStreamChanges: string[];
} {
  const finalIndex = documentIndexOf(pairs);
  const result = { frames: 0, unstableFrames: 0, cells: 0, unstableCells: [] as string[], endOfStreamChanges: [] as string[] };
  pairs.forEach((pair, pairIndex) => {
    const liveIndex = documentIndexOf(pairs.slice(0, pairIndex));
    for (const side of ['source', 'translation']) {
      const text = side === 'source' ? pair.sourceText : pair.translatedText;
      const parse = (prefix: string, isStreaming: boolean, index: DocumentIndex): Block[] => parseCellBlocks(pair.blockType, pair.marker, pair.level, prefix, { isStreaming, linkDefinitions: index.linkDefinitions });
      const finalText = visibleOf(parse(text, false, finalIndex));
      let cellUnstable = 0;
      for (let length = 1; length <= text.length; length++) {
        result.frames++;
        if (!finalText.startsWith(visibleOf(parse(text.slice(0, length), true, liveIndex)))) cellUnstable++;
      }
      result.cells++;
      result.unstableFrames += cellUnstable;
      if (cellUnstable) result.unstableCells.push(`${pairIndex}:${side}`);
      // Rendered final with the live index when the pair completed, then again with the whole document's index.
      if (visibleOf(parse(text, false, liveIndex)) !== finalText) result.endOfStreamChanges.push(`${pairIndex}:${side}`);
    }
  });
  return result;
}

test('streaming: no raw syntax flashes in the documents; the edge cases flash only where expected', () => {
  for (const name of ['table-of-contents', 'footnotes', 'documents', 'edge-cases']) {
    const { blocks } = readJson<{ blocks: TranslatedBlock[] }>(`./fixtures/translations/${name}.json`);
    const result = streamingStabilityOf(blocks);
    console.log(name, JSON.stringify({ ...result, unstableCells: result.unstableCells.join(' '), endOfStreamChanges: result.endOfStreamChanges.join(' ') }));
    if (name === 'edge-cases') {
      // 1: "**Source:**text" is literal by CommonMark flanking but bold while streaming. 3: "[collapsed][]" has no
      // definition, so its held "[" comes back. 4: "[cm]:" reads as text until its destination makes it a definition.
      // 3 also changes at the end: "[the spec][cm]" resolves only once the "[cm]:" pair has arrived.
      assert.deepEqual(result.unstableCells, ['1:source', '1:translation', '3:source', '3:translation', '4:source', '4:translation']);
      assert.deepEqual(result.endOfStreamChanges, ['3:source', '3:translation']);
    } else {
      assert.deepEqual(result.unstableCells, []);
    }
  }
});

test('a whole document: headings, nested numbered and bullet lists, quotes, tables, and a list keeps counting', () => {
  const kinds = (blocks: Block[]) => blocks.map((block) => block.kind);
  const evaluation = '**Not yet.** One idea.\n\n## Fix first\n1. **A.** First line\n   second line\n2. **B.**\n   - sub one\n   - sub two\n3. **C.**\n\nSmall slips: capitals.\n\n## Corrected version\n> Fixed text.\n> More.\n\n---\n\n| a | b |\n|---|---|\n| 1 | 2 |';
  const blocks = parseDocumentBlocks(evaluation);
  assert.deepEqual(kinds(blocks), ['paragraph', 'heading', 'list', 'paragraph', 'heading', 'quote', 'thematic_break', 'table']);
  const list = blocks[2] as Extract<Block, { kind: 'list' }>;
  assert.deepEqual([list.isOrdered, list.start, list.items.length], [true, 1, 3]);
  assert.deepEqual(kinds(list.items[1]), ['paragraph', 'list']);
  assert.deepEqual(list.items[0][0], { kind: 'paragraph', children: [
    { kind: 'strong', children: [{ kind: 'text', text: 'A.' }] }, { kind: 'text', text: ' First line' }, { kind: 'line_break' }, { kind: 'text', text: 'second line' },
  ] });
  // A numbered list split by a paragraph goes on from its own number, so the numbers a reader sees are consecutive.
  const split = parseDocumentBlocks('1. one\n\nA note.\n\n2. two') as Extract<Block, { kind: 'list' }>[];
  assert.deepEqual(kinds(split), ['list', 'paragraph', 'list']);
  assert.equal(split[2].start, 2);
  assert.deepEqual(parseDocumentBlocks('```ts\nlet a = 1;\n```'), [{ kind: 'code_block', language: 'ts', text: 'let a = 1;' }]);
  assert.deepEqual(parseDocumentBlocks(''), []);
});

test('a document still arriving holds back a bare list mark or heading mark, and reads its last paragraph provisionally', () => {
  const kinds = (text: string) => parseDocumentBlocks(text, true).map((block) => block.kind);
  assert.deepEqual(kinds('Verdict.\n\n-'), ['paragraph']);
  assert.deepEqual(kinds('Verdict.\n\n2.'), ['paragraph']);
  assert.deepEqual(kinds('Verdict.\n\n##'), ['paragraph']);
  assert.deepEqual(kinds('Verdict.\n\n## Fix'), ['paragraph', 'heading']);
  assert.deepEqual(kinds('Verdict.\n\n- one'), ['paragraph', 'list']);
  // An unclosed "**" is not shown as asterisks while the words that close it are still on their way.
  assert.deepEqual(parseDocumentBlocks('Wrong: **not yet', true)[0], { kind: 'paragraph', children: parseInline('Wrong: **not yet', { isStreaming: true }) });
  assert.deepEqual(parseDocumentBlocks('Wrong: **not yet')[0], { kind: 'paragraph', children: parseInline('Wrong: **not yet') });
});
