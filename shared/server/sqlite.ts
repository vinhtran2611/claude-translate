// Opening a feature's SQLite file: the same safety rules as server/history-store.ts, for any feature's database.
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// migrate(file_schema_version) brings a file from that version (0 for a new file) to schema_version; it runs inside
// one BEGIN IMMEDIATE transaction, so a failed migration leaves the file as it was. Throws when the file was written by
// a newer version of the code, rather than risk damaging it.
export function openDatabase(database_path: string, schema_version: number, migrate: (database: DatabaseSync, file_schema_version: number) => void): DatabaseSync {
  mkdirSync(dirname(database_path), { recursive: true });
  const database = new DatabaseSync(database_path);
  database.exec('PRAGMA busy_timeout = 2000');
  // Each committed transaction reaches the disk before COMMIT returns, so a crash or power loss cannot undo it.
  database.exec('PRAGMA synchronous = FULL');
  const { user_version: file_schema_version } = database.prepare('PRAGMA user_version').get() as { user_version: number };
  if (file_schema_version > schema_version) {
    throw new Error(`database ${database_path} is at schema version ${file_schema_version}, newer than this code (${schema_version})`);
  }
  database.exec('BEGIN IMMEDIATE');
  try {
    migrate(database, file_schema_version);
    database.exec(`PRAGMA user_version = ${schema_version}`);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  return database;
}

// Runs fn in one transaction: all of its writes land, or none do.
export function inTransaction<Result>(database: DatabaseSync, fn: () => Result): Result {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

// Arbitrary: a month of daily copies; at ~10 KB per essay attempt that is a few MB.
const BACKUPS_KEPT = 30;

function localDateText(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// Copies database_path to <backups_directory>/<name>-YYYY-MM-DD.sqlite unless today's copy exists, then keeps the
// newest BACKUPS_KEPT copies of that name. VACUUM INTO makes a consistent copy even while the server has the file
// open. Returns the new copy's path, or null when today's copy already existed or there is no database yet.
// Restore: stop the server and copy a backup over the live file.
export function backupDaily(database_path: string, backups_directory: string, name: string, now = new Date()): string | null {
  if (!existsSync(database_path)) return null;
  const backup_path = join(backups_directory, `${name}-${localDateText(now)}.sqlite`);
  if (existsSync(backup_path)) return null;
  mkdirSync(backups_directory, { recursive: true });
  const database = new DatabaseSync(database_path, { readOnly: true });
  try {
    database.prepare('VACUUM INTO ?').run(backup_path);
  } finally {
    database.close();
  }
  const backup_pattern = new RegExp(`^${name}-\\d{4}-\\d{2}-\\d{2}\\.sqlite$`);
  const backups = readdirSync(backups_directory).filter((file_name) => backup_pattern.test(file_name)).sort();
  for (const old_backup of backups.slice(0, Math.max(0, backups.length - BACKUPS_KEPT))) rmSync(join(backups_directory, old_backup));
  return backup_path;
}
