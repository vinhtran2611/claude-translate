// The one Markdown renderer of the page. parse* functions are pure (text -> plain node tree), so node tests them;
// renderCellContent is the only DOM writer.
import type { Pair, PairType } from '../api.ts';

// ---------- Types ----------

export interface LinkDefinition {
  destination: string;
  title: string | null;
}

// is_streaming: the text may still grow (see parseInline). link_definitions: normalized label -> definition.
export interface InlineOptions {
  is_streaming?: boolean;
  link_definitions?: Map<string, LinkDefinition>;
}

// A link destination is null while a streaming "[label](" still waits for it.
export type InlineNode =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'line_break' }
  | { kind: 'autolink'; destination: string | null; text: string }
  | { kind: 'strong' | 'em' | 'del'; children: InlineNode[] }
  | { kind: 'link'; destination: string | null; title: string | null; children: InlineNode[] }
  | { kind: 'image'; destination: string | null; title: string | null; alt: string }
  | { kind: 'footnote_ref'; label: string };

export interface ListMarker {
  kind: 'bullet' | 'ordered' | 'task';
  text: string;
  is_checked: boolean;
}

export type Alignment = 'left' | 'center' | 'right';

export type Block =
  | { kind: 'paragraph'; children: InlineNode[] }
  | { kind: 'heading'; level: number; children: InlineNode[] }
  | { kind: 'thematic_break' }
  | { kind: 'list_item'; marker: ListMarker; blocks: Block[] }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'list'; is_ordered: boolean; start: number | null; items: Block[][] }
  | { kind: 'code_block'; language: string | null; text: string }
  | { kind: 'table'; alignments: (Alignment | null)[]; header_cells: InlineNode[][]; body_rows: InlineNode[][][] }
  | { kind: 'footnote_definition'; label: string; children: InlineNode[] }
  | { kind: 'link_definition'; label: string; destination: string; title: string | null };

type Definition =
  | { kind: 'footnote_definition'; label: string; body: string }
  | { kind: 'link_definition'; label: string; destination: string; title: string | null };

// The fields of a pair the cross-pair index reads.
export type IndexedPair = Pick<Pair, 'pair_type' | 'source_text' | 'translation_text'>;

export interface DocumentIndex {
  link_definitions: Map<string, LinkDefinition>;
  footnote_numbers: Map<string, number>;
  footnote_first_pair: Map<string, number>;
  heading_slugs: Map<number, string>;
  anchor_ids: Set<string>;
}

export interface LinkTarget {
  href: string;
  is_external: boolean;
}

export interface RenderContext {
  side: 'source' | 'translation';
  pair_index: number;
  document_index: DocumentIndex;
  is_streaming: boolean;
  is_document_complete: boolean;
}

// ---------- Inline grammar (CommonMark 0.31.2 inlines + GFM strikethrough, autolink literals, footnote refs) ----------

const ASCII_PUNCTUATION = /^[!-/:-@[-`{-~]$/;
// CommonMark 0.31.2 "Unicode punctuation character": general category P or S.
const UNICODE_PUNCTUATION = /^[\p{P}\p{S}]$/u;
const UNICODE_WHITESPACE = /^\s$/u;
const ENTITY_SOURCE = /^&(?:#[xX]([0-9a-fA-F]{1,6})|#([0-9]{1,7})|([A-Za-z][A-Za-z0-9]{1,31}));/;
const ENTITY_PREFIX_AT_END = /^&(?:#[xX]?[0-9a-fA-F]{0,7}|[A-Za-z][A-Za-z0-9]{0,31})?$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: CommonMark defines autolinks by these control characters.
const URI_AUTOLINK = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\u0000- <>]*)>/;
const EMAIL_AUTOLINK = /^<([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: CommonMark defines autolinks by these control characters.
const AUTOLINK_PREFIX_AT_END = /^<[A-Za-z][A-Za-z0-9+.-]{0,31}(?::[^\u0000- <>]*)?$|^<[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(?:@[a-zA-Z0-9.-]*)?$/;
// GFM extended autolinks (https://github.github.com/gfm/#autolinks-extension-), matched where a word starts.
const EXTENDED_URL_AUTOLINK = /^(?:(?:https?|ftp):\/\/|www\.)[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*[^\s<]*/iu;
const EXTENDED_EMAIL_AUTOLINK = /^[a-zA-Z0-9._+-]+@[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)+/;
const FOOTNOTE_REF = /^\[\^([^\s\]]{1,99})\]/;
const FOOTNOTE_REF_PREFIX_AT_END = /^\[\^[^\s\]]{0,99}$/;
const HTML_TAG = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)(?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*(\/?)>/;
// The rest of CommonMark's raw HTML (https://spec.commonmark.org/0.31.2/#raw-html). All raw HTML is matched whole, so
// its characters never open emphasis or links, and is then shown as literal text.
const OTHER_RAW_HTML = /^(?:<!--(?:-?>|[\s\S]*?-->)|<\?[\s\S]*?\?>|<![A-Za-z][^>]*>|<!\[CDATA\[[\s\S]*?\]\]>)/;

const CONSTRUCT_START = /[\\\n`*_~&<[\]!]/;
const PLAIN_TEXT_END = /[\\\n`*_~&<[\]!]|(?<=[\s*_~(])[a-zA-Z0-9]/g;
const isWhitespace = (char: string | undefined): boolean => char === undefined || UNICODE_WHITESPACE.test(char);
const isPunctuation = (char: string | undefined): boolean => char !== undefined && (ASCII_PUNCTUATION.test(char) || UNICODE_PUNCTUATION.test(char));

export function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase();
}

function decodeEntity(match: RegExpExecArray): string | null {
  const [, hex_digits, decimal_digits, name] = match;
  if (name) return decodeNamedEntity(name);
  const code_point = hex_digits ? parseInt(hex_digits, 16) : parseInt(decimal_digits, 10);
  return code_point === 0 || code_point > 0x10ffff || (code_point >= 0xd800 && code_point <= 0xdfff) ? '�' : String.fromCodePoint(code_point);
}

const named_entity_cache = new Map<string, string | null>();
// The browser knows all 2,231 HTML named references; a textarea parses its content as RCDATA, so no markup runs.
function decodeNamedEntity(name: string): string | null {
  if (named_entity_cache.has(name)) return named_entity_cache.get(name) ?? null;
  let decoded: string | null = null;
  const textarea = document.createElement('textarea');
  textarea.innerHTML = `&${name};`;
  decoded = textarea.value === `&${name};` ? null : textarea.value;
  named_entity_cache.set(name, decoded);
  return decoded;
}

function unescapeString(text: string): string {
  return text
    .replace(/\\([!-/:-@[-`{-~])/g, '$1')
    .replace(/&(?:#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/g, (entity) => {
      const match = ENTITY_SOURCE.exec(entity);
      return (match && decodeEntity(match)) ?? entity;
    });
}

// Inline destination and optional title after "](" (https://spec.commonmark.org/0.31.2/#inline-link).
// 'incomplete': the text ended before the closing paren could arrive.
type LinkTail = { status: 'fail' | 'incomplete' } | { status: 'ok'; destination: string; title: string | null; end: number };

