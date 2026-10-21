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
