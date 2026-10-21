// HTTP helpers shared by every feature's routes.
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import type { ApiErrorBody, ApiProblem } from '../api-types.ts';

// What a feature (src/features/<name>/) gives the entry file: its routes. handle returns true when it answered.
// start, when there is one, runs once the server is listening.
export interface Feature {
  name: string;
  handle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean>;
  start?(): void;
}

// Throws when the body is not JSON. max_bytes: a larger body throws too, before it is all read into memory.
export async function readJsonBody(req: IncomingMessage, max_bytes = Infinity): Promise<unknown> {
  const chunks: Buffer[] = [];
  let byte_count = 0;
  for await (const chunk of req) {
    chunks.push(chunk);
    byte_count += chunk.length;
    if (byte_count > max_bytes) throw new Error(`body is larger than ${max_bytes} bytes`);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// The one error shape of a JSON API: { error: { code, message, problems? } }.
export function sendError(res: ServerResponse, status_code: number, code: string, message: string, problems?: ApiProblem[], headers: Record<string, string> = {}): void {
  const body: ApiErrorBody = { error: problems === undefined ? { code, message } : { code, message, problems } };
  res.writeHead(status_code, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

// Finds where text stops being JSON: the offset of the first character that breaks the grammar (or text.length when the
// text ends too early). Used only to say where a body that JSON.parse refused went wrong, because V8 names a position
// for some mistakes only. It follows the grammar of RFC 8259 and builds no values.
function jsonErrorOffset(text: string): number {
  let index = 0;

  // Every helper moves index past what it read, or throws the offset where it failed.
  function fail(): never {
    throw index;
  }

  function skipSpace(): void {
    while (index < text.length && ' \t\n\r'.includes(text[index])) index++;
  }

  function readWord(word: string): void {
    if (!text.startsWith(word, index)) fail();
    index += word.length;
  }

  function readString(): void {
    index++; // the opening quote
    while (text[index] !== '"') {
      if (index >= text.length || text.charCodeAt(index) < 0x20) fail();
      if (text[index] === '\\') {
        index++;
        const is_unicode = text[index] === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(index + 1, index + 5));
        if (is_unicode) index += 4;
        else if (index >= text.length || !'"\\/bfnrt'.includes(text[index])) fail();
      }
      index++;
    }
    index++; // the closing quote
  }

  function readNumber(): void {
    const number = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(index));
    if (number === null) fail();
    index += number[0].length;
  }

  // [ value, value ] or { "name": value, "name": value }
  function readList(close: ']' | '}'): void {
    index++; // the opening bracket
    skipSpace();
    if (text[index] === close) {
      index++;
      return;
    }
    while (true) {
      if (close === '}') {
        skipSpace();
        if (text[index] !== '"') fail();
        readString();
        skipSpace();
        if (text[index] !== ':') fail();
        index++;
      }
      readValue();
      skipSpace();
      if (text[index] === close) {
        index++;
        return;
      }
      if (text[index] !== ',') fail();
      index++;
    }
  }

  function readValue(): void {
    skipSpace();
    const char = text[index];
    if (char === '{') readList('}');
    else if (char === '[') readList(']');
    else if (char === '"') readString();
    else if (char === 't') readWord('true');
    else if (char === 'f') readWord('false');
    else if (char === 'n') readWord('null');
    else readNumber();
  }

  try {
    readValue();
    skipSpace();
    // Valid JSON followed by more text: the extra text is the mistake.
    return index;
  } catch (offset) {
    return offset as number;
  }
}

// "Not valid JSON (line 3, column 5)." for text JSON.parse refused.
export function jsonProblemOf(text: string): string {
  const lines = text.slice(0, jsonErrorOffset(text)).split('\n');
  return `Not valid JSON (line ${lines.length}, column ${(lines.at(-1) as string).length + 1}).`;
}

// The body as JSON, or undefined when it is too large (413 too_large) or not JSON (400 bad_json), the error already sent.
// A body over max_bytes is read to its end but not kept, so the answer reaches the client before the connection closes.
export async function readRequestJson(req: IncomingMessage, res: ServerResponse, max_bytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let byte_count = 0;
  for await (const chunk of req) {
    byte_count += chunk.length;
    if (byte_count <= max_bytes) chunks.push(chunk);
  }
  if (byte_count > max_bytes) {
    sendError(res, 413, 'too_large', `The body is larger than ${max_bytes} bytes.`);
    return undefined;
  }
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    sendError(res, 400, 'bad_json', jsonProblemOf(text));
    return undefined;
  }
}

export function sendJson(res: ServerResponse, status_code: number, body: unknown): void {
  res.writeHead(status_code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

// The file is read before the status line is sent, so a missing file is a 500, not an empty 200.
export async function sendFile(res: ServerResponse, path: string, content_type: string): Promise<void> {
  const content = await readFile(path);
  res.writeHead(200, { 'Content-Type': content_type, 'Cache-Control': 'no-cache' });
  res.end(content);
}

// A page module, served as JavaScript with its types stripped, so the browser runs the same file tsc checks.
export async function sendModule(res: ServerResponse, path: string): Promise<void> {
  const source = stripTypeScriptTypes(await readFile(path, 'utf8'));
  res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(source);
}
