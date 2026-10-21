// The inline parser: one cell's text -> inline nodes (CommonMark 0.31.2 inlines, plus GFM strikethrough,
// autolink literals and footnote references). Pure, so node tests it.

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

// Characters that may start a construct; any other character is plain text.
const CONSTRUCT_START = /[\\\n`*_~&<[\]!]/;
// Where a run of plain text ends: at a construct start, or at a word start (which may begin an autolink literal).
const PLAIN_TEXT_END = /[\\\n`*_~&<[\]!]|(?<=[\s*_~(])[a-zA-Z0-9]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: CommonMark ends a bare URL at a control character.
const BARE_DESTINATION_END = /[\u0000- \u007f]/;
// "[label][ref]" or "[label][]" right after the first "]".
const FULL_REFERENCE = /^\[((?:[^\\[\]]|\\.){0,999})\]/;

function isWhitespace(char: string | undefined): boolean {
  return char === undefined || UNICODE_WHITESPACE.test(char);
}

function isPunctuation(char: string | undefined): boolean {
  if (char === undefined) return false;
  return ASCII_PUNCTUATION.test(char) || UNICODE_PUNCTUATION.test(char);
}

export function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase();
}

function decodeEntity(match: RegExpExecArray): string | null {
  const [, hex_digits, decimal_digits, name] = match;
  if (name) return decodeNamedEntity(name);
  const code_point = hex_digits ? parseInt(hex_digits, 16) : parseInt(decimal_digits, 10);
  const is_surrogate = code_point >= 0xd800 && code_point <= 0xdfff;
  if (code_point === 0 || code_point > 0x10ffff || is_surrogate) return '�';
  return String.fromCodePoint(code_point);
}

const named_entity_cache = new Map<string, string | null>();
// The browser knows all 2,231 HTML named references; a textarea parses its content as RCDATA, so no markup runs.
function decodeNamedEntity(name: string): string | null {
  if (named_entity_cache.has(name)) return named_entity_cache.get(name) ?? null;
  const textarea = document.createElement('textarea');
  textarea.innerHTML = `&${name};`;
  const decoded = textarea.value === `&${name};` ? null : textarea.value;
  named_entity_cache.set(name, decoded);
  return decoded;
}

