// The app's entry file: daily backups, the Host check, the static files, the feature list and listen. Each feature's
// routes live in src/features/<name>/server/routes.ts.
import { mkdirSync, statSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { basename, dirname, extname, join, relative, sep } from 'node:path';
import { createPracticeFeature } from './features/practice/server/routes.ts';
import { SCHEMA_VERSION as PRACTICE_SCHEMA_VERSION } from './features/practice/server/store-schema.ts';
import { SCHEMA_VERSION as TRANSLATE_SCHEMA_VERSION } from './features/translate/server/history-store.ts';
import { createTranslateFeature } from './features/translate/server/routes.ts';
import { sendError, sendFile, sendModule, type Feature } from './shared/server/http.ts';
import { configureLogFile, log, LOG_DETAIL_MAX_LINES } from './shared/server/log.ts';
import { APP_DIRECTORY, DATA_DIRECTORY, SHARED_DIRECTORY, SOURCE_DIRECTORY } from './shared/server/paths.ts';
import { backupDaily, renameDatabaseOnce } from './shared/server/sqlite.ts';

// Browsers ask for /favicon.ico on their own.
const FAVICON_PATH = join(SHARED_DIRECTORY, 'web', 'favicon.svg');
const TRANSLATE_DATABASE_PATH = process.env.TRANSLATE_DATABASE_PATH ?? join(DATA_DIRECTORY, 'translate.sqlite');
const PRACTICE_DATABASE_PATH = process.env.PRACTICE_DATABASE_PATH ?? join(DATA_DIRECTORY, 'practice.sqlite');
// The names the files had before the schema version lived only in PRAGMA user_version (docs/data-model-proposal.md §4
// and §5). Each is renamed once, after a backup, when the server uses the default path. An old data/practice.sqlite
// from before practice-v2 (never read since) is moved to backups/ first.
const RENAMED_DATABASES = [
  {
    old_path: join(DATA_DIRECTORY, 'history.sqlite'),
    new_path: TRANSLATE_DATABASE_PATH,
    schema_version: TRANSLATE_SCHEMA_VERSION,
    is_default: process.env.TRANSLATE_DATABASE_PATH === undefined,
  },
  {
    old_path: join(DATA_DIRECTORY, 'practice-v2.sqlite'),
    new_path: PRACTICE_DATABASE_PATH,
    schema_version: PRACTICE_SCHEMA_VERSION,
    is_default: process.env.PRACTICE_DATABASE_PATH === undefined,
  },
];
// Next to the database by default, so a test server on a scratch database never writes into the real log.
const SERVER_LOG_PATH = process.env.SERVER_LOG_PATH ?? join(dirname(TRANSLATE_DATABASE_PATH), 'server.log');
const BACKUPS_DIRECTORY = join(dirname(TRANSLATE_DATABASE_PATH), 'backups');
// Each database gets one copy a day; the check runs at start and then hourly, so a server left running past
// midnight still makes the next day's copy.
const DAILY_BACKUPS = [{ path: TRANSLATE_DATABASE_PATH, name: 'translate' }, { path: PRACTICE_DATABASE_PATH, name: 'practice' }];
const BACKUP_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const PORT = Number(process.env.PORT ?? 8787);
// What a served file is sent as, by its extension. A .ts file is sent as JavaScript with its types stripped, so the
// browser runs the same file tsc checks. A file with any other extension is not served.
const CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.md', 'text/plain; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
]);
// Folders whose files stay on the server: its code and the prompts. *.test.ts files stay on the server too.
const PRIVATE_FOLDERS = new Set(['server', 'prompts']);

// The file under src/ that a URL names, when the browser may fetch it; null otherwise. A file's URL is its path under
// src/, so a page module's relative import resolves the same for tsc and the browser.
function servedFileOf(pathname: string): string | null {
  const path = join(SOURCE_DIRECTORY, pathname);
  if (!path.startsWith(`${SOURCE_DIRECTORY}${sep}`)) return null;
  const folders = relative(SOURCE_DIRECTORY, path).split(sep).slice(0, -1);
  // A file right in src/ is the entry file.
  if (folders.length === 0) return null;
  if (folders.some((folder) => PRIVATE_FOLDERS.has(folder))) return null;
  // Tests sit next to the code they test, but only Node runs them.
  if (path.endsWith('.test.ts')) return null;
  const extension = extname(path);
  if (extension !== '.ts' && !CONTENT_TYPES.has(extension)) return null;
  const is_file = statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
  if (!is_file) return null;
  return path;
}

