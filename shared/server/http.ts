// HTTP helpers shared by every feature's routes.
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';

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

export function sendJson(res: ServerResponse, status_code: number, body: unknown): void {
  res.writeHead(status_code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

export async function sendFile(res: ServerResponse, path: string, content_type: string): Promise<void> {
  res.writeHead(200, { 'Content-Type': content_type, 'Cache-Control': 'no-cache' });
  res.end(await readFile(path));
}

// A page module, served as JavaScript with its types stripped, so the browser runs the same file tsc checks.
export async function sendModule(res: ServerResponse, path: string): Promise<void> {
  res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(stripTypeScriptTypes(await readFile(path, 'utf8')));
}
