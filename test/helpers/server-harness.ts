// Starts the real server on a free port with test/helpers/fake-claude first on PATH and scratch data files, for tests
// that go through HTTP. Not a test file itself: npm test runs *.test.ts files only.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_DIRECTORY } from '../../src/shared/server/paths.ts';

const FAKE_CLAUDE_DIRECTORY = join(APP_DIRECTORY, 'test', 'helpers', 'fake-claude');

export interface TestServer {
  baseUrl: string;
  dataDirectory: string;
  // The runs the fake claude saw, oldest first.
  claudeRuns(): { args: string[]; content: string }[];
  stop(): Promise<void>;
  // Stops the server the way a crash does: SIGKILL, so nothing of it runs on the way out.
  kill(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

// dataDirectory: the scratch files of a server started before, to start it again on them; a new folder by default.
export async function startTestServer(dataDirectory = mkdtempSync(join(tmpdir(), 'claude-translate-test-'))): Promise<TestServer> {
  const port = await freePort();
  const claudeLogPath = join(dataDirectory, 'fake-claude.log');
  const serverProcess: ChildProcess = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(APP_DIRECTORY, 'src', 'server.ts')], {
    env: {
      ...process.env,
      PORT: String(port),
      PATH: `${FAKE_CLAUDE_DIRECTORY}:${process.env.PATH}`,
      TRANSLATE_DATABASE_PATH: join(dataDirectory, 'translate.sqlite'),
      PRACTICE_DATABASE_PATH: join(dataDirectory, 'practice.sqlite'),
      FAKE_CLAUDE_LOG: claudeLogPath,
      NO_COLOR: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 10_000);
    serverProcess.stdout?.on('data', (chunk) => {
      output += chunk;
      if (output.includes(' ready ')) { clearTimeout(timer); resolve(); }
    });
    serverProcess.stderr?.on('data', (chunk) => { output += chunk; });
    serverProcess.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited with ${code}:\n${output}`)); });
  });
  return {
    baseUrl: `http://localhost:${port}`,
    dataDirectory,
    claudeRuns: () => existsSync(claudeLogPath)
      ? readFileSync(claudeLogPath, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line))
      : [],
    stop: () => stopServer(serverProcess, 'SIGTERM'),
    kill: () => stopServer(serverProcess, 'SIGKILL'),
  };
}

function stopServer(serverProcess: ChildProcess, signal: NodeJS.Signals): Promise<void> {
  return new Promise((resolve) => {
    serverProcess.removeAllListeners('exit');
    serverProcess.on('exit', () => resolve());
    serverProcess.kill(signal);
  });
}

// One Server-Sent Event as [name, data].
export type StreamEvent = [string, any];

// A run's stream, read one event at a time, for tests that act midway: leave like a page does, or watch from a second one.
export interface EventStream {
  status: number;
  // The next event; null once the stream has ended.
  next(): Promise<StreamEvent | null>;
  // Every event until the stream ends.
  rest(): Promise<StreamEvent[]>;
  // Stops reading and closes the connection, as a page that leaves does.
  close(): void;
}

function parseStreamEvent(block: string): StreamEvent {
  const name = /^event: (.*)$/m.exec(block)![1];
  const data = JSON.parse(/^data: (.*)$/m.exec(block)![1]);
  return [name, data];
}

export async function openEventStream(url: string, init: RequestInit = {}): Promise<EventStream> {
  const controller = new AbortController();
  const response = await fetch(url, { ...init, signal: controller.signal });
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  // Events read from the body but not yet returned by next().
  const pending: StreamEvent[] = [];

  async function next(): Promise<StreamEvent | null> {
    while (pending.length === 0) {
      const { value, done } = await reader.read();
      if (done) return null;
      buffer += value;
      // A blank line ends each event; the last part may be an event still arriving.
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';
      for (const block of blocks) {
        if (block.trim() !== '') pending.push(parseStreamEvent(block));
      }
    }
    return pending.shift()!;
  }

  async function rest(): Promise<StreamEvent[]> {
    const events: StreamEvent[] = [];
    let streamEvent = await next();
    while (streamEvent !== null) {
      events.push(streamEvent);
      streamEvent = await next();
    }
    return events;
  }

  return { status: response.status, next, rest, close: () => controller.abort() };
}

// Posts a translation and returns its stream as it starts.
export function startTranslation(baseUrl: string, text: string, modelId = 'claude-sonnet-5-5'): Promise<EventStream> {
  const body = { sourceLanguage: 'en', targetLanguage: 'vi', sourceText: text, modelId, effort: 'low', sourceFormat: 'plain_text' };
  return openEventStream(`${baseUrl}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Posts a translation and returns its Server-Sent Events as [name, data] in order.
export async function translate(baseUrl: string, text: string, modelId = 'claude-sonnet-5-5'): Promise<StreamEvent[]> {
  const stream = await startTranslation(baseUrl, text, modelId);
  return stream.rest();
}

// The saved row once its run has ended, polled the way a page that left would find it.
export async function waitForTranslation(baseUrl: string, translationId: number): Promise<any> {
  for (let tries = 0; tries < 100; tries++) {
    const translation = await (await fetch(`${baseUrl}/history/${translationId}`)).json();
    if (translation.run.status !== 'running') return translation;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`translation ${translationId} did not finish`);
}