function parseLinkTail(text: string, start: number): LinkTail {
  let position = start + 1;
  const skipSpaces = () => { while (position < text.length && /[ \t\n]/.test(text[position])) position++; };
  skipSpaces();
  if (position >= text.length) return { status: 'incomplete' };
  let destination = '';
  if (text[position] === '<') {
    const close = text.slice(position + 1).search(/(?<!\\)[<>\n]/);
    if (close === -1) return { status: /\n/.test(text.slice(position)) ? 'fail' : 'incomplete' };
    if (text[position + 1 + close] !== '>') return { status: 'fail' };
    destination = text.slice(position + 1, position + 1 + close);
    position += close + 2;
  } else {
    let depth = 0;
    const destination_start = position;
    while (position < text.length) {
      const char = text[position];
      if (char === '\\' && position + 1 < text.length && ASCII_PUNCTUATION.test(text[position + 1])) { position += 2; continue; }
      if (char === '(') depth++;
      else if (char === ')') { if (depth === 0) break; depth--; }
      // biome-ignore lint/suspicious/noControlCharactersInRegex: CommonMark ends a bare URL at a control character.
      else if (/[\u0000- \u007f]/.test(char)) break;
      position++;
    }
    if (position >= text.length) return { status: 'incomplete' };
    destination = text.slice(destination_start, position);
  }
  const before_title = position;
  skipSpaces();
  if (position >= text.length) return { status: 'incomplete' };
  let title: string | null = null;
  const title_opener = text[position];
  if (position > before_title && (title_opener === '"' || title_opener === "'" || title_opener === '(')) {
    const title_closer = title_opener === '(' ? ')' : title_opener;
    let scan = position + 1;
    while (scan < text.length && text[scan] !== title_closer) scan += text[scan] === '\\' ? 2 : 1;
    if (scan >= text.length) return { status: 'incomplete' };
    title = unescapeString(text.slice(position + 1, scan));
    position = scan + 1;
    skipSpaces();
    if (position >= text.length) return { status: 'incomplete' };
  }
  if (text[position] !== ')') return { status: 'fail' };
  return { status: 'ok', destination: unescapeString(destination), title, end: position + 1 };
}

