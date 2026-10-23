// The inline parser: one cell's text -> inline nodes (CommonMark 0.31.2 inlines, plus GFM strikethrough,
// autolink literals and footnote references). Pure, so node tests it.

export interface LinkDefinition {
  destination: string;
  title: string | null;
}

// isStreaming: the text may still grow (see parseInline). linkDefinitions: normalized label -> definition.
export interface InlineOptions {
  isStreaming?: boolean;
  linkDefinitions?: Map<string, LinkDefinition>;
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
  const [, hexDigits, decimalDigits, name] = match;
  if (name) return decodeNamedEntity(name);
  const codePoint = hexDigits ? parseInt(hexDigits, 16) : parseInt(decimalDigits, 10);
  const isSurrogate = codePoint >= 0xd800 && codePoint <= 0xdfff;
  if (codePoint === 0 || codePoint > 0x10ffff || isSurrogate) return '�';
  return String.fromCodePoint(codePoint);
}

const namedEntityCache = new Map<string, string | null>();
// The browser knows all 2,231 HTML named references; a textarea parses its content as RCDATA, so no markup runs.
function decodeNamedEntity(name: string): string | null {
  if (namedEntityCache.has(name)) return namedEntityCache.get(name) ?? null;
  const textarea = document.createElement('textarea');
  textarea.innerHTML = `&${name};`;
  const decoded = textarea.value === `&${name};` ? null : textarea.value;
  namedEntityCache.set(name, decoded);
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
      const hasLineEnd = /\n/.test(text.slice(position));
      return { status: hasLineEnd ? 'fail' : 'incomplete' };
    }
    if (text[position + 1 + close] !== '>') return { status: 'fail' };
    destination = text.slice(position + 1, position + 1 + close);
    position += close + 2;
  } else {
    // A bare destination: up to a space or a control character, with its parentheses balanced.
    const destinationStart = position;
    let depth = 0;
    while (position < text.length) {
      const char = text[position];
      const isEscape = char === '\\' && position + 1 < text.length && ASCII_PUNCTUATION.test(text[position + 1]);
      if (isEscape) {
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
    destination = text.slice(destinationStart, position);
  }

  const beforeTitle = position;
  skipSpaces();
  if (position >= text.length) return { status: 'incomplete' };
  let title: string | null = null;
  const titleOpener = text[position];
  const hasSpaceBeforeTitle = position > beforeTitle;
  if (hasSpaceBeforeTitle && (titleOpener === '"' || titleOpener === "'" || titleOpener === '(')) {
    const titleCloser = titleOpener === '(' ? ')' : titleOpener;
    let scan = position + 1;
    while (scan < text.length && text[scan] !== titleCloser) {
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
    const openCount = (trimmed.match(/\(/g) ?? []).length;
    const closeCount = (trimmed.match(/\)/g) ?? []).length;
    if (trimmed.endsWith(')') && openCount < closeCount) trimmed = trimmed.slice(0, -1);
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

// Moves the siblings strictly between fromNode and toNode (to the end when toNode is null) into container,
// and puts container right after fromNode.
function wrapBetween(fromNode: ListNode, toNode: ListNode | null, newContainer: NewListNode): ListNode {
  const parent = fromNode.parent as ListNode;
  const container = newContainer as ListNode;
  container.first = null;
  container.last = null;
  let node = fromNode.next;
  while (node && node !== toNode) {
    const next = node.next;
    unlink(node);
    appendChild(container, node);
    node = next;
  }
  container.parent = parent;
  container.prev = fromNode;
  container.next = fromNode.next;
  if (fromNode.next) fromNode.next.prev = container;
  else parent.last = container;
  fromNode.next = container;
  return container;
}

// ---------- Emphasis: the delimiter stack ----------

// https://spec.commonmark.org/0.31.2/#delimiter-run, one entry of the delimiter stack.
interface Delimiter {
  char: string;
  length: number;
  originalLength: number;
  canOpen: boolean;
  canClose: boolean;
  isAtTextEnd: boolean;
  node: TextListNode;
  previous: Delimiter | null;
  next: Delimiter | null;
}

type EmphasisKind = 'del' | 'em' | 'strong';

// CommonMark's "rule of 3": when one side can both open and close, the two runs do not pair if their lengths add up to
// a multiple of 3, unless both lengths are multiples of 3. Strikethrough has no such rule.
function isRuleOfThreeMismatch(opener: Delimiter, closer: Delimiter): boolean {
  if (closer.char === '~') return false;
  const canEitherGoBothWays = closer.canOpen || opener.canClose;
  const totalLength = opener.originalLength + closer.originalLength;
  return canEitherGoBothWays && closer.originalLength % 3 !== 0 && totalLength % 3 === 0;
}

// The nearest opener below closer that it pairs with, or null. The search stops at stackBottom and at
// openersBottom (where an earlier search for the same kind of closer already failed).
function findOpener(closer: Delimiter, stackBottom: Delimiter | null, openersBottom: Delimiter | null | undefined): Delimiter | null {
  let opener = closer.previous;
  while (opener && opener !== stackBottom && opener !== openersBottom) {
    if (opener.char === closer.char && opener.canOpen && !isRuleOfThreeMismatch(opener, closer)) return opener;
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
  isImage: boolean;
  isActive: boolean;
  previousDelimiter: Delimiter | null;
  labelStart: number;
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
// isStreaming changes only what happens at the END of the text, to a construct whose closing part has not arrived:
// a code span, emphasis run, link destination or "<https://" autolink renders as if it closed there (link
// destination null), and anything still undecided ("[label", "[^1", "&am", a trailing "\", "<", "!", "~" or a bare
// delimiter run) is not shown yet. Without isStreaming the same text parses strictly by the spec.
export function parseInline(text: string, { isStreaming = false, linkDefinitions = new Map() }: InlineOptions = {}): InlineNode[] {
  const root: ListNode = { kind: 'root', parent: null, prev: null, next: null, first: null, last: null };
  let delimiterTop: Delimiter | null = null;
  let bracketTop: BracketOpener | null = null;
  let position = 0;
  // Plain text read but not yet added to the list as a text node.
  let textBuffer = '';

  const append = <Node extends NewListNode>(newNode: Node): ListNode & Node => {
    const node = newNode as ListNode & Node;
    appendChild(root, node);
    return node;
  };

  const flushText = (): void => {
    if (textBuffer === '') return;
    append({ kind: 'text', text: textBuffer });
    textBuffer = '';
  };

  const appendAutolink = (destination: string | null, linkText: string): void => {
    flushText();
    append({ kind: 'autolink', destination, text: linkText });
  };

  const isWordStart = (): boolean => position === 0 || /[\s*_~(]/.test(text[position - 1]);

  const skipLineIndent = (): void => {
    while (text[position] === ' ') position++;
  };

  const removeDelimiter = (delimiter: Delimiter): void => {
    if (delimiter.previous) delimiter.previous.next = delimiter.next;
    if (delimiter.next) delimiter.next.previous = delimiter.previous;
    else delimiterTop = delimiter.previous;
  };

  const clearDelimiters = (stackBottom: Delimiter | null): void => {
    while (delimiterTop && delimiterTop !== stackBottom) removeDelimiter(delimiterTop);
  };

  // https://spec.commonmark.org/0.31.2/#process-emphasis, plus GFM strikethrough ("~~" pairs). Leaves unmatched
  // openers on the stack; the caller clears them.
  const processEmphasis = (stackBottom: Delimiter | null): void => {
    // Per kind of closer: below this delimiter, no opener for it was found.
    const openersBottom = new Map<string, Delimiter | null>();
    let closer = delimiterTop;
    while (closer && closer.previous !== stackBottom) closer = closer.previous;
    while (closer) {
      if (!closer.canClose) {
        closer = closer.next;
        continue;
      }
      const bottomKey = `${closer.char}${closer.canOpen}${closer.originalLength % 3}`;
      const opener = findOpener(closer, stackBottom, openersBottom.get(bottomKey));
      if (opener === null) {
        openersBottom.set(bottomKey, closer.previous);
        const next = closer.next;
        if (!closer.canOpen) removeDelimiter(closer);
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
    for (let delimiter = delimiterTop; delimiter; delimiter = delimiter.previous) {
      if (!delimiter.canOpen || delimiter.isAtTextEnd) continue;
      for (const kind of streamingKindsOf(delimiter)) wrapBetween(delimiter.node, null, { kind });
      delimiter.node.text = '';
    }
  };

  // Every read* function below reads one construct at position, moves position past it and returns true. One that
  // can also find nothing there returns false and leaves position where it was.

  // Plain text runs to the next character that can start a construct, or to the next word start (autolinks).
  const readPlainText = (): void => {
    PLAIN_TEXT_END.lastIndex = position + 1;
    const runEnd = PLAIN_TEXT_END.exec(text)?.index ?? text.length;
    textBuffer += text.slice(position, runEnd);
    position = runEnd;
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
      textBuffer += next;
      position += 2;
      return true;
    }
    textBuffer += '\\';
    position++;
    return true;
  };

  // Soft and hard breaks both render as a line break: the translator keeps only the breaks the author meant.
  const readNewline = (): true => {
    textBuffer = textBuffer.replace(/ +$/, '');
    flushText();
    append({ kind: 'line_break' });
    position++;
    skipLineIndent();
    return true;
  };

  const readCodeSpan = (): true => {
    let runEnd = position;
    while (text[runEnd] === '`') runEnd++;
    const runLength = runEnd - position;
    // The closer is a backtick run of exactly the same length.
    const closer = new RegExp(`(?<!\`)\`{${runLength}}(?!\`)`, 'g');
    closer.lastIndex = runEnd;
    const closeMatch = closer.exec(text);
    if (closeMatch) {
      let code = text.slice(runEnd, closeMatch.index).replace(/\n/g, ' ');
      // One space is stripped from each end, unless the code is only spaces.
      if (/^ .*[^ ].* $|^ [^ ] $/s.test(code)) code = code.slice(1, -1);
      flushText();
      append({ kind: 'code', text: code });
      position = closeMatch.index + runLength;
      return true;
    }
    if (isStreaming) {
      // Backticks at the very end may be the closer still arriving, so they are not shown as code.
      const code = text.slice(runEnd).replace(/`+$/, '').replace(/\n/g, ' ');
      flushText();
      if (code !== '') append({ kind: 'code', text: code });
      position = text.length;
      return true;
    }
    textBuffer += text.slice(position, runEnd);
    position = runEnd;
    return true;
  };

  // A run of "*", "_" or "~": text for now, and an entry on the delimiter stack that may become emphasis later.
  const readDelimiterRun = (char: string): true => {
    let runEnd = position;
    while (text[runEnd] === char) runEnd++;
    const run = text.slice(position, runEnd);
    const isAtTextEnd = runEnd === text.length;
    // Only "~~" strikes through. GFM also accepts a single "~", but in prose that means "about" (~5 ms), and two in
    // one paragraph would strike out everything between them. A single "~" at the very end may still become "~~".
    if (char === '~' && run.length === 1 && isAtTextEnd && isStreaming) {
      position = runEnd;
      return true;
    }
    if (char === '~' && run.length !== 2) {
      textBuffer += run;
      position = runEnd;
      return true;
    }

    const charBefore = position === 0 ? undefined : text[position - 1];
    const charAfter = text[runEnd];
    const isLeftFlanking = !isWhitespace(charAfter)
      && (!isPunctuation(charAfter) || isWhitespace(charBefore) || isPunctuation(charBefore));
    const isRightFlanking = !isWhitespace(charBefore)
      && (!isPunctuation(charBefore) || isWhitespace(charAfter) || isPunctuation(charAfter));
    let canOpen = isLeftFlanking;
    let canClose = isRightFlanking;
    // "_" is stricter, so the underscores inside snake_case words stay text.
    if (char === '_') {
      canOpen = isLeftFlanking && (!isRightFlanking || isPunctuation(charBefore));
      canClose = isRightFlanking && (!isLeftFlanking || isPunctuation(charAfter));
    }

    flushText();
    const node = append({ kind: 'text', text: run });
    const delimiter: Delimiter = {
      char,
      length: run.length,
      originalLength: run.length,
      canOpen,
      canClose,
      isAtTextEnd,
      node,
      previous: delimiterTop,
      next: null,
    };
    if (delimiterTop) delimiterTop.next = delimiter;
    delimiterTop = delimiter;
    position = runEnd;
    return true;
  };

  const readEntity = (rest: string): true => {
    const entityMatch = ENTITY_SOURCE.exec(rest);
    const decoded = entityMatch && decodeEntity(entityMatch);
    if (entityMatch && decoded !== null) {
      textBuffer += decoded;
      position += entityMatch[0].length;
      return true;
    }
    // "&am" at the very end may still become "&amp;".
    if (isStreaming && ENTITY_PREFIX_AT_END.test(rest)) {
      position = text.length;
      return true;
    }
    textBuffer += '&';
    position++;
    return true;
  };

  // "<": an autolink, raw HTML (kept as text), or a plain "<".
  const readAngleBracket = (rest: string): true => {
    const uriMatch = URI_AUTOLINK.exec(rest);
    const autolinkMatch = uriMatch ?? EMAIL_AUTOLINK.exec(rest);
    if (autolinkMatch) {
      const address = autolinkMatch[1];
      const destination = uriMatch ? address : `mailto:${address}`;
      appendAutolink(destination, address);
      position += autolinkMatch[0].length;
      return true;
    }
    const rawHtmlMatch = HTML_TAG.exec(rest) ?? OTHER_RAW_HTML.exec(rest);
    if (rawHtmlMatch) {
      textBuffer += rawHtmlMatch[0];
      position += rawHtmlMatch[0].length;
      return true;
    }
    if (isStreaming && /^<https?:\/\/[^\s<>]+$/i.test(rest)) {
      // "<https://..." whose ">" has not arrived yet is shown as a link already.
      appendAutolink(null, rest.slice(1));
      position = text.length;
      return true;
    }
    if (isStreaming && AUTOLINK_PREFIX_AT_END.test(rest)) {
      position = text.length;
      return true;
    }
    textBuffer += '<';
    position++;
    return true;
  };

  const readFootnoteRef = (rest: string): boolean => {
    const footnoteMatch = FOOTNOTE_REF.exec(rest);
    // "[^1]:" starts a footnote definition, not a reference.
    if (footnoteMatch && text[position + footnoteMatch[0].length] !== ':') {
      flushText();
      append({ kind: 'footnote_ref', label: footnoteMatch[1] });
      position += footnoteMatch[0].length;
      return true;
    }
    if (isStreaming && FOOTNOTE_REF_PREFIX_AT_END.test(rest)) {
      position = text.length;
      return true;
    }
    return false;
  };

  const openBracket = (isImage: boolean): true => {
    flushText();
    const node = append({ kind: 'text', text: isImage ? '![' : '[' });
    const markerLength = isImage ? 2 : 1;
    bracketTop = {
      node,
      isImage,
      isActive: true,
      previousDelimiter: delimiterTop,
      labelStart: position + markerLength,
      previous: bracketTop,
    };
    position += markerLength;
    return true;
  };

  // The bracket is done: the emphasis inside it is settled, and its "[" leaves the list.
  const closeOpener = (opener: BracketOpener): void => {
    processEmphasis(opener.previousDelimiter);
    clearDelimiters(opener.previousDelimiter);
    unlink(opener.node);
    bracketTop = opener.previous;
  };

  // A reference link ("[label][ref]", "[label][]" or "[label]") whose label is in the link definitions; null otherwise.
  const referenceTargetOf = (opener: BracketOpener): BracketTarget | null => {
    const labelText = text.slice(opener.labelStart, position);
    const fullReference = FULL_REFERENCE.exec(text.slice(position + 1));
    let referenceLabel = labelText;
    if (fullReference && fullReference[1].trim() !== '') referenceLabel = fullReference[1];
    if (referenceLabel.trim() === '') return null;
    const definition = linkDefinitions.get(normalizeLabel(referenceLabel));
    if (!definition) return null;
    const end = fullReference ? position + 1 + fullReference[0].length : position + 1;
    return { destination: definition.destination, title: definition.title, end };
  };

  // "]" closes the nearest "[" or "![" as a link or an image when a destination or a known label follows; otherwise
  // it is text.
  const closeBracket = (): true => {
    flushText();
    const opener: BracketOpener | null = bracketTop;
    if (!opener) {
      textBuffer += ']';
      position++;
      return true;
    }
    if (!opener.isActive) {
      // An opener inside a link: links cannot nest.
      bracketTop = opener.previous;
      textBuffer += ']';
      position++;
      return true;
    }

    const nextChar = text[position + 1];
    let target: BracketTarget | null = null;
    let isDestinationArriving = false;
    if (nextChar === '(') {
      const tail = parseLinkTail(text, position + 1);
      if (tail.status === 'ok') target = { destination: tail.destination, title: tail.title, end: tail.end };
      isDestinationArriving = tail.status === 'incomplete' && isStreaming;
    }
    // "[label]" at the very end, or "[label][ref" still arriving: whether it becomes a link is not decided yet.
    const isReferenceArriving = nextChar === '[' && !text.slice(position + 2).includes(']');
    const isLabelUndecided = isStreaming && !target && (nextChar === undefined || isReferenceArriving);
    if (isLabelUndecided) {
      closeOpener(opener);
      position = text.length;
      return true;
    }
    if (isDestinationArriving) target = { destination: null, title: null, end: text.length };
    if (!target) target = referenceTargetOf(opener);
    if (!target) {
      bracketTop = opener.previous;
      textBuffer += ']';
      position++;
      return true;
    }

    const kind = opener.isImage ? 'image' : 'link';
    wrapBetween(opener.node, null, { kind, destination: target.destination, title: target.title });
    closeOpener(opener);
    if (!opener.isImage) {
      // Links cannot nest: no "[" before this link may make one now.
      for (let earlier = bracketTop; earlier; earlier = earlier.previous) {
        if (!earlier.isImage) earlier.isActive = false;
      }
    }
    position = target.end;
    return true;
  };

  // GFM autolink literal: "www.x.com" or "https://x.com", where a word starts.
  const readUrlLiteral = (rest: string): boolean => {
    const urlMatch = EXTENDED_URL_AUTOLINK.exec(rest);
    if (!urlMatch) return false;
    const url = trimAutolinkTail(urlMatch[0]);
    const domain = url.replace(/^(?:(?:https?|ftp):\/\/)/i, '').split(/[/?#]/)[0];
    const hasScheme = /^(?:https?|ftp):\/\//i.test(url);
    if (domain === '' || !(/\./.test(domain) || hasScheme)) return false;
    const destination = /^www\./i.test(url) ? `http://${url}` : url;
    appendAutolink(destination, url);
    position += url.length;
    return true;
  };

  // GFM email literal: "name@example.com", where a word starts.
  const readEmailLiteral = (rest: string): boolean => {
    const emailMatch = EXTENDED_EMAIL_AUTOLINK.exec(rest);
    if (!emailMatch) return false;
    // GFM: a trailing "." is not part of the address, and one ending in "-" or "_" is no address at all.
    const email = emailMatch[0].replace(/\.+$/, '');
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
    const canStartConstruct = CONSTRUCT_START.test(char) || (isWordStart() && /[a-zA-Z0-9]/.test(char));
    if (!canStartConstruct) {
      readPlainText();
      continue;
    }
    const rest = text.slice(position);
    // A last "<", "!" or "\" may start something still arriving, so it is not shown yet.
    if (isStreaming && (rest === '<' || rest === '!' || rest === '\\')) {
      position++;
      continue;
    }
    if (!readConstruct(char, rest)) {
      textBuffer += char;
      position++;
    }
  }
  flushText();

  // The casts undo a narrowing to null: tsc does not see the closures above that push brackets and delimiters.
  const lastBracket = bracketTop as BracketOpener | null;
  const lastDelimiter = delimiterTop as Delimiter | null;
  if (isStreaming) {
    // Brackets still open at the end of a streaming cell: their "[" is not shown, so the label reads as plain text.
    for (let opener = lastBracket; opener; opener = opener.previous) opener.node.text = '';
  }
  // Taken before processEmphasis, which drops a run that can only close: at the very end it may still be a closer arriving.
  const runAtTextEnd = lastDelimiter?.isAtTextEnd ? lastDelimiter : null;
  processEmphasis(null);
  if (isStreaming) {
    closeOpenersAtEnd();
    if (runAtTextEnd) runAtTextEnd.node.text = '';
  }
  clearDelimiters(null);
  return toPlainNodes(root, false);
}

// ---------- From the working list to plain nodes ----------

// Linked list -> plain nested arrays, merging adjacent text. A link inside a link (only an autolink can get there)
// keeps its text and loses its link.
function toPlainNodes(container: ListNode, isInsideLink: boolean): InlineNode[] {
  const nodes: InlineNode[] = [];
  for (let node = container.first; node; node = node.next) {
    nodes.push(...plainNodesOf(node, isInsideLink));
  }
  return mergeAdjacentText(nodes);
}

function plainNodesOf(node: ListNode, isInsideLink: boolean): InlineNode[] {
  const text = node.text ?? '';
  const destination = node.destination ?? null;
  const title = node.title ?? null;
  switch (node.kind) {
    case 'text':
      if (text === '') return [];
      return [{ kind: 'text', text }];
    case 'autolink':
      if (isInsideLink) return [{ kind: 'text', text }];
      return [{ kind: 'autolink', destination, text }];
    case 'link': {
      const children = toPlainNodes(node, true);
      if (isInsideLink) return children;
      return [{ kind: 'link', destination, title, children }];
    }
    case 'image': {
      const alt = plainTextOf(toPlainNodes(node, true));
      return [{ kind: 'image', destination, title, alt }];
    }
    case 'strong':
    case 'em':
    case 'del':
      return [{ kind: node.kind, children: toPlainNodes(node, isInsideLink) }];
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