export function unescapeString(text: string): string {
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
  const skipSpaces = (): void => {
    while (position < text.length && /[ \t\n]/.test(text[position])) position++;
  };

  skipSpaces();
  if (position >= text.length) return { status: 'incomplete' };
  let destination = '';
  if (text[position] === '<') {
    // "<destination>": anything up to an unescaped ">", on one line.
    const close = text.slice(position + 1).search(/(?<!\\)[<>\n]/);
    if (close === -1) {
      const has_line_end = /\n/.test(text.slice(position));
      return { status: has_line_end ? 'fail' : 'incomplete' };
    }
    if (text[position + 1 + close] !== '>') return { status: 'fail' };
    destination = text.slice(position + 1, position + 1 + close);
    position += close + 2;
  } else {
    // A bare destination: up to a space or a control character, with its parentheses balanced.
    const destination_start = position;
    let depth = 0;
    while (position < text.length) {
      const char = text[position];
      const is_escape = char === '\\' && position + 1 < text.length && ASCII_PUNCTUATION.test(text[position + 1]);
      if (is_escape) {
        position += 2;
        continue;
      }
      if (char === '(') {
        depth++;
      } else if (char === ')') {
        if (depth === 0) break;
        depth--;
      } else if (BARE_DESTINATION_END.test(char)) {
        break;
      }
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
  const has_space_before_title = position > before_title;
  if (has_space_before_title && (title_opener === '"' || title_opener === "'" || title_opener === '(')) {
    const title_closer = title_opener === '(' ? ')' : title_opener;
    let scan = position + 1;
    while (scan < text.length && text[scan] !== title_closer) {
      // A backslash skips the character after it, so an escaped closer does not end the title.
      if (text[scan] === '\\') scan += 2;
      else scan += 1;
    }
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
    const open_count = (trimmed.match(/\(/g) ?? []).length;
    const close_count = (trimmed.match(/\)/g) ?? []).length;
    if (trimmed.endsWith(')') && open_count < close_count) trimmed = trimmed.slice(0, -1);
    trimmed = trimmed.replace(/&[A-Za-z0-9]+;$/, '');
    if (trimmed === before) return trimmed;
  }
}

// ---------- The working list: a doubly linked tree, as in the reference implementation ----------

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

function appendChild(parent: ListNode, node: ListNode): void {
  node.parent = parent;
  node.prev = parent.last;
  node.next = null;
  if (parent.last) parent.last.next = node;
  else parent.first = node;
  parent.last = node;
}

function unlink(node: ListNode): void {
  const parent = node.parent as ListNode;
  if (node.prev) node.prev.next = node.next;
  else parent.first = node.next;
  if (node.next) node.next.prev = node.prev;
  else parent.last = node.prev;
  node.prev = null;
  node.next = null;
}

// Moves the siblings strictly between from_node and to_node (to the end when to_node is null) into container,
// and puts container right after from_node.
function wrapBetween(from_node: ListNode, to_node: ListNode | null, new_container: NewListNode): ListNode {
  const parent = from_node.parent as ListNode;
  const container = new_container as ListNode;
  container.first = null;
  container.last = null;
  let node = from_node.next;
  while (node && node !== to_node) {
    const next = node.next;
    unlink(node);
    appendChild(container, node);
    node = next;
  }
  container.parent = parent;
  container.prev = from_node;
  container.next = from_node.next;
  if (from_node.next) from_node.next.prev = container;
  else parent.last = container;
  from_node.next = container;
  return container;
}

// ---------- Emphasis: the delimiter stack ----------

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

type EmphasisKind = 'del' | 'em' | 'strong';

// CommonMark's "rule of 3": when one side can both open and close, the two runs do not pair if their lengths add up to
// a multiple of 3, unless both lengths are multiples of 3. Strikethrough has no such rule.
function isRuleOfThreeMismatch(opener: Delimiter, closer: Delimiter): boolean {
  if (closer.char === '~') return false;
  const can_either_go_both_ways = closer.can_open || opener.can_close;
  const total_length = opener.original_length + closer.original_length;
  return can_either_go_both_ways && closer.original_length % 3 !== 0 && total_length % 3 === 0;
}

// The nearest opener below closer that it pairs with, or null. The search stops at stack_bottom and at
// openers_bottom (where an earlier search for the same kind of closer already failed).
function findOpener(closer: Delimiter, stack_bottom: Delimiter | null, openers_bottom: Delimiter | null | undefined): Delimiter | null {
  let opener = closer.previous;
  while (opener && opener !== stack_bottom && opener !== openers_bottom) {
    if (opener.char === closer.char && opener.can_open && !isRuleOfThreeMismatch(opener, closer)) return opener;
    opener = opener.previous;
  }
  return null;
}

// How many delimiter characters a matched pair uses: "~~" always 2; "**" 2 when both runs have 2 left, else 1.
function delimitersUsed(opener: Delimiter, closer: Delimiter): number {
  if (closer.char === '~') return 2;
  if (closer.length >= 2 && opener.length >= 2) return 2;
  return 1;
}

function emphasisKindOf(char: string, used: number): EmphasisKind {
  if (char === '~') return 'del';
  if (used === 2) return 'strong';
  return 'em';
}

// While streaming, an opener with no closer yet is shown as if it closed at the end of the text.
function streamingKindsOf(delimiter: Delimiter): EmphasisKind[] {
  if (delimiter.char === '~') return ['del'];
  if (delimiter.length >= 3) return ['em', 'strong'];
  if (delimiter.length === 2) return ['strong'];
  return ['em'];
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

// Where a "]" leads: the destination and title, and the position after the whole link.
interface BracketTarget {
  destination: string | null;
  title: string | null;
  end: number;
}

// ---------- The parser ----------

// Inline nodes for one cell's text.
// is_streaming changes only what happens at the END of the text, to a construct whose closing part has not arrived:
// a code span, emphasis run, link destination or "<https://" autolink renders as if it closed there (link
// destination null), and anything still undecided ("[label", "[^1", "&am", a trailing "\", "<", "!", "~" or a bare
// delimiter run) is not shown yet. Without is_streaming the same text parses strictly by the spec.
export function parseInline(text: string, { is_streaming = false, link_definitions = new Map() }: InlineOptions = {}): InlineNode[] {
  const root: ListNode = { kind: 'root', parent: null, prev: null, next: null, first: null, last: null };
  let delimiter_top: Delimiter | null = null;
  let bracket_top: BracketOpener | null = null;
  let position = 0;
  // Plain text read but not yet added to the list as a text node.
  let text_buffer = '';

  const append = <Node extends NewListNode>(new_node: Node): ListNode & Node => {
    const node = new_node as ListNode & Node;
    appendChild(root, node);
    return node;
  };

  const flushText = (): void => {
    if (text_buffer === '') return;
    append({ kind: 'text', text: text_buffer });
    text_buffer = '';
  };

  const appendAutolink = (destination: string | null, link_text: string): void => {
    flushText();
    append({ kind: 'autolink', destination, text: link_text });
  };

  const isWordStart = (): boolean => position === 0 || /[\s*_~(]/.test(text[position - 1]);

  const skipLineIndent = (): void => {
    while (text[position] === ' ') position++;
  };

  const removeDelimiter = (delimiter: Delimiter): void => {
    if (delimiter.previous) delimiter.previous.next = delimiter.next;
    if (delimiter.next) delimiter.next.previous = delimiter.previous;
    else delimiter_top = delimiter.previous;
  };

  const clearDelimiters = (stack_bottom: Delimiter | null): void => {
    while (delimiter_top && delimiter_top !== stack_bottom) removeDelimiter(delimiter_top);
  };

  // https://spec.commonmark.org/0.31.2/#process-emphasis, plus GFM strikethrough ("~~" pairs). Leaves unmatched
  // openers on the stack; the caller clears them.
  const processEmphasis = (stack_bottom: Delimiter | null): void => {
    // Per kind of closer: below this delimiter, no opener for it was found.
    const openers_bottom = new Map<string, Delimiter | null>();
    let closer = delimiter_top;
    while (closer && closer.previous !== stack_bottom) closer = closer.previous;
    while (closer) {
      if (!closer.can_close) {
        closer = closer.next;
        continue;
      }
      const bottom_key = `${closer.char}${closer.can_open}${closer.original_length % 3}`;
      const opener = findOpener(closer, stack_bottom, openers_bottom.get(bottom_key));
      if (opener === null) {
        openers_bottom.set(bottom_key, closer.previous);
        const next = closer.next;
        if (!closer.can_open) removeDelimiter(closer);
        closer = next;
        continue;
      }

      const used = delimitersUsed(opener, closer);
      opener.length -= used;
      closer.length -= used;
      opener.node.text = opener.node.text.slice(0, opener.length);
      closer.node.text = closer.node.text.slice(0, closer.length);
      wrapBetween(opener.node, closer.node, { kind: emphasisKindOf(closer.char, used) });
      // The delimiters inside the new emphasis can no longer pair with anything outside it.
      let between = closer.previous;
      while (between && between !== opener) {
        const previous = between.previous;
        removeDelimiter(between);
        between = previous;
      }
      if (opener.length === 0) {
        unlink(opener.node);
        removeDelimiter(opener);
      }
      if (closer.length === 0) {
        const next = closer.next;
        unlink(closer.node);
        removeDelimiter(closer);
        closer = next;
      }
    }
  };

  // Streaming only, after processEmphasis(null): each opener still unmatched wraps everything after it, as if its
  // closer were the next character ("**bol" -> strong "bol").
  const closeOpenersAtEnd = (): void => {
    for (let delimiter = delimiter_top; delimiter; delimiter = delimiter.previous) {
      if (!delimiter.can_open || delimiter.is_at_text_end) continue;
      for (const kind of streamingKindsOf(delimiter)) wrapBetween(delimiter.node, null, { kind });
      delimiter.node.text = '';
    }
  };

  // Every read* function below reads one construct at position, moves position past it and returns true. One that
  // can also find nothing there returns false and leaves position where it was.

  // Plain text runs to the next character that can start a construct, or to the next word start (autolinks).
  const readPlainText = (): void => {
    PLAIN_TEXT_END.lastIndex = position + 1;
    const run_end = PLAIN_TEXT_END.exec(text)?.index ?? text.length;
    text_buffer += text.slice(position, run_end);
    position = run_end;
  };

  const readBackslash = (): true => {
    const next = text[position + 1];
    if (next === '\n') {
      // A hard line break.
      flushText();
      append({ kind: 'line_break' });
      position += 2;
      skipLineIndent();
      return true;
    }
    if (next !== undefined && ASCII_PUNCTUATION.test(next)) {
      // An escaped character is plain text.
      text_buffer += next;
      position += 2;
      return true;
    }
    text_buffer += '\\';
    position++;
    return true;
  };

  // Soft and hard breaks both render as a line break: the translator keeps only the breaks the author meant.
  const readNewline = (): true => {
    text_buffer = text_buffer.replace(/ +$/, '');
    flushText();
    append({ kind: 'line_break' });
    position++;
    skipLineIndent();
    return true;
  };

  const readCodeSpan = (): true => {
    let run_end = position;
    while (text[run_end] === '`') run_end++;
    const run_length = run_end - position;
    // The closer is a backtick run of exactly the same length.
    const closer = new RegExp(`(?<!\`)\`{${run_length}}(?!\`)`, 'g');
    closer.lastIndex = run_end;
    const close_match = closer.exec(text);
    if (close_match) {
      let code = text.slice(run_end, close_match.index).replace(/\n/g, ' ');
      // One space is stripped from each end, unless the code is only spaces.
      if (/^ .*[^ ].* $|^ [^ ] $/s.test(code)) code = code.slice(1, -1);
      flushText();
      append({ kind: 'code', text: code });
      position = close_match.index + run_length;
      return true;
    }
    if (is_streaming) {
      // Backticks at the very end may be the closer still arriving, so they are not shown as code.
      const code = text.slice(run_end).replace(/`+$/, '').replace(/\n/g, ' ');
      flushText();
      if (code !== '') append({ kind: 'code', text: code });
      position = text.length;
      return true;
    }
    text_buffer += text.slice(position, run_end);
    position = run_end;
    return true;
  };

  // A run of "*", "_" or "~": text for now, and an entry on the delimiter stack that may become emphasis later.
  const readDelimiterRun = (char: string): true => {
    let run_end = position;
    while (text[run_end] === char) run_end++;
    const run = text.slice(position, run_end);
    const is_at_text_end = run_end === text.length;
    // Only "~~" strikes through. GFM also accepts a single "~", but in prose that means "about" (~5 ms), and two in
    // one paragraph would strike out everything between them. A single "~" at the very end may still become "~~".
    if (char === '~' && run.length === 1 && is_at_text_end && is_streaming) {
      position = run_end;
      return true;
    }
    if (char === '~' && run.length !== 2) {
      text_buffer += run;
      position = run_end;
      return true;
    }

    const char_before = position === 0 ? undefined : text[position - 1];
    const char_after = text[run_end];
    const is_left_flanking = !isWhitespace(char_after)
      && (!isPunctuation(char_after) || isWhitespace(char_before) || isPunctuation(char_before));
    const is_right_flanking = !isWhitespace(char_before)
      && (!isPunctuation(char_before) || isWhitespace(char_after) || isPunctuation(char_after));
    let can_open = is_left_flanking;
    let can_close = is_right_flanking;
    // "_" is stricter, so the underscores inside snake_case words stay text.
    if (char === '_') {
      can_open = is_left_flanking && (!is_right_flanking || isPunctuation(char_before));
      can_close = is_right_flanking && (!is_left_flanking || isPunctuation(char_after));
    }

    flushText();
    const node = append({ kind: 'text', text: run });
    const delimiter: Delimiter = {
      char,
      length: run.length,
      original_length: run.length,
      can_open,
      can_close,
      is_at_text_end,
      node,
      previous: delimiter_top,
      next: null,
    };
    if (delimiter_top) delimiter_top.next = delimiter;
    delimiter_top = delimiter;
    position = run_end;
    return true;
  };

  const readEntity = (rest: string): true => {
    const entity_match = ENTITY_SOURCE.exec(rest);
    const decoded = entity_match && decodeEntity(entity_match);
    if (entity_match && decoded !== null) {
      text_buffer += decoded;
      position += entity_match[0].length;
      return true;
    }
    // "&am" at the very end may still become "&amp;".
    if (is_streaming && ENTITY_PREFIX_AT_END.test(rest)) {
      position = text.length;
      return true;
    }
    text_buffer += '&';
    position++;
    return true;
  };

  // "<": an autolink, raw HTML (kept as text), or a plain "<".
  const readAngleBracket = (rest: string): true => {
    const uri_match = URI_AUTOLINK.exec(rest);
    const autolink_match = uri_match ?? EMAIL_AUTOLINK.exec(rest);
    if (autolink_match) {
      const address = autolink_match[1];
      const destination = uri_match ? address : `mailto:${address}`;
      appendAutolink(destination, address);
      position += autolink_match[0].length;
      return true;
    }
    const raw_html_match = HTML_TAG.exec(rest) ?? OTHER_RAW_HTML.exec(rest);
    if (raw_html_match) {
      text_buffer += raw_html_match[0];
      position += raw_html_match[0].length;
      return true;
    }
    if (is_streaming && /^<https?:\/\/[^\s<>]+$/i.test(rest)) {
      // "<https://..." whose ">" has not arrived yet is shown as a link already.
      appendAutolink(null, rest.slice(1));
      position = text.length;
      return true;
    }
    if (is_streaming && AUTOLINK_PREFIX_AT_END.test(rest)) {
      position = text.length;
      return true;
    }
    text_buffer += '<';
    position++;
    return true;
  };

  const readFootnoteRef = (rest: string): boolean => {
    const footnote_match = FOOTNOTE_REF.exec(rest);
    // "[^1]:" starts a footnote definition, not a reference.
    if (footnote_match && text[position + footnote_match[0].length] !== ':') {
      flushText();
      append({ kind: 'footnote_ref', label: footnote_match[1] });
      position += footnote_match[0].length;
      return true;
    }
    if (is_streaming && FOOTNOTE_REF_PREFIX_AT_END.test(rest)) {
      position = text.length;
      return true;
    }
    return false;
  };

  const openBracket = (is_image: boolean): true => {
    flushText();
    const node = append({ kind: 'text', text: is_image ? '![' : '[' });
    const marker_length = is_image ? 2 : 1;
    bracket_top = {
      node,
      is_image,
      is_active: true,
      previous_delimiter: delimiter_top,
      label_start: position + marker_length,
      previous: bracket_top,
    };
    position += marker_length;
    return true;
  };

  // The bracket is done: the emphasis inside it is settled, and its "[" leaves the list.
  const closeOpener = (opener: BracketOpener): void => {
    processEmphasis(opener.previous_delimiter);
    clearDelimiters(opener.previous_delimiter);
    unlink(opener.node);
    bracket_top = opener.previous;
  };

  // A reference link ("[label][ref]", "[label][]" or "[label]") whose label is in the link definitions; null otherwise.
  const referenceTargetOf = (opener: BracketOpener): BracketTarget | null => {
    const label_text = text.slice(opener.label_start, position);
    const full_reference = FULL_REFERENCE.exec(text.slice(position + 1));
    let reference_label = label_text;
    if (full_reference && full_reference[1].trim() !== '') reference_label = full_reference[1];
    if (reference_label.trim() === '') return null;
    const definition = link_definitions.get(normalizeLabel(reference_label));
    if (!definition) return null;
    const end = full_reference ? position + 1 + full_reference[0].length : position + 1;
    return { destination: definition.destination, title: definition.title, end };
  };

  // "]" closes the nearest "[" or "![" as a link or an image when a destination or a known label follows; otherwise
  // it is text.
  const closeBracket = (): true => {
    flushText();
    const opener: BracketOpener | null = bracket_top;
    if (!opener) {
      text_buffer += ']';
      position++;
      return true;
    }
    if (!opener.is_active) {
      // An opener inside a link: links cannot nest.
      bracket_top = opener.previous;
      text_buffer += ']';
      position++;
      return true;
    }

    const next_char = text[position + 1];
    let target: BracketTarget | null = null;
    let is_destination_arriving = false;
    if (next_char === '(') {
      const tail = parseLinkTail(text, position + 1);
      if (tail.status === 'ok') target = { destination: tail.destination, title: tail.title, end: tail.end };
      is_destination_arriving = tail.status === 'incomplete' && is_streaming;
    }
    // "[label]" at the very end, or "[label][ref" still arriving: whether it becomes a link is not decided yet.
    const is_reference_arriving = next_char === '[' && !text.slice(position + 2).includes(']');
    const is_label_undecided = is_streaming && !target && (next_char === undefined || is_reference_arriving);
    if (is_label_undecided) {
      closeOpener(opener);
      position = text.length;
      return true;
    }
    if (is_destination_arriving) target = { destination: null, title: null, end: text.length };
    if (!target) target = referenceTargetOf(opener);
    if (!target) {
      bracket_top = opener.previous;
      text_buffer += ']';
      position++;
      return true;
    }

    const kind = opener.is_image ? 'image' : 'link';
    wrapBetween(opener.node, null, { kind, destination: target.destination, title: target.title });
    closeOpener(opener);
    if (!opener.is_image) {
      // Links cannot nest: no "[" before this link may make one now.
      for (let earlier = bracket_top; earlier; earlier = earlier.previous) {
        if (!earlier.is_image) earlier.is_active = false;
      }
    }
    position = target.end;
    return true;
  };

  // GFM autolink literal: "www.x.com" or "https://x.com", where a word starts.
  const readUrlLiteral = (rest: string): boolean => {
    const url_match = EXTENDED_URL_AUTOLINK.exec(rest);
    if (!url_match) return false;
    const url = trimAutolinkTail(url_match[0]);
    const domain = url.replace(/^(?:(?:https?|ftp):\/\/)/i, '').split(/[/?#]/)[0];
    const has_scheme = /^(?:https?|ftp):\/\//i.test(url);
    if (domain === '' || !(/\./.test(domain) || has_scheme)) return false;
    const destination = /^www\./i.test(url) ? `http://${url}` : url;
    appendAutolink(destination, url);
    position += url.length;
    return true;
  };

  // GFM email literal: "name@example.com", where a word starts.
  const readEmailLiteral = (rest: string): boolean => {
    const email_match = EXTENDED_EMAIL_AUTOLINK.exec(rest);
    if (!email_match) return false;
    // GFM: a trailing "." is not part of the address, and one ending in "-" or "_" is no address at all.
    const email = email_match[0].replace(/\.+$/, '');
    if (/[-_]$/.test(email) || !/@[^@]+\.[^.@]+$/.test(email)) return false;
    appendAutolink(`mailto:${email}`, email);
    position += email.length;
    return true;
  };

  // false: no construct starts at position, so its character is plain text.
  const readConstruct = (char: string, rest: string): boolean => {
    if (char === '\\') return readBackslash();
    if (char === '\n') return readNewline();
    if (char === '`') return readCodeSpan();
    if (char === '*' || char === '_' || char === '~') return readDelimiterRun(char);
    if (char === '&') return readEntity(rest);
    if (char === '<') return readAngleBracket(rest);
    if (char === '[' && text[position + 1] === '^' && readFootnoteRef(rest)) return true;
    if (char === '[') return openBracket(false);
    if (char === '!' && text[position + 1] === '[') return openBracket(true);
    if (char === ']') return closeBracket();
    if (isWordStart() && /[hHwWfF]/.test(char) && readUrlLiteral(rest)) return true;
    if (isWordStart() && /[a-zA-Z0-9._+-]/.test(char)) return readEmailLiteral(rest);
    return false;
  };

  while (position < text.length) {
    const char = text[position];
    const can_start_construct = CONSTRUCT_START.test(char) || (isWordStart() && /[a-zA-Z0-9]/.test(char));
    if (!can_start_construct) {
      readPlainText();
      continue;
    }
    const rest = text.slice(position);
    // A last "<", "!" or "\" may start something still arriving, so it is not shown yet.
    if (is_streaming && (rest === '<' || rest === '!' || rest === '\\')) {
      position++;
      continue;
    }
    if (!readConstruct(char, rest)) {
      text_buffer += char;
      position++;
    }
  }
  flushText();

  // The casts undo a narrowing to null: tsc does not see the closures above that push brackets and delimiters.
  const last_bracket = bracket_top as BracketOpener | null;
  const last_delimiter = delimiter_top as Delimiter | null;
  if (is_streaming) {
    // Brackets still open at the end of a streaming cell: their "[" is not shown, so the label reads as plain text.
    for (let opener = last_bracket; opener; opener = opener.previous) opener.node.text = '';
  }
  // Taken before processEmphasis, which drops a run that can only close: at the very end it may still be a closer arriving.
  const run_at_text_end = last_delimiter?.is_at_text_end ? last_delimiter : null;
  processEmphasis(null);
  if (is_streaming) {
    closeOpenersAtEnd();
    if (run_at_text_end) run_at_text_end.node.text = '';
  }
  clearDelimiters(null);
  return toPlainNodes(root, false);
}

// ---------- From the working list to plain nodes ----------

// Linked list -> plain nested arrays, merging adjacent text. A link inside a link (only an autolink can get there)
// keeps its text and loses its link.
function toPlainNodes(container: ListNode, is_inside_link: boolean): InlineNode[] {
  const nodes: InlineNode[] = [];
  for (let node = container.first; node; node = node.next) {
    nodes.push(...plainNodesOf(node, is_inside_link));
  }
  return mergeAdjacentText(nodes);
}

function plainNodesOf(node: ListNode, is_inside_link: boolean): InlineNode[] {
  const text = node.text ?? '';
  const destination = node.destination ?? null;
  const title = node.title ?? null;
  switch (node.kind) {
    case 'text':
      if (text === '') return [];
      return [{ kind: 'text', text }];
    case 'autolink':
      if (is_inside_link) return [{ kind: 'text', text }];
      return [{ kind: 'autolink', destination, text }];
    case 'link': {
      const children = toPlainNodes(node, true);
      if (is_inside_link) return children;
      return [{ kind: 'link', destination, title, children }];
    }
    case 'image': {
      const alt = plainTextOf(toPlainNodes(node, true));
      return [{ kind: 'image', destination, title, alt }];
    }
    case 'strong':
    case 'em':
    case 'del':
      return [{ kind: node.kind, children: toPlainNodes(node, is_inside_link) }];
    case 'code':
      return [{ kind: 'code', text }];
    case 'footnote_ref':
      return [{ kind: 'footnote_ref', label: node.label ?? '' }];
    default:
      return [{ kind: 'line_break' }];
  }
}

function mergeAdjacentText(nodes: InlineNode[]): InlineNode[] {
  const merged: InlineNode[] = [];
  for (const node of nodes) {
    const last = merged.at(-1);
    if (node.kind === 'text' && last?.kind === 'text') last.text += node.text;
    else merged.push(node);
  }
  return merged;
}

export function plainTextOf(nodes: InlineNode[]): string {
  return nodes.map(plainTextOfNode).join('');
}

function plainTextOfNode(node: InlineNode): string {
  switch (node.kind) {
    case 'text':
    case 'code':
    case 'autolink':
      return node.text;
    case 'line_break':
      return ' ';
    case 'image':
      return node.alt;
    case 'footnote_ref':
      return '';
    default:
      return plainTextOf(node.children);
  }
}
