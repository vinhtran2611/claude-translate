// Tests for shared/web/markdown.ts (npm test, or node --test test/markdown.test.ts), no packages.
// Spec data and fixtures are read from vendor/ and fixtures/ next to this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Pair } from '../shared/api.ts';
import type { Block, DocumentIndex, InlineNode, LinkDefinition } from '../shared/web/markdown.ts';

interface SpecExample {
  markdown: string;
  html: string;
  example: number;
  section: string;
}

const here = (path: string): URL => new URL(path, import.meta.url);
const readJson = <Data>(path: string): Data => JSON.parse(readFileSync(here(path), 'utf8')) as Data;
const ENTITIES = readJson<Record<string, { characters: string } | undefined>>('./vendor/html-entities.json');
// The renderer decodes named references through a textarea, as the browser does; node gets the WHATWG table instead.
// Set before markdown.ts is imported below, the way the page has a document before it loads the module.
globalThis.document = {
  createElement: () => {
    let value = '';
    return { set innerHTML(html: string) { value = ENTITIES[html]?.characters ?? html; }, get value() { return value; } };
  },
} as unknown as Document;
const { parseInline, parseCellBlocks, parseDocumentBlocks, documentIndexOf, linkTargetOf, normalizeLabel, definitionOf, plainTextOf } = await import('../shared/web/markdown.ts');

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
  for (const example of readJson<SpecExample[]>('./vendor/commonmark-spec-0.31.2.json')) {
    if (!INLINE_SECTIONS.has(example.section)) continue;
    const link_definitions = new Map<string, LinkDefinition>();
    const paragraphs: string[] = [];
    for (const block of example.markdown.replace(/\n$/, '').split(/\n\n+/)) {
      const definition = definitionOf(block);
      if (definition?.kind === 'link_definition') { if (!link_definitions.has(normalizeLabel(definition.label))) link_definitions.set(normalizeLabel(definition.label), definition); }
      else paragraphs.push(block);
    }
    const is_single_paragraph = paragraphs.length === 1 && !/^( {4}|\t|[#>]|[-*+] |\d+[.)] |```|~~~|<\w)/m.test(paragraphs[0]) && !/^(=+|-+)\s*$/m.test(paragraphs[0]);
    if (!is_single_paragraph) continue;
    counts.eligible++;
    const actual = `<p>${htmlOf(parseInline(paragraphs[0].replace(/^ +/gm, '').replace(/ +$/, ''), { link_definitions }))}</p>\n`;
    const expected_with_breaks = example.html.replace(/<p>([\s\S]*?)<\/p>/g, (_: string, inner: string) => `<p>${inner.replace(/(?<!<br \/>)\n/g, '<br />\n')}</p>`);
    if (actual === example.html) counts.pass++;
    else if (actual === expected_with_breaks) counts.soft_break++;
    else if (/<[a-zA-Z!?/]/.test(example.markdown) && /</.test(actual) && actual.replace(/<br \/>\n/g, '\n').replace(/<[^>]+>/g, '') !== '') counts.raw_html_as_text++;
    else if (GFM_AUTOLINK_EXAMPLES.has(example.example)) counts.gfm_autolink++;
    else failures.push(`#${example.example} ${JSON.stringify(example.markdown)} expected ${JSON.stringify(example.html)} got ${JSON.stringify(actual)}`);
  }
  console.log('commonmark inline', JSON.stringify(counts));
  assert.deepEqual(failures, []);
});

// The table block a 'table' cell parsed to; fails the test when it parsed to anything else.
function tableBlockOf(blocks: Block[]): Extract<Block, { kind: 'table' }> {
  const block = blocks[0];
  assert.ok(block.kind === 'table', `expected a table, got ${block.kind}`);
  return block;
}

