// Opening a feature's SQLite file with the same safety rules for every feature's database: migrations in one
// transaction after a backup, daily backups, and a one-time rename of a file.
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// migrate(file_schema_version) brings a file from that version (0 for a new file) to schema_version; it runs inside
// one BEGIN IMMEDIATE transaction, so a failed migration leaves the file as it was. Throws when the file was written by
// a newer version of the code, rather than risk damaging it. Before an existing file is migrated it is copied to
// backups/<name>-before-schema-<version>.sqlite next to it (kept if it is already there: the first copy is the oldest).
// Foreign keys are off while it migrates, so a table can be rebuilt; they are checked before COMMIT.
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
  if (file_schema_version > 0 && file_schema_version < schema_version) {
    const backup_path = join(dirname(database_path), 'backups', `${basename(database_path, extname(database_path))}-before-schema-${schema_version}.sqlite`);
    if (!existsSync(backup_path)) {
      mkdirSync(dirname(backup_path), { recursive: true });
      database.prepare('VACUUM INTO ?').run(backup_path);
    }
  }
  const { foreign_keys } = database.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
  database.exec('PRAGMA foreign_keys = OFF');
  database.exec('BEGIN IMMEDIATE');
  try {
    migrate(database, file_schema_version);
    const broken = database.prepare('PRAGMA foreign_key_check').all();
    if (broken.length > 0) throw new Error(`migrating ${database_path} would break ${broken.length} foreign key(s): ${JSON.stringify(broken.slice(0, 3))}`);
    database.exec(`PRAGMA user_version = ${schema_version}`);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  } finally {
    database.exec(`PRAGMA foreign_keys = ${foreign_keys === 1 ? 'ON' : 'OFF'}`);
  }
  return database;
}

function userVersionOf(database_path: string): number {
  const database = new DatabaseSync(database_path, { readOnly: true });
  try {
    const { user_version } = database.prepare('PRAGMA user_version').get() as { user_version: number };
    return user_version;
  } finally {
    database.close();
  }
}

// The first free path backups/<name>-<label>.sqlite, backups/<name>-<label>-2.sqlite... next to database_path.
function freeBackupPath(database_path: string, label: string): string {
  const name = basename(database_path, extname(database_path));
  const backups_directory = join(dirname(database_path), 'backups');
  let candidate = join(backups_directory, `${name}-${label}.sqlite`);
  for (let count = 2; existsSync(candidate); count++) candidate = join(backups_directory, `${name}-${label}-${count}.sqlite`);
  return candidate;
}

// Gives a database file its new name, once: only when old_path exists. The file is first copied to
// backups/<old name>-before-rename.sqlite next to it, so the rename can always be undone. Opening the file for the copy
// also finishes a transaction a crash left in its journal, so nothing is left behind.
// A file already at new_path is the result of an earlier rename when its schema is at least new_schema_version: then
// nothing is done. An older one is a leftover of an even earlier version of the app; it is moved to
// backups/<new name>-set-aside.sqlite first, never deleted.
// Returns what it did, for the log.
export function renameDatabaseOnce(old_path: string, new_path: string, new_schema_version: number): 'nothing' | 'renamed' | 'renamed_after_set_aside' {
  if (!existsSync(old_path)) return 'nothing';
  let is_set_aside = false;
  if (existsSync(new_path)) {
    if (userVersionOf(new_path) >= new_schema_version) return 'nothing';
    const set_aside_path = freeBackupPath(new_path, 'set-aside');
    mkdirSync(dirname(set_aside_path), { recursive: true });
    renameSync(new_path, set_aside_path);
    is_set_aside = true;
  }
  const backup_path = join(dirname(old_path), 'backups', `${basename(old_path, extname(old_path))}-before-rename.sqlite`);
  mkdirSync(dirname(backup_path), { recursive: true });
  const database = new DatabaseSync(old_path);
  try {
    if (!existsSync(backup_path)) database.prepare('VACUUM INTO ?').run(backup_path);
  } finally {
    database.close();
  }
  renameSync(old_path, new_path);
  if (is_set_aside) return 'renamed_after_set_aside';
  return 'renamed';
}

// Runs fn in one transaction: all of its writes land, or none do. A dry run rolls them all back after fn, so fn's result
// (read inside the transaction) says exactly what a real run would do, by the same code.
export function inTransaction<Result>(database: DatabaseSync, fn: () => Result, is_dry_run = false): Result {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    database.exec(is_dry_run ? 'ROLLBACK' : 'COMMIT');
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
