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

export async function startTestServer(): Promise<TestServer> {
  const port = await freePort();
  const dataDirectory = mkdtempSync(join(tmpdir(), 'claude-translate-test-'));
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
    stop: () => new Promise((resolve) => {
      serverProcess.removeAllListeners('exit');
      serverProcess.on('exit', () => resolve());
      serverProcess.kill('SIGTERM');
    }),
  };
}

// Posts a translation and returns its Server-Sent Events as [name, data] in order.
export async function translate(baseUrl: string, text: string, modelId = 'claude-sonnet-5-5'): Promise<[string, any][]> {
  const response = await fetch(`${baseUrl}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceLanguage: 'en', targetLanguage: 'vi', sourceText: text, modelId, effort: 'low', sourceFormat: 'plain_text' }),
  });
  const body = await response.text();
  return body.split('\n\n').filter((block) => block.trim() !== '').map((block) => {
    const [eventLine, dataLine] = block.split('\n');
    return [eventLine.replace('event: ', ''), JSON.parse(dataLine.replace('data: ', ''))];
  });
}
