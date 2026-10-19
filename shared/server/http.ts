// HTTP helpers shared by every feature's routes.
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import type { ApiErrorBody, ApiProblem } from '../api.ts';

// What a feature (features/<name>/) gives the entry file: its routes. handle returns true when it answered.
export interface Feature {
  name: string;
  handle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean>;
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

// Where JSON.parse gave up: V8 names the position for some mistakes only, so the text is walked again by the JSON grammar.
// Called only for text JSON.parse refused.
function jsonErrorOffset(text: string): number {
  let index = 0;
  const fail = (): never => { throw index; };
  const space = (): void => { while (/[ \t\n\r]/.test(text[index] ?? '')) index++; };
  const literal = (word: string): void => { if (text.startsWith(word, index)) index += word.length; else fail(); };
  const string = (): void => {
    index++;
    while (text[index] !== '"') {
      if (index >= text.length || text.charCodeAt(index) < 0x20) fail();
      if (text[index] === '\\') {
        index++;
        if (text[index] === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(index + 1, index + 5))) index += 4;
        else if (!'"\\/bfnrt'.includes(text[index] ?? 'x')) fail();
      }
      index++;
    }
    index++;
  };
  const value = (): void => {
    space();
    const char = text[index];
    if (char === '{' || char === '[') {
      const close = char === '{' ? '}' : ']';
      index++;
      space();
      if (text[index] === close) { index++; return; }
      for (;;) {
        if (close === '}') {
          space();
          if (text[index] !== '"') fail();
          string();
          space();
          if (text[index] !== ':') fail();
          index++;
        }
        value();
        space();
        if (text[index] === ',') { index++; continue; }
        if (text[index] === close) { index++; return; }
        fail();
      }
    }
    if (char === '"') return string();
    const number = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(index))?.[0];
    if (number) { index += number.length; return; }
    for (const word of ['true', 'false', 'null']) if (text.startsWith(word, index)) return literal(word);
    fail();
  };
  try {
    value();
    space();
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