async function sendServedFile(res: ServerResponse, path: string): Promise<void> {
  const extension = extname(path);
  if (extension === '.ts') await sendModule(res, path);
  else await sendFile(res, path, CONTENT_TYPES.get(extension) as string);
}

function runDailyBackups(): void {
  for (const { path, name } of DAILY_BACKUPS) {
    try {
      const backup_path = backupDaily(path, BACKUPS_DIRECTORY, name);
      if (backup_path !== null) log('info', null, 'backup', backup_path);
    } catch (error) {
      log('error', null, 'backup', `${name} failed: ${(error as Error).message}`);
    }
  }
}

mkdirSync(dirname(SERVER_LOG_PATH), { recursive: true });
configureLogFile(SERVER_LOG_PATH);
for (const { old_path, new_path, schema_version, is_default } of RENAMED_DATABASES) {
  if (!is_default) continue;
  const renamed = renameDatabaseOnce(old_path, new_path, schema_version);
  if (renamed === 'renamed_after_set_aside') log('warn', null, 'data', `an older ${basename(new_path)} was moved to backups/`);
  if (renamed !== 'nothing') log('info', null, 'data', `${basename(old_path)} renamed to ${basename(new_path)}`);
}
// Each feature opens its database here, so a damaged or newer file stops the server at startup, not mid-request.
const features: Feature[] = [
  createTranslateFeature({ database_path: TRANSLATE_DATABASE_PATH }),
  createPracticeFeature({ databasePath: PRACTICE_DATABASE_PATH }),
];
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
// A rebinding page can retry without end; one line per Host names it without flooding the log.
const logged_forbidden_hosts = new Set<string>();

const server = createServer(async (req, res) => {
  // Loopback binding alone does not stop DNS rebinding: a page on another site whose name resolves to
  // 127.0.0.1 would otherwise read /history as same-origin. Its requests carry that site's Host header.
  const host = req.headers.host ?? '';
  if (!ALLOWED_HOSTS.has(host)) {
    if (!logged_forbidden_hosts.has(host)) {
      logged_forbidden_hosts.add(host);
      log('warn', null, 'http', `403 ${req.method} ${req.url} from Host ${JSON.stringify(host)}`);
    }
    res.writeHead(403).end('Forbidden host');
    return;
  }
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  try {
    const served_file = req.method === 'GET' ? servedFileOf(pathname) : null;
    if (served_file !== null) {
      await sendServedFile(res, served_file);
    } else if (req.method === 'GET' && pathname === '/favicon.ico') {
      await sendFile(res, FAVICON_PATH, 'image/svg+xml');
    } else {
      let is_handled = false;
      for (const feature of features) {
        is_handled = await feature.handle(req, res, pathname);
        if (is_handled) break;
      }
      // A JSON API answers in its one error shape; anything else stays a bare 404.
      if (!is_handled && pathname.startsWith('/api/')) sendError(res, 404, 'not_found', `Nothing at ${pathname}.`);
      else if (!is_handled) res.writeHead(404).end();
    }
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    const stack_frame_lines = String(failure.stack ?? '').split('\n').slice(1, 1 + LOG_DETAIL_MAX_LINES)
      .map((line) => line.replaceAll(`file://${APP_DIRECTORY}/`, ''));
    log('error', null, 'http', `500 ${req.method} ${pathname}: ${failure.message}`, stack_frame_lines);
    if (res.headersSent) res.end();
    else if (pathname.startsWith('/api/')) sendError(res, 500, 'internal', 'Internal error: the details are in the server log.');
    else res.writeHead(500).end('Internal error');
  }
});

// Bound to loopback only: anyone who can reach this port spends your Claude subscription.
server.listen(PORT, '127.0.0.1', () => {
  log('info', null, 'ready', `http://localhost:${PORT}  (Ctrl-C stops)`);
  for (const feature of features) feature.start?.();
  runDailyBackups();
  setInterval(runDailyBackups, BACKUP_CHECK_INTERVAL_MS).unref();
});