test('GFM tables, strikethrough and autolink literals', () => {
  const table = tableBlockOf(parseCellBlocks('table', '', 0, '| abc | defghi |\n:-: | -----------:\nbar | baz', { is_streaming: false, link_definitions: new Map() }));
  assert.deepEqual(table.alignments, ['center', 'right']);
  assert.equal(htmlOf(table.body_rows[0][1]), 'baz');
  const escaped_pipe = tableBlockOf(parseCellBlocks('table', '', 0, '| f\\|oo |\n| ------ |\n| b `\\|` az |', { is_streaming: false, link_definitions: new Map() }));
  assert.equal(htmlOf(escaped_pipe.header_cells[0]), 'f|oo');
  assert.equal(htmlOf(escaped_pipe.body_rows[0][0]), 'b <code>|</code> az');
  assert.equal(parseCellBlocks('table', '', 0, '| abc | def |\n| --- |\n| bar |', { is_streaming: false, link_definitions: new Map() })[0].kind, 'paragraph');
  const tab_separated = tableBlockOf(parseCellBlocks('table', '', 0, 'Domain\tExample\nVision\tViT', { is_streaming: false, link_definitions: new Map() }));
  assert.deepEqual(tab_separated.header_cells.map(htmlOf), ['Domain', 'Example']);
  assert.equal(htmlOf(parseInline('~~Hi~~ Hello, ~about~ 5')), '<del>Hi</del> Hello, ~about~ 5');
  assert.equal(htmlOf(parseInline('Visit www.commonmark.org/a.b.')), 'Visit <a href="http://www.commonmark.org/a.b">www.commonmark.org/a.b</a>.');
  assert.equal(htmlOf(parseInline('a.b-c_d@a.b-')), 'a.b-c_d@a.b-');
});

test('URL policy', () => {
  const anchor_ids = new Set(['md-overview']);
  assert.deepEqual(linkTargetOf('#overview', anchor_ids), { href: '#md-overview', is_external: false });
  assert.equal(linkTargetOf('#6-prospects', anchor_ids), null);
  assert.deepEqual(linkTargetOf('#6-prospects', null), { href: '#md-6-prospects', is_external: false });
  assert.equal(linkTargetOf('https://example.com/a b', anchor_ids)?.href, 'https://example.com/a%20b');
  assert.equal(linkTargetOf('mailto:team@example.com', anchor_ids)?.is_external, true);
  for (const unsafe of ['javascript:alert(1)', 'java\tscript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,x', 'file:///etc/passwd', './docs/setup.md', '/x']) {
    assert.equal(linkTargetOf(unsafe, anchor_ids), null, unsafe);
  }
});

