// Starts the real server on a free port with test/fake-claude first on PATH and scratch data files, for tests that
// go through HTTP. Not a test file itself: npm test runs test/*.test.ts only.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIRECTORY = dirname(dirname(fileURLToPath(import.meta.url)));
const FAKE_CLAUDE_DIRECTORY = join(APP_DIRECTORY, 'test', 'fake-claude');

export interface TestServer {
  base_url: string;
  data_directory: string;
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
  const data_directory = mkdtempSync(join(tmpdir(), 'claude-translate-test-'));
  const claude_log_path = join(data_directory, 'fake-claude.log');
  const server_process: ChildProcess = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(APP_DIRECTORY, 'server', 'server.ts')], {
    env: {
      ...process.env,
      PORT: String(port),
      PATH: `${FAKE_CLAUDE_DIRECTORY}:${process.env.PATH}`,
      HISTORY_DATABASE_PATH: join(data_directory, 'history.sqlite'),
      PRACTICE_DATABASE_PATH: join(data_directory, 'practice-v2.sqlite'),
      FAKE_CLAUDE_LOG: claude_log_path,
      NO_COLOR: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 10_000);
    server_process.stdout?.on('data', (chunk) => {
      output += chunk;
      if (output.includes(' ready ')) { clearTimeout(timer); resolve(); }
    });
    server_process.stderr?.on('data', (chunk) => { output += chunk; });
    server_process.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited with ${code}:\n${output}`)); });
  });
  return {
    base_url: `http://localhost:${port}`,
    data_directory,
    claudeRuns: () => existsSync(claude_log_path)
      ? readFileSync(claude_log_path, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line))
      : [],
    stop: () => new Promise((resolve) => {
      server_process.removeAllListeners('exit');
      server_process.on('exit', () => resolve());
      server_process.kill('SIGTERM');
    }),
  };
}

// Posts a translation and returns its Server-Sent Events as [name, data] in order.
export async function translate(base_url: string, text: string, model_id = 'claude-sonnet-5-5'): Promise<[string, any][]> {
  const response = await fetch(`${base_url}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_language: 'en', target_language: 'vi', text, model_id, effort: 'low', mode: 'translate' }),
  });
  const body = await response.text();
  return body.split('\n\n').filter((block) => block.trim() !== '').map((block) => {
    const [event_line, data_line] = block.split('\n');
    return [event_line.replace('event: ', ''), JSON.parse(data_line.replace('data: ', ''))];
  });
}