// GFM: a trailing ? ! . , : * _ ~ is not part of the link, and neither is an unbalanced trailing ")" or an entity.
function trimAutolinkTail(url: string): string {
  let trimmed = url;
  while (true) {
    const before = trimmed;
    trimmed = trimmed.replace(/[?!.,:*_~'"]+$/, '');
    if (trimmed.endsWith(')') && (trimmed.match(/\(/g) ?? []).length < (trimmed.match(/\)/g) ?? []).length) trimmed = trimmed.slice(0, -1);
    trimmed = trimmed.replace(/&[A-Za-z0-9]+;$/, '');
    if (trimmed === before) return trimmed;
  }
}

// A node of parseInline's working list. One shape for every kind, since emphasis rewraps nodes in place.
interface ListNode {
  kind: 'root' | InlineNode['kind'];
  text?: string;
  destination?: string | null;
  title?: string | null;
  label?: string;
  parent: ListNode | null;
  prev: ListNode | null;
  next: ListNode | null;
  first: ListNode | null;
  last: ListNode | null;
}

// A node as written before it is linked into the list.
type NewListNode = Omit<Partial<ListNode>, 'kind'> & { kind: ListNode['kind'] };
type TextListNode = ListNode & { text: string };

// https://spec.commonmark.org/0.31.2/#delimiter-run, one entry of the delimiter stack.
interface Delimiter {
  char: string;
  length: number;
  original_length: number;
  can_open: boolean;
  can_close: boolean;
  is_at_text_end: boolean;
  node: TextListNode;
  previous: Delimiter | null;
  next: Delimiter | null;
}

// An open "[" or "![", waiting for its "]".
interface BracketOpener {
  node: TextListNode;
  is_image: boolean;
  is_active: boolean;
  previous_delimiter: Delimiter | null;
  label_start: number;
  previous: BracketOpener | null;
}

// Inline nodes for one cell's text.
// is_streaming changes only what happens at the END of the text, to a construct whose closing part has not arrived:
// a code span, emphasis run, link destination or "<https://" autolink renders as if it closed there (link
// destination null), and anything still undecided ("[label", "[^1", "&am", a trailing "\", "<", "!", "~" or a bare
// delimiter run) is not shown yet. Without is_streaming the same text parses strictly by the spec.
export function parseInline(text: string, { is_streaming = false, link_definitions = new Map() }: InlineOptions = {}): InlineNode[] {
  // Doubly linked list of nodes, as in the reference implementation, so emphasis can wrap ranges in place.
  const root: ListNode = { kind: 'root', parent: null, prev: null, next: null, first: null, last: null };
  let delimiter_top: Delimiter | null = null;
  let bracket_top: BracketOpener | null = null;
  let position = 0;
  let text_buffer = '';

  const append = <Node extends NewListNode>(new_node: Node): ListNode & Node => {
    const node = new_node as ListNode & Node;
    node.parent = root; node.prev = root.last; node.next = null;
    if (root.last) root.last.next = node; else root.first = node;
    root.last = node;
    return node;
  };
  const flushText = () => { if (text_buffer !== '') { append({ kind: 'text', text: text_buffer }); text_buffer = ''; } };
  const unlink = (node: ListNode): void => {
    const parent = node.parent as ListNode;
    if (node.prev) node.prev.next = node.next; else parent.first = node.next;
    if (node.next) node.next.prev = node.prev; else parent.last = node.prev;
    node.prev = node.next = null;
  };
  // Moves the siblings strictly between from_node and to_node (to the end when to_node is null) into container,
  // and puts container right after from_node.
  const wrapBetween = (from_node: ListNode, to_node: ListNode | null, new_container: NewListNode): ListNode => {
    const parent = from_node.parent as ListNode;
    const container = new_container as ListNode;
    container.first = container.last = null;
    let node = from_node.next;
    while (node && node !== to_node) {
      const next = node.next;
      unlink(node);
      node.parent = container; node.prev = container.last; node.next = null;
      if (container.last) container.last.next = node; else container.first = node;
      container.last = node;
      node = next;
    }
    container.parent = parent;
    container.prev = from_node; container.next = from_node.next;
    if (from_node.next) from_node.next.prev = container; else parent.last = container;
    from_node.next = container;
    return container;
  };
  const removeDelimiter = (delimiter: Delimiter): void => {
    if (delimiter.previous) delimiter.previous.next = delimiter.next;
    if (delimiter.next) delimiter.next.previous = delimiter.previous; else delimiter_top = delimiter.previous;
  };
  const clearDelimiters = (stack_bottom: Delimiter | null): void => { while (delimiter_top && delimiter_top !== stack_bottom) removeDelimiter(delimiter_top); };

  // https://spec.commonmark.org/0.31.2/#process-emphasis, plus GFM strikethrough ("~~" pairs). Leaves unmatched
  // openers on the stack; the caller clears them.
  const processEmphasis = (stack_bottom: Delimiter | null): void => {
    const openers_bottom = new Map<string, Delimiter | null>();
    let closer = delimiter_top;
    while (closer && closer.previous !== stack_bottom) closer = closer.previous;
    while (closer) {
      if (!closer.can_close) { closer = closer.next; continue; }
      let opener = closer.previous;
      let is_found = false;
      const bottom_key = `${closer.char}${closer.can_open}${closer.original_length % 3}`;
      while (opener && opener !== stack_bottom && opener !== openers_bottom.get(bottom_key)) {
        const is_odd_match = closer.char !== '~' && (closer.can_open || opener.can_close)
          && closer.original_length % 3 !== 0 && (opener.original_length + closer.original_length) % 3 === 0;
        if (opener.char === closer.char && opener.can_open && !is_odd_match) { is_found = true; break; }
        opener = opener.previous;
      }
      const old_closer = closer;
      if (is_found && opener) {
        const used = closer.char === '~' ? 2 : closer.length >= 2 && opener.length >= 2 ? 2 : 1;
        opener.length -= used; closer.length -= used;
        opener.node.text = opener.node.text.slice(0, opener.length);
        closer.node.text = closer.node.text.slice(0, closer.length);
        wrapBetween(opener.node, closer.node, { kind: closer.char === '~' ? 'del' : used === 2 ? 'strong' : 'em' });
        let between = closer.previous;
        while (between && between !== opener) { const previous = between.previous; removeDelimiter(between); between = previous; }
        if (opener.length === 0) { unlink(opener.node); removeDelimiter(opener); }
        if (closer.length === 0) { const next = closer.next; unlink(closer.node); removeDelimiter(closer); closer = next; }
      } else {
        closer = closer.next;
        openers_bottom.set(bottom_key, old_closer.previous);
        if (!old_closer.can_open) removeDelimiter(old_closer);
      }
    }
  };

  // Streaming only, after processEmphasis(null): each opener still unmatched wraps everything after it, as if its
  // closer were the next character ("**bol" -> strong "bol").
  const closeOpenersAtEnd = () => {
    for (let delimiter = delimiter_top; delimiter; delimiter = delimiter.previous) {
      if (!delimiter.can_open || delimiter.is_at_text_end) continue;
      const kinds: ('del' | 'em' | 'strong')[] =
        delimiter.char === '~' ? ['del'] : delimiter.length >= 3 ? ['em', 'strong'] : [delimiter.length === 2 ? 'strong' : 'em'];
      for (const kind of kinds) wrapBetween(delimiter.node, null, { kind });
      delimiter.node.text = '';
    }
  };

  const pushDelimiterRun = (char: string): void => {
    let run_end = position;
    while (text[run_end] === char) run_end++;
    const run = text.slice(position, run_end);
    const is_at_text_end = run_end === text.length;
    // Only "~~" strikes through. GFM also accepts a single "~", but in prose that means "about" (~5 ms), and two in
    // one paragraph would strike out everything between them. A single "~" at the very end may still become "~~".
    if (char === '~' && run.length === 1 && is_at_text_end && is_streaming) { position = run_end; return; }
    if (char === '~' && run.length !== 2) { text_buffer += run; position = run_end; return; }
    const char_before = position === 0 ? undefined : text[position - 1];
    const char_after = text[run_end];
    const is_left_flanking = !isWhitespace(char_after) && (!isPunctuation(char_after) || isWhitespace(char_before) || isPunctuation(char_before));
    const is_right_flanking = !isWhitespace(char_before) && (!isPunctuation(char_before) || isWhitespace(char_after) || isPunctuation(char_after));
    const can_open = char === '_' ? is_left_flanking && (!is_right_flanking || isPunctuation(char_before)) : is_left_flanking;
    const can_close = char === '_' ? is_right_flanking && (!is_left_flanking || isPunctuation(char_after)) : is_right_flanking;
    flushText();
    const node = append({ kind: 'text', text: run });
    const delimiter: Delimiter = { char, length: run.length, original_length: run.length, can_open, can_close, is_at_text_end, node, previous: delimiter_top, next: null };
    if (delimiter_top) delimiter_top.next = delimiter;
    delimiter_top = delimiter;
    position = run_end;
  };

  const appendAutolink = (destination: string | null, link_text: string): void => { flushText(); append({ kind: 'autolink', destination, text: link_text }); };
  const isWordStart = (): boolean => position === 0 || /[\s*_~(]/.test(text[position - 1]);

  while (position < text.length) {
    const char = text[position];
    if (!CONSTRUCT_START.test(char) && !(isWordStart() && /[a-zA-Z0-9]/.test(char))) {
      // Plain text runs to the next character that can start a construct, or to the next word start (autolinks).
      PLAIN_TEXT_END.lastIndex = position + 1;
      const run_end = PLAIN_TEXT_END.exec(text)?.index ?? text.length;
      text_buffer += text.slice(position, run_end);
      position = run_end;
      continue;
    }
    const rest = text.slice(position);
    if (is_streaming && (rest === '<' || rest === '!' || rest === '\\')) { position++; continue; }

    if (char === '\\') {
      const next = text[position + 1];
      if (next === '\n') { flushText(); append({ kind: 'line_break' }); position += 2; while (text[position] === ' ') position++; continue; }
      if (next !== undefined && ASCII_PUNCTUATION.test(next)) { text_buffer += next; position += 2; continue; }
      text_buffer += '\\'; position++; continue;
    }

    if (char === '\n') {
      // Soft and hard breaks both render as a line break: the translator keeps only the breaks the author meant.
      text_buffer = text_buffer.replace(/ +$/, '');
      flushText();
      append({ kind: 'line_break' });
      position++;
      while (text[position] === ' ') position++;
      continue;
    }

    if (char === '`') {
      let run_end = position;
      while (text[run_end] === '`') run_end++;
      const run_length = run_end - position;
      const closer = new RegExp(`(?<!\`)\`{${run_length}}(?!\`)`, 'g');
      closer.lastIndex = run_end;
      const close_match = closer.exec(text);
      if (close_match) {
        let code = text.slice(run_end, close_match.index).replace(/\n/g, ' ');
        if (/^ .*[^ ].* $|^ [^ ] $/s.test(code)) code = code.slice(1, -1);
        flushText(); append({ kind: 'code', text: code });
        position = close_match.index + run_length;
        continue;
      }
      if (is_streaming) {
        // Backticks at the very end may be the closer still arriving, so they are not shown as code.
        const code = text.slice(run_end).replace(/`+$/, '').replace(/\n/g, ' ');
        flushText();
        if (code !== '') append({ kind: 'code', text: code });
        position = text.length;
        continue;
      }
      text_buffer += text.slice(position, run_end); position = run_end; continue;
    }

    if (char === '*' || char === '_' || char === '~') { pushDelimiterRun(char); continue; }

    if (char === '&') {
      const entity_match = ENTITY_SOURCE.exec(rest);
      const decoded = entity_match && decodeEntity(entity_match);
      if (decoded !== null && entity_match) { text_buffer += decoded; position += entity_match[0].length; continue; }
      if (is_streaming && ENTITY_PREFIX_AT_END.test(rest)) { position = text.length; continue; }
      text_buffer += '&'; position++; continue;
    }

    if (char === '<') {
      const uri_match = URI_AUTOLINK.exec(rest);
      const autolink_match = uri_match ?? EMAIL_AUTOLINK.exec(rest);
      if (autolink_match) {
        const address = autolink_match[1];
        appendAutolink(uri_match ? address : `mailto:${address}`, address);
        position += autolink_match[0].length;
        continue;
      }
      const raw_html_match = HTML_TAG.exec(rest) ?? OTHER_RAW_HTML.exec(rest);
      if (raw_html_match) { text_buffer += raw_html_match[0]; position += raw_html_match[0].length; continue; }
      if (is_streaming && /^<https?:\/\/[^\s<>]+$/i.test(rest)) { appendAutolink(null, rest.slice(1)); position = text.length; continue; }
      if (is_streaming && AUTOLINK_PREFIX_AT_END.test(rest)) { position = text.length; continue; }
      text_buffer += '<'; position++; continue;
    }

    if (char === '[' && text[position + 1] === '^') {
      const footnote_match = FOOTNOTE_REF.exec(rest);
      if (footnote_match && text[position + footnote_match[0].length] !== ':') {
        flushText(); append({ kind: 'footnote_ref', label: footnote_match[1] });
        position += footnote_match[0].length;
        continue;
      }
      if (is_streaming && FOOTNOTE_REF_PREFIX_AT_END.test(rest)) { position = text.length; continue; }
    }

    if (char === '[' || (char === '!' && text[position + 1] === '[')) {
      const is_image = char === '!';
      flushText();
      const node = append({ kind: 'text', text: is_image ? '![' : '[' });
      bracket_top = { node, is_image, is_active: true, previous_delimiter: delimiter_top, label_start: position + (is_image ? 2 : 1), previous: bracket_top };
      position += is_image ? 2 : 1;
      continue;
    }

    if (char === ']') {
      flushText();
      const opener: BracketOpener | null = bracket_top;
      if (!opener) { text_buffer += ']'; position++; continue; }
      if (!opener.is_active) { bracket_top = opener.previous; text_buffer += ']'; position++; continue; }
      const label_text = text.slice(opener.label_start, position);
      const next_char = text[position + 1];
      let target: { destination: string | null; title: string | null } | null = null;
      let end_position = position + 1;
      let is_destination_arriving = false;
      if (next_char === '(') {
        const tail = parseLinkTail(text, position + 1);
        if (tail.status === 'ok') { target = { destination: tail.destination, title: tail.title }; end_position = tail.end; }
        is_destination_arriving = tail.status === 'incomplete' && is_streaming;
      }
      // "[label]" at the very end, or "[label][ref" still arriving: whether it becomes a link is not decided yet.
      const is_label_undecided = is_streaming && !target && (next_char === undefined || (next_char === '[' && !text.slice(position + 2).includes(']')));
      if (!target && !is_destination_arriving && !is_label_undecided) {
        const full_reference = /^\[((?:[^\\[\]]|\\.){0,999})\]/.exec(text.slice(position + 1));
        const reference_label = full_reference && full_reference[1].trim() !== '' ? full_reference[1] : label_text;
        const definition = reference_label.trim() === '' ? undefined : link_definitions.get(normalizeLabel(reference_label));
        if (definition) {
          target = definition;
          end_position = full_reference ? position + 1 + full_reference[0].length : position + 1;
        }
      }
      if (is_label_undecided) {
        processEmphasis(opener.previous_delimiter);
        clearDelimiters(opener.previous_delimiter);
        unlink(opener.node);
        bracket_top = opener.previous;
        position = text.length;
        continue;
      }
      if (is_destination_arriving) { target = { destination: null, title: null }; end_position = text.length; }
      if (target) {
        wrapBetween(opener.node, null, opener.is_image
          ? { kind: 'image', destination: target.destination, title: target.title }
          : { kind: 'link', destination: target.destination, title: target.title });
        processEmphasis(opener.previous_delimiter);
        clearDelimiters(opener.previous_delimiter);
        unlink(opener.node);
        bracket_top = opener.previous;
        if (!opener.is_image) for (let earlier = bracket_top; earlier; earlier = earlier.previous) if (!earlier.is_image) earlier.is_active = false;
        position = end_position;
        continue;
      }
      bracket_top = opener.previous;
      text_buffer += ']'; position++; continue;
    }

    if (isWordStart() && /[hHwWfF]/.test(char)) {
      const url_match = EXTENDED_URL_AUTOLINK.exec(rest);
      if (url_match) {
        const url = trimAutolinkTail(url_match[0]);
        const domain = url.replace(/^(?:(?:https?|ftp):\/\/)/i, '').split(/[/?#]/)[0];
        if (domain !== '' && (/\./.test(domain) || /^(?:https?|ftp):\/\//i.test(url))) {
          appendAutolink(/^www\./i.test(url) ? `http://${url}` : url, url);
          position += url.length;
          continue;
        }
      }
    }
    if (isWordStart() && /[a-zA-Z0-9._+-]/.test(char)) {
      const email_match = EXTENDED_EMAIL_AUTOLINK.exec(rest);
      if (email_match) {
        const email = email_match[0].replace(/\.+$/, '');
        // GFM: a trailing "." is not part of the address, and one ending in "-" or "_" is no address at all.
        if (!/[-_]$/.test(email) && /@[^@]+\.[^.@]+$/.test(email)) {
          appendAutolink(`mailto:${email}`, email);
          position += email.length;
          continue;
        }
      }
    }

    text_buffer += char;
    position++;
  }
  flushText();

  // Brackets still open at the end of a streaming cell: their "[" is not shown, so the label reads as plain text.
  if (is_streaming) for (let opener = bracket_top; opener; opener = opener.previous) opener.node.text = '';
  // Taken before processEmphasis, which drops a run that can only close: at the very end it may still be a closer arriving.
  // The cast undoes a narrowing to null: tsc does not see the closures above that push delimiters.
  const last_delimiter = delimiter_top as Delimiter | null;
  const run_at_text_end = last_delimiter?.is_at_text_end ? last_delimiter : null;
  processEmphasis(null);
  if (is_streaming) {
    closeOpenersAtEnd();
    if (run_at_text_end) run_at_text_end.node.text = '';
  }
  clearDelimiters(null);
  return toPlainNodes(root, false);
}

// Linked list -> plain nested arrays, merging adjacent text. A link inside a link (only an autolink can get there)
// keeps its text and loses its link.
function toPlainNodes(container: ListNode, is_inside_link: boolean): InlineNode[] {
  const nodes: InlineNode[] = [];
  for (let node = container.first; node; node = node.next) {
    const text = node.text ?? '';
    const destination = node.destination ?? null;
    const title = node.title ?? null;
    if (node.kind === 'text') { if (text !== '') nodes.push({ kind: 'text', text }); continue; }
    if (node.kind === 'autolink') { nodes.push(is_inside_link ? { kind: 'text', text } : { kind: 'autolink', destination, text }); continue; }
    if (node.kind === 'link') {
      const children = toPlainNodes(node, true);
      if (is_inside_link) nodes.push(...children);
      else nodes.push({ kind: 'link', destination, title, children });
      continue;
    }
    if (node.kind === 'image') { nodes.push({ kind: 'image', destination, title, alt: plainTextOf(toPlainNodes(node, true)) }); continue; }
    if (node.kind === 'strong' || node.kind === 'em' || node.kind === 'del') { nodes.push({ kind: node.kind, children: toPlainNodes(node, is_inside_link) }); continue; }
    if (node.kind === 'code') { nodes.push({ kind: 'code', text }); continue; }
    if (node.kind === 'footnote_ref') { nodes.push({ kind: 'footnote_ref', label: node.label ?? '' }); continue; }
    nodes.push({ kind: 'line_break' });
  }
  const merged: InlineNode[] = [];
  for (const node of nodes) {
    const last = merged.at(-1);
    if (node.kind === 'text' && last?.kind === 'text') last.text += node.text;
    else merged.push(node);
  }
  return merged;
}

export function plainTextOf(nodes: InlineNode[]): string {
  return nodes.map((node) => node.kind === 'text' || node.kind === 'code' || node.kind === 'autolink' ? node.text
    : node.kind === 'line_break' ? ' ' : node.kind === 'image' ? node.alt
    : node.kind === 'footnote_ref' ? '' : plainTextOf(node.children)).join('');
}

// ---------- Block layer: pair_type already names the block, so each type has exactly one shape ----------

// CommonMark thematic break (https://spec.commonmark.org/0.31.2/#thematic-breaks), except any indentation is accepted.
export const THEMATIC_BREAK = /^\s*([-*_])(\s*\1){2,}\s*$/;
const THEMATIC_BREAK_PREFIX = /^\s*([-*_])(\s*\1)?\s*$/;
const FOOTNOTE_DEFINITION = /^\[\^([^\s\]]{1,99})\]:[ \t]*/;
const LINK_DEFINITION = /^\[((?:[^\\[\]]|\\.){1,999})\]:[ \t]*\n?[ \t]*(<[^<>\n]*>|\S+)(?:[ \t]+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?[ \t]*$/;
const TABLE_DELIMITER_ROW = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const TABLE_DELIMITER_PREFIX = /^\s*\|?[\s:|-]*$/;
const ORDERED_MARKER = /^(\d{1,9})([.)])$/;
const TASK_MARKER = /^[-*+]\s+\[([ xX])\]$/;

// One block list per cell.
export function parseCellBlocks(pair_type: PairType, marker: string, level: number, text: string, inline_options: InlineOptions): Block[] {
  const inline = (inline_text: string): InlineNode[] => parseInline(inline_text, inline_options);
  if (pair_type === 'code') return [{ kind: 'code_block', language: marker.replace(/^[`~]+\s*/, '').split(/\s/)[0] || null, text }];
  if (pair_type === 'heading') return [{ kind: 'heading', level: Math.min(6, Math.max(1, level)), children: inline(text.replace(/\n+/g, ' ')) }];
  if (pair_type === 'table') return [tableBlockOf(text, inline_options) ?? { kind: 'paragraph', children: inline(text) }];
  if (pair_type === 'quote') return [{ kind: 'quote', blocks: quoteBlocksOf(quoteContentOf(text), inline_options) }];
  if (pair_type === 'list_item') return [{ kind: 'list_item', marker: listMarkerOf(marker, level), blocks: paragraphsOf(text, inline_options) }];
  if (pair_type === 'other' && THEMATIC_BREAK.test(text)) return [{ kind: 'thematic_break' }];
  // A streaming "-" or "--" may be a thematic break still arriving: nothing is shown until it is decided.
  if (pair_type === 'other' && inline_options.is_streaming && THEMATIC_BREAK_PREFIX.test(text)) return [];
  const definition = definitionOf(text);
  if (definition?.kind === 'footnote_definition') return [{ kind: 'footnote_definition', label: definition.label, children: inline(definition.body) }];
  if (definition?.kind === 'link_definition') return [definition];
  return paragraphsOf(text, inline_options);
}

export function definitionOf(text: string): Definition | null {
  const footnote_match = FOOTNOTE_DEFINITION.exec(text);
  if (footnote_match) return { kind: 'footnote_definition', label: footnote_match[1], body: text.slice(footnote_match[0].length) };
  const link_match = LINK_DEFINITION.exec(text.trim());
  if (!link_match || link_match[1].trim() === '') return null;
  const title = link_match[3] ?? link_match[4] ?? link_match[5];
  return { kind: 'link_definition', label: link_match[1], destination: unescapeString(link_match[2].replace(/^<|>$/g, '')), title: title === undefined ? null : unescapeString(title) };
}

export function listMarkerOf(marker: string, level: number): ListMarker {
  const task_match = TASK_MARKER.exec(marker.trim());
  if (task_match) return { kind: 'task', text: '', is_checked: task_match[1] !== ' ' };
  const ordered_match = ORDERED_MARKER.exec(marker.trim());
  if (ordered_match) return { kind: 'ordered', text: `${ordered_match[1]}${ordered_match[2]}`, is_checked: false };
  return { kind: 'bullet', text: ['•', '◦', '▪'][(Math.max(1, level) - 1) % 3], is_checked: false };
}

// The model copies a quote without its first "> ", but inner lines may or may not keep theirs. When every inner
// non-blank line starts with ">", that marker is the outer quote's and is stripped once; otherwise lines are content.
export function quoteContentOf(text: string): string {
  const lines = text.replace(/^>[ \t]?/, '').split('\n');
  const inner_lines = lines.slice(1).filter((line) => line.trim() !== '');
  const has_outer_markers = inner_lines.length > 0 && inner_lines.every((line) => /^\s*>/.test(line));
  return has_outer_markers ? [lines[0], ...lines.slice(1).map((line) => line.replace(/^\s*>[ \t]?/, ''))].join('\n') : lines.join('\n');
}

// The streaming tail policy belongs to the end of the cell's text only: a segment that something else follows
// (an earlier paragraph, a finished table cell) is parsed as final.
function optionsAt(inline_options: InlineOptions, is_at_text_end: boolean): InlineOptions {
  return inline_options.is_streaming && !is_at_text_end ? { ...inline_options, is_streaming: false } : inline_options;
}

function paragraphsOf(text: string, inline_options: InlineOptions): Block[] {
  const parts = text.split(/\n[ \t]*\n/).filter((part) => part.trim() !== '');
  return parts.map((part, index) => ({ kind: 'paragraph', children: parseInline(part.trim(), optionsAt(inline_options, index === parts.length - 1)) }));
}

function quoteBlocksOf(text: string, inline_options: InlineOptions): Block[] {
  const blocks: Block[] = [];
  const lines = text.split('\n');
  const LIST_LINE = /^\s*([-*+]|\d{1,9}[.)])\s+/;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === '') { index++; continue; }
    if (/^\s*>/.test(line)) {
      const nested: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) nested.push(lines[index++].replace(/^\s*>[ \t]?/, ''));
      blocks.push({ kind: 'quote', blocks: quoteBlocksOf(nested.join('\n'), optionsAt(inline_options, index === lines.length)) });
      continue;
    }
    const list_match = LIST_LINE.exec(line);
    if (list_match) {
      const is_ordered = /\d/.test(list_match[1]);
      const items: Block[][] = [];
      while (index < lines.length && LIST_LINE.test(lines[index])) {
        const item_text = lines[index++].replace(LIST_LINE, '');
        items.push([{ kind: 'paragraph', children: parseInline(item_text, optionsAt(inline_options, index === lines.length)) }]);
      }
      blocks.push({ kind: 'list', is_ordered, start: is_ordered ? parseInt(list_match[1], 10) : null, items });
      continue;
    }
    if (THEMATIC_BREAK.test(line)) { blocks.push({ kind: 'thematic_break' }); index++; continue; }
    // A streaming last line that is still only a list marker ("-", "2.") is held until its item text arrives.
    if (inline_options.is_streaming && index === lines.length - 1 && /^\s*([-*+]|\d{1,9}[.)]?)\s*$/.test(line)) break;
    const paragraph_lines: string[] = [];
    while (index < lines.length && lines[index].trim() !== '' && !/^\s*>/.test(lines[index])) paragraph_lines.push(lines[index++]);
    blocks.push({ kind: 'paragraph', children: parseInline(paragraph_lines.join('\n'), optionsAt(inline_options, index === lines.length)) });
  }
  return blocks;
}

// GFM pipe table (https://github.github.com/gfm/#tables-extension-), or tab-separated rows as pasted from a doc.
// While streaming, a delimiter row still arriving is held back so "|--" never flashes as a row. null: not a table.
function tableBlockOf(text: string, inline_options: InlineOptions): Block | null {
  const lines = text.split('\n').map((line) => line.replace(/\r$/, '')).filter((line) => line.trim() !== '');
  if (lines.length === 0) return null;
  const is_streaming = inline_options.is_streaming;
  // A backslash ending a streaming row may be escaping a pipe that has not arrived; it is held like any other.
  if (is_streaming) lines[lines.length - 1] = lines[lines.length - 1].replace(/(?<!\\)(\\\\)*\\$/, '$1');
  const is_pipe_table = lines[0].includes('|');
  const separator = is_pipe_table ? null : '\t';
  if (!is_pipe_table && !lines[0].includes('\t')) return null;
  const cellsOf = (line: string): string[] => is_pipe_table ? splitTableRow(line) : line.split('\t').map((cell) => cell.trim());
  // Only the last cell of the last line can still be growing, and only if no separator has closed it yet.
  const rowOf = (line: string, line_index: number): InlineNode[][] => {
    const cells = cellsOf(line);
    const is_last_line = line_index === lines.length - 1;
    const is_line_closed = is_pipe_table ? /(?<!\\)\|\s*$/.test(line) : separator !== null && line.endsWith(separator);
    return cells.map((cell, column) => parseInline(cell, optionsAt(inline_options, is_last_line && !is_line_closed && column === cells.length - 1)));
  };
  const header_line_index = 0;
  let body_start = 1;
  let alignments: (Alignment | null)[] = [];
  if (is_pipe_table) {
    const has_delimiter_row = lines.length > 1 && TABLE_DELIMITER_ROW.test(lines[1]) && lines[1].includes('-')
      && splitTableRow(lines[1]).length === splitTableRow(lines[0]).length;
    const is_delimiter_arriving = is_streaming && (lines.length === 1 || lines.length === 2 && TABLE_DELIMITER_PREFIX.test(lines[1]));
    if (!has_delimiter_row && !is_delimiter_arriving) return null;
    alignments = has_delimiter_row
      ? splitTableRow(lines[1]).map((cell) => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : cell.startsWith(':') ? 'left' : null)
      : [];
    body_start = has_delimiter_row ? 2 : lines.length;
  }
  const header_cells = rowOf(lines[header_line_index], header_line_index);
  const body_rows = lines.slice(body_start).map((line, offset) => rowOf(line, body_start + offset));
  const column_count = is_pipe_table ? header_cells.length : Math.max(header_cells.length, ...body_rows.map((cells) => cells.length));
  const fit = <Cell>(cells: Cell[], empty: Cell): Cell[] => Array.from({ length: column_count }, (_, column) => cells[column] ?? empty);
  return {
    kind: 'table',
    alignments: fit(alignments, null),
    header_cells: fit(header_cells, []),
    body_rows: body_rows.map((cells) => fit(cells, [])),
  };
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

// ---------- Whole documents: text that no model split into pairs (Practice's evaluation), blocks found by line syntax ----------

const ATX_HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const LIST_LINE = /^( {0,3})([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const CODE_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)/;
const QUOTE_LINE = /^ {0,3}>/;

const indentOf = (line: string): number => line.length - line.trimStart().length;
const isOrderedMarker = (marker: string): boolean => /\d/.test(marker);
const startsBlock = (line: string): boolean => [ATX_HEADING, LIST_LINE, CODE_FENCE, QUOTE_LINE, THEMATIC_BREAK].some((pattern) => pattern.test(line));

// The list that starts at lines[start], and the index of the line after it. Items hold blocks, so a nested list or a
// second paragraph is just more lines indented under the item; a line that is not indented continues the item's text.
function listAt(lines: string[], start: number, is_streaming: boolean): [Block, number] {
  const first = LIST_LINE.exec(lines[start])!;
  const is_ordered = isOrderedMarker(first[2]);
  const items: Block[][] = [];
  let index = start;
  while (index < lines.length) {
    const match = LIST_LINE.exec(lines[index]);
    if (match === null || isOrderedMarker(match[2]) !== is_ordered || THEMATIC_BREAK.test(lines[index])) break;
    const content_column = match[1].length + match[2].length + 1;
    const body = [match[3]];
    index++;
    while (index < lines.length) {
      const next = lines[index];
      if (next.trim() === '') {
        let ahead = index;
        while (ahead < lines.length && lines[ahead].trim() === '') ahead++;
        // Blank lines stay in the item only when more of the item follows them.
        if (ahead === lines.length || indentOf(lines[ahead]) < 2) break;
        body.push(...Array<string>(ahead - index).fill(''));
        index = ahead;
      } else if (indentOf(next) >= 2 || !startsBlock(next)) {
        body.push(next.slice(Math.min(indentOf(next), content_column)));
        index++;
      } else {
        break;
      }
    }
    items.push(parseDocumentBlocks(body.join('\n'), is_streaming && index >= lines.length));
    let ahead = index;
    while (ahead < lines.length && lines[ahead].trim() === '') ahead++;
    if (ahead < lines.length && LIST_LINE.test(lines[ahead])) index = ahead;
  }
  return [{ kind: 'list', is_ordered, start: is_ordered ? parseInt(first[2], 10) : null, items }, index];
}

// A last line that is only the start of a block ("-", "2.", "##", ">"): while text is still arriving it is held back, so the
// bare mark never flashes before the words that belong to it.
const PARTIAL_BLOCK_START = /^\s*(?:[-*+_]{1,2}|\d{1,9}[.)]?|#{1,6}|>)\s*$/;

// Headings, paragraphs, bullet and numbered lists (nested, numbered from the number they start at), block quotes, fenced code,
// tables and rules, as CommonMark reads them. Setext headings, indented code and raw HTML are not recognised: they stay text.
// is_streaming: the text may still grow, so its end is read provisionally (see parseInline).
export function parseDocumentBlocks(text: string, is_streaming = false): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (is_streaming && PARTIAL_BLOCK_START.test(lines.at(-1)!)) lines.pop();
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const endParagraph = (is_last = false): void => {
    if (paragraph.length > 0) blocks.push({ kind: 'paragraph', children: parseInline(paragraph.join('\n'), { is_streaming: is_streaming && is_last }) });
    paragraph = [];
  };
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const fence = CODE_FENCE.exec(line);
    const heading = ATX_HEADING.exec(line);
    const item = LIST_LINE.exec(line);
    if (line.trim() === '') {
      endParagraph();
      index++;
    } else if (fence !== null) {
      endParagraph();
      const code: string[] = [];
      for (index++; index < lines.length && !lines[index].trim().startsWith(fence[1]); index++) code.push(lines[index]);
      index++;
      blocks.push({ kind: 'code_block', language: fence[2] || null, text: code.join('\n') });
    } else if (heading !== null) {
      endParagraph();
      blocks.push({ kind: 'heading', level: heading[1].length, children: parseInline(heading[2]) });
      index++;
    } else if (THEMATIC_BREAK.test(line)) {
      endParagraph();
      blocks.push({ kind: 'thematic_break' });
      index++;
    } else if (QUOTE_LINE.test(line)) {
      endParagraph();
      const quoted: string[] = [];
      for (; index < lines.length && QUOTE_LINE.test(lines[index]); index++) quoted.push(lines[index].replace(/^ {0,3}>[ \t]?/, ''));
      blocks.push({ kind: 'quote', blocks: parseDocumentBlocks(quoted.join('\n'), is_streaming && index >= lines.length) });
    } else if (item !== null && (paragraph.length === 0 || !isOrderedMarker(item[2]) || parseInt(item[2], 10) === 1)) {
      endParagraph();
      const [list, next] = listAt(lines, index, is_streaming);
      blocks.push(list);
      index = next;
    } else if (paragraph.length === 0 && line.includes('|') && index + 1 < lines.length && TABLE_DELIMITER_ROW.test(lines[index + 1]) && lines[index + 1].includes('-')) {
      const rows: string[] = [];
      for (; index < lines.length && lines[index].trim() !== '' && lines[index].includes('|'); index++) rows.push(lines[index]);
      const table = tableBlockOf(rows.join('\n'), { is_streaming: is_streaming && index >= lines.length });
      blocks.push(table ?? { kind: 'paragraph', children: parseInline(rows.join('\n')) });
    } else {
      paragraph.push(line.trim());
      index++;
    }
  }
  endParagraph(true);
  return blocks;
}

// ---------- Document index: the only cross-pair facts (reference links, footnote numbers, heading anchors) ----------

// GitHub's heading id algorithm (https://github.com/Flet/github-slugger): lowercase, drop punctuation except - and _,
// spaces to hyphens, then -1, -2 for repeats.
export function slugOf(text: string, used_slugs: Set<string>): string {
  const base = text.toLowerCase().trim().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');
  let slug = base;
  for (let repeat = 1; used_slugs.has(slug); repeat++) slug = `${base}-${repeat}`;
  used_slugs.add(slug);
  return slug;
}

// pairs: [{ pair_type, source_text, translation_text }]. Returns
//   link_definitions: Map(normalized label -> { destination, title })   for [text][label] in any cell
//   footnote_numbers: Map(label -> n)       n by order of first reference, as GitHub numbers them
//   footnote_first_pair: Map(label -> pair_index)   the source cell that carries the back-reference target id
//   heading_slugs: Map(pair_index -> slug)   GitHub slug of each source heading, deduplicated in order
//   anchor_ids: Set(element id)             every id the source column carries, so "#x" can be checked
export function documentIndexOf(pairs: readonly (IndexedPair | undefined)[]): DocumentIndex {
  const link_definitions = new Map<string, LinkDefinition>();
  const footnote_numbers = new Map<string, number>();
  const footnote_first_pair = new Map<string, number>();
  const heading_slugs = new Map<number, string>();
  const anchor_ids = new Set<string>();
  const used_slugs = new Set<string>();
  pairs.forEach((pair, pair_index) => {
    if (!pair || pair.pair_type === 'code') return;
    for (const text of [pair.source_text, pair.translation_text]) {
      const definition = definitionOf(text);
      if (definition?.kind === 'link_definition' && !link_definitions.has(normalizeLabel(definition.label))) {
        link_definitions.set(normalizeLabel(definition.label), { destination: definition.destination, title: definition.title });
      }
    }
    const source_definition = definitionOf(pair.source_text);
    if (source_definition?.kind === 'footnote_definition') anchor_ids.add(`${ANCHOR_ID_PREFIX}fn-${source_definition.label}`);
    for (const match of pair.source_text.matchAll(/\[\^([^\s\]]{1,99})\](?!:)/g)) {
      if (footnote_numbers.has(match[1])) continue;
      footnote_numbers.set(match[1], footnote_numbers.size + 1);
      footnote_first_pair.set(match[1], pair_index);
      anchor_ids.add(`${ANCHOR_ID_PREFIX}fnref-${match[1]}`);
    }
    if (pair.pair_type === 'heading') {
      const slug = slugOf(plainTextOf(parseInline(pair.source_text)), used_slugs);
      heading_slugs.set(pair_index, slug);
      anchor_ids.add(`${ANCHOR_ID_PREFIX}${slug}`);
    }
  });
  return { link_definitions, footnote_numbers, footnote_first_pair, heading_slugs, anchor_ids };
}

// ---------- Links: the one URL policy ----------

const CLICKABLE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
// Element ids the renderer writes are prefixed, so a heading called "alert" can never collide with the app's own ids.
export const ANCHOR_ID_PREFIX = 'md-';

// destination as written -> { href, is_external } or null (render the label as plain text, destination in a tooltip).
//   "#x"          -> "#md-x" when this document has that heading or footnote. anchor_ids null (a streaming cell) skips
//                    the check, since the heading may not have arrived yet.
//   http(s), mailto -> opened in a new tab.
//   anything else -> not clickable: javascript:, data:, file:, and relative paths, which would resolve against the
//                    local server and 404.
export function linkTargetOf(destination: string | null, anchor_ids: Set<string> | null): LinkTarget | null {
  if (destination === null) return null;
  const trimmed = destination.trim();
  if (trimmed.startsWith('#') && trimmed.length > 1) {
    let fragment = trimmed.slice(1);
    try { fragment = decodeURIComponent(fragment); } catch {}
    const id = `${ANCHOR_ID_PREFIX}${fragment.toLowerCase()}`;
    return anchor_ids === null || anchor_ids.has(id) ? { href: `#${id}`, is_external: false } : null;
  }
  let url: URL;
  try { url = new URL(trimmed); } catch { return null; }
  return CLICKABLE_PROTOCOLS.has(url.protocol) ? { href: url.href, is_external: true } : null;
}

// ---------- DOM: the only writer ----------

// context: { side: 'source' | 'translation', pair_index, document_index, is_streaming, is_document_complete }.
// Ids go on the source side only, so they stay unique; a translation-side link to "#x" scrolls to the same row.
// A streaming cell ends in a caret. "#x" links are checked only once the document is complete: until then the
// heading a table of contents points to may simply not have arrived.
export function renderCellContent(content_element: HTMLElement, blocks: Block[], context: RenderContext): void {
  const render_context: ElementContext = {
    ...context, anchor_ids: context.is_document_complete ? context.document_index.anchor_ids : null, used_ids: new Set(),
  };
  content_element.replaceChildren(...blocks.map((block) => blockElementOf(block, render_context)));
  if (context.is_streaming) caretContainerOf(content_element)?.append(element('span', 'md-caret'));
}

// Draws a whole document (see parseDocumentBlocks) into content_element: the same elements and classes as a translated cell.
// is_streaming: the text is still arriving, so its end is provisional and a caret follows it.
export function renderDocument(content_element: HTMLElement, text: string, is_streaming = false): void {
  renderCellContent(content_element, parseDocumentBlocks(text, is_streaming),
    { side: 'translation', pair_index: -1, document_index: documentIndexOf([]), is_streaming, is_document_complete: true });
}

// The innermost last element that holds text, so the caret sits after the last character, not on a line of its own.
// null when the cell holds blocks but none with text (a rule): a caret after them would add a line that vanishes later.
function caretContainerOf(content_element: Element): Element | null {
  let container = content_element;
  while (true) {
    const last = [...container.children].filter((child) => child.textContent.trim() !== '').at(-1);
    if (!last && container === content_element && content_element.children.length > 0) return null;
    if (!last || last.matches('a, span, strong, em, del, code, sup, sub, kbd, mark, s, ins, u, small')) return container;
    if (last.matches('.md-code-block')) return last.querySelector('code');
    container = last;
  }
}

// anchor_ids: null while "#x" links cannot be checked yet. used_ids: footnote ids this cell already carries.
interface ElementContext extends RenderContext {
  anchor_ids: Set<string> | null;
  used_ids: Set<string>;
}

const HEADING_TAGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const;

function element<Tag extends keyof HTMLElementTagNameMap>(
  tag_name: Tag, class_name: string | null, children: (Node | string)[] = [],
): HTMLElementTagNameMap[Tag] {
  const node = document.createElement(tag_name);
  if (class_name) node.className = class_name;
  node.append(...children);
  return node;
}

function blockElementOf(block: Block, context: ElementContext): HTMLElement {
  if (block.kind === 'paragraph') return element('p', 'md-p', inlineNodesOf(block.children, context));
  if (block.kind === 'heading') {
    const heading = element(HEADING_TAGS[block.level - 1], `md-heading md-h${block.level}`, inlineNodesOf(block.children, context));
    const slug = context.document_index.heading_slugs.get(context.pair_index);
    if (context.side === 'source' && slug !== undefined) heading.id = `${ANCHOR_ID_PREFIX}${slug}`;
    return heading;
  }
  if (block.kind === 'thematic_break') return element('hr', 'md-hr');
  if (block.kind === 'code_block') {
    const code_block = element('div', 'md-code-block');
    if (block.language) code_block.append(element('div', 'md-code-language', [block.language]));
    code_block.append(element('pre', null, [element('code', null, [block.text])]));
    return code_block;
  }
  if (block.kind === 'quote') return element('blockquote', 'md-quote', block.blocks.map((inner) => blockElementOf(inner, context)));
  if (block.kind === 'list') {
    const items = block.items.map((item_blocks) => element('li', null, item_blocks.map((inner) => blockElementOf(inner, context))));
    if (!block.is_ordered) return element('ul', 'md-list', items);
    const list = element('ol', 'md-list', items);
    if (block.start !== null && block.start !== 1) list.start = block.start;
    return list;
  }
  if (block.kind === 'list_item') {
    const marker = element('span', `md-marker is-${block.marker.kind}`, block.marker.kind === 'task' ? [] : [block.marker.text]);
    marker.setAttribute('aria-hidden', 'true');
    if (block.marker.kind === 'task') marker.classList.toggle('is-checked', block.marker.is_checked);
    const item = element('div', 'md-list-item', [marker, element('div', 'md-list-body', block.blocks.map((inner) => blockElementOf(inner, context)))]);
    return item;
  }
  if (block.kind === 'table') {
    const alignOf = (cell_element: HTMLTableCellElement, column: number): HTMLTableCellElement => { if (block.alignments[column]) cell_element.style.textAlign = block.alignments[column]; return cell_element; };
    const head = element('thead', null, [element('tr', null, block.header_cells.map((cell, column) => alignOf(element('th', null, inlineNodesOf(cell, context)), column)))]);
    const body = element('tbody', null, block.body_rows.map((row) => element('tr', null, row.map((cell, column) => alignOf(element('td', null, inlineNodesOf(cell, context)), column)))));
    return element('div', 'md-table-scroll', [element('table', 'md-table', [head, body])]);
  }
  if (block.kind === 'footnote_definition') {
    const number = context.document_index.footnote_numbers.get(block.label) ?? block.label;
    const label = element('a', 'md-footnote-label', [String(number)]);
    label.href = `#${ANCHOR_ID_PREFIX}fnref-${block.label}`;
    label.title = 'Back to the reference';
    const footnote = element('div', 'md-footnote', [label, element('div', 'md-footnote-body', inlineNodesOf(block.children, context))]);
    if (context.side === 'source') footnote.id = `${ANCHOR_ID_PREFIX}fn-${block.label}`;
    return footnote;
  }
  if (block.kind === 'link_definition') {
    const target = linkTargetOf(block.destination, context.anchor_ids);
    const destination = target ? linkElementOf(target, block.title, [block.destination]) : document.createTextNode(block.destination);
    return element('div', 'md-link-definition', [element('span', 'md-link-definition-label', [block.label]), destination]);
  }
  throw new Error(`unknown block kind ${(block as { kind: string }).kind}`);
}

function linkElementOf(target: LinkTarget, title: string | null, children: (Node | string)[]): HTMLAnchorElement {
  const link = element('a', 'md-link', children);
  link.href = target.href;
  if (title) link.title = title;
  if (target.is_external) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
  return link;
}

function inlineNodesOf(nodes: InlineNode[], context: ElementContext): Node[] {
  return nodes.map((node): Node => {
    if (node.kind === 'text') return document.createTextNode(node.text);
    if (node.kind === 'line_break') return document.createElement('br');
    if (node.kind === 'code') return element('code', 'md-code', [node.text]);
    if (node.kind === 'strong' || node.kind === 'em' || node.kind === 'del') return element(node.kind, null, inlineNodesOf(node.children, context));
    if (node.kind === 'footnote_ref') {
      const number = context.document_index.footnote_numbers.get(node.label) ?? node.label;
      const link = element('a', null, [String(number)]);
      link.href = `#${ANCHOR_ID_PREFIX}fn-${node.label}`;
      const is_first_reference = context.document_index.footnote_first_pair.get(node.label) === context.pair_index && !context.used_ids.has(node.label);
      if (context.side === 'source' && is_first_reference) link.id = `${ANCHOR_ID_PREFIX}fnref-${node.label}`;
      context.used_ids.add(node.label);
      return element('sup', 'md-footnote-ref', [link]);
    }
    if (node.kind === 'image') {
      // Remote images are never fetched: the URL is model output, and loading it would also reflow the row later.
      const target = linkTargetOf(node.destination, context.anchor_ids);
      const chip = [element('span', 'md-image-icon'), node.alt || 'image'];
      return target ? Object.assign(linkElementOf(target, node.title, chip), { className: 'md-link md-image' }) : element('span', 'md-image', chip);
    }
    if (node.kind === 'link' || node.kind === 'autolink') {
      const children = node.kind === 'autolink' ? [node.text] : inlineNodesOf(node.children, context);
      if (node.destination === null) return element('span', 'md-link is-pending', children);
      const target = linkTargetOf(node.destination, context.anchor_ids);
      if (!target) {
        const inert = element('span', 'md-link-inert', children);
        inert.title = node.destination;
        return inert;
      }
      return linkElementOf(target, node.kind === 'link' ? node.title : null, children);
    }
    throw new Error(`unknown inline kind ${(node as { kind: string }).kind}`);
  });
}