test('document index: GitHub slugs, footnote order, entry 28 table of contents', () => {
  const entry = readJson<{ pairs: Pair[] }>('./fixtures/entry-28.json');
  const index = documentIndexOf(entry.pairs);
  const fragments = entry.pairs.flatMap((pair) => [...pair.source_text.matchAll(/\]\(#([^)]+)\)/g)].map((match) => match[1]));
  const resolved = fragments.filter((fragment) => index.anchor_ids.has(`md-${fragment}`));
  // The input stops at section 5, so the 7 entries for sections 6-12 have no heading to point at.
  assert.equal(fragments.length, 16);
  assert.equal(resolved.length, 9);
  const altman = documentIndexOf(readJson<{ pairs: Pair[] }>('./fixtures/entry-30.json').pairs);
  assert.equal(altman.footnote_numbers.get('1'), 1);
  assert.ok(altman.anchor_ids.has('md-fn-1') && altman.anchor_ids.has('md-fnref-1'));
});

const blockText = (block: Block): string => block.kind === 'paragraph' || block.kind === 'heading' ? plainTextOf(block.children)
  : block.kind === 'list_item' ? `${block.marker.text} ${block.blocks.map(blockText).join(' ')}`
  : block.kind === 'quote' ? block.blocks.map(blockText).join(' ')
  : block.kind === 'list' ? block.items.map((item) => item.map(blockText).join(' ')).join(' ')
  : block.kind === 'table' ? [block.header_cells, ...block.body_rows].map((row) => row.map(plainTextOf).join(' ')).join(' ')
  : block.kind === 'footnote_definition' ? `${block.label} ${plainTextOf(block.children)}`
  : block.kind === 'code_block' ? block.text : block.kind === 'link_definition' ? `${block.label} ${block.destination}` : '';
const visibleOf = (blocks: Block[]): string => blocks.map(blockText).join(' ').replace(/\s+/g, ' ').trim();

// Every prefix of every cell, with the index the app holds live (the pairs completed before this one); a frame is
// unstable when it shows text the cell's final render does not start with. Text only: style flips and reflow are not seen.
export function streamingStabilityOf(pairs: Pair[]): {
  frames: number; unstable_frames: number; cells: number; unstable_cells: string[]; end_of_stream_changes: string[];
} {
  const final_index = documentIndexOf(pairs);
  const result = { frames: 0, unstable_frames: 0, cells: 0, unstable_cells: [] as string[], end_of_stream_changes: [] as string[] };
  pairs.forEach((pair, pair_index) => {
    const live_index = documentIndexOf(pairs.slice(0, pair_index));
    for (const side of ['source', 'translation']) {
      const text = side === 'source' ? pair.source_text : pair.translation_text;
      const parse = (prefix: string, is_streaming: boolean, index: DocumentIndex): Block[] => parseCellBlocks(pair.pair_type, pair.marker, pair.level, prefix, { is_streaming, link_definitions: index.link_definitions });
      const final_text = visibleOf(parse(text, false, final_index));
      let cell_unstable = 0;
      for (let length = 1; length <= text.length; length++) {
        result.frames++;
        if (!final_text.startsWith(visibleOf(parse(text.slice(0, length), true, live_index)))) cell_unstable++;
      }
      result.cells++;
      result.unstable_frames += cell_unstable;
      if (cell_unstable) result.unstable_cells.push(`${pair_index}:${side}`);
      // Rendered final with the live index when the pair completed, then again with the whole document's index.
      if (visibleOf(parse(text, false, live_index)) !== final_text) result.end_of_stream_changes.push(`${pair_index}:${side}`);
    }
  });
  return result;
}

test('streaming: no raw syntax flashes in the real entries; the fixture flashes only its known edge cases', () => {
  for (const name of ['entry-28', 'entry-29', 'entry-30', 'entry-31', 'entry-32', 'fixture']) {
    const { pairs } = readJson<{ pairs: Pair[] }>(`./fixtures/${name}.json`);
    const result = streamingStabilityOf(pairs);
    console.log(name, JSON.stringify({ ...result, unstable_cells: result.unstable_cells.join(' '), end_of_stream_changes: result.end_of_stream_changes.join(' ') }));
    if (name === 'fixture') {
      // 3: "**Source:**text" is literal by CommonMark flanking but bold while streaming. 9: "[collapsed][]" has no
      // definition, so its held "[" comes back. 41: "[cm]:" reads as text until its destination makes it a definition.
      // 9 also changes at the end: "[the spec][cm]" resolves only once the "[cm]:" pair has arrived.
      assert.deepEqual(result.unstable_cells, ['3:source', '3:translation', '9:source', '9:translation', '41:source', '41:translation']);
      assert.deepEqual(result.end_of_stream_changes, ['9:source', '9:translation']);
    } else {
      assert.deepEqual(result.unstable_cells, []);
    }
  }
});

test('a whole document: headings, nested numbered and bullet lists, quotes, tables, and a list keeps counting', () => {
  const kinds = (blocks: Block[]) => blocks.map((block) => block.kind);
  const evaluation = '**Not yet.** One idea.\n\n## Fix first\n1. **A.** First line\n   second line\n2. **B.**\n   - sub one\n   - sub two\n3. **C.**\n\nSmall slips: capitals.\n\n## Corrected version\n> Fixed text.\n> More.\n\n---\n\n| a | b |\n|---|---|\n| 1 | 2 |';
  const blocks = parseDocumentBlocks(evaluation);
  assert.deepEqual(kinds(blocks), ['paragraph', 'heading', 'list', 'paragraph', 'heading', 'quote', 'thematic_break', 'table']);
  const list = blocks[2] as Extract<Block, { kind: 'list' }>;
  assert.deepEqual([list.is_ordered, list.start, list.items.length], [true, 1, 3]);
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
  assert.deepEqual(parseDocumentBlocks('Wrong: **not yet', true)[0], { kind: 'paragraph', children: parseInline('Wrong: **not yet', { is_streaming: true }) });
  assert.deepEqual(parseDocumentBlocks('Wrong: **not yet')[0], { kind: 'paragraph', children: parseInline('Wrong: **not yet') });
});
