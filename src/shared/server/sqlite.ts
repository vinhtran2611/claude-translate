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
export function openDatabase(databasePath: string, schemaVersion: number, migrate: (database: DatabaseSync, fileSchemaVersion: number) => void): DatabaseSync {
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA busy_timeout = 2000');
  // Each committed transaction reaches the disk before COMMIT returns, so a crash or power loss cannot undo it.
  database.exec('PRAGMA synchronous = FULL');
  const { user_version: fileSchemaVersion } = database.prepare('PRAGMA user_version').get() as { user_version: number };
  if (fileSchemaVersion > schemaVersion) {
    throw new Error(`database ${databasePath} is at schema version ${fileSchemaVersion}, newer than this code (${schemaVersion})`);
  }
  if (fileSchemaVersion > 0 && fileSchemaVersion < schemaVersion) {
    const backupPath = join(dirname(databasePath), 'backups', `${basename(databasePath, extname(databasePath))}-before-schema-${schemaVersion}.sqlite`);
    if (!existsSync(backupPath)) {
      mkdirSync(dirname(backupPath), { recursive: true });
      database.prepare('VACUUM INTO ?').run(backupPath);
    }
  }
  const { foreign_keys: foreignKeys } = database.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
  database.exec('PRAGMA foreign_keys = OFF');
  database.exec('BEGIN IMMEDIATE');
  try {
    migrate(database, fileSchemaVersion);
    const broken = database.prepare('PRAGMA foreign_key_check').all();
    if (broken.length > 0) throw new Error(`migrating ${databasePath} would break ${broken.length} foreign key(s): ${JSON.stringify(broken.slice(0, 3))}`);
    database.exec(`PRAGMA user_version = ${schemaVersion}`);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  } finally {
    database.exec(`PRAGMA foreign_keys = ${foreignKeys === 1 ? 'ON' : 'OFF'}`);
  }
  return database;
}

function userVersionOf(databasePath: string): number {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const { user_version: userVersion } = database.prepare('PRAGMA user_version').get() as { user_version: number };
    return userVersion;
  } finally {
    database.close();
  }
}

// The first free path backups/<name>-<label>.sqlite, backups/<name>-<label>-2.sqlite... next to database_path.
function freeBackupPath(databasePath: string, label: string): string {
  const name = basename(databasePath, extname(databasePath));
  const backupsDirectory = join(dirname(databasePath), 'backups');
  let candidate = join(backupsDirectory, `${name}-${label}.sqlite`);
  for (let count = 2; existsSync(candidate); count++) candidate = join(backupsDirectory, `${name}-${label}-${count}.sqlite`);
  return candidate;
}

// Gives a database file its new name, once: only when old_path exists. The file is first copied to
// backups/<old name>-before-rename.sqlite next to it, so the rename can always be undone. Opening the file for the copy
// also finishes a transaction a crash left in its journal, so nothing is left behind.
// A file already at new_path is the result of an earlier rename when its schema is at least new_schema_version: then
// nothing is done. An older one is a leftover of an even earlier version of the app; it is moved to
// backups/<new name>-set-aside.sqlite first, never deleted.
// Returns what it did, for the log.
export function renameDatabaseOnce(oldPath: string, newPath: string, newSchemaVersion: number): 'nothing' | 'renamed' | 'renamed_after_set_aside' {
  if (!existsSync(oldPath)) return 'nothing';
  let isSetAside = false;
  if (existsSync(newPath)) {
    if (userVersionOf(newPath) >= newSchemaVersion) return 'nothing';
    const setAsidePath = freeBackupPath(newPath, 'set-aside');
    mkdirSync(dirname(setAsidePath), { recursive: true });
    renameSync(newPath, setAsidePath);
    isSetAside = true;
  }
  const backupPath = join(dirname(oldPath), 'backups', `${basename(oldPath, extname(oldPath))}-before-rename.sqlite`);
  mkdirSync(dirname(backupPath), { recursive: true });
  const database = new DatabaseSync(oldPath);
  try {
    if (!existsSync(backupPath)) database.prepare('VACUUM INTO ?').run(backupPath);
  } finally {
    database.close();
  }
  renameSync(oldPath, newPath);
  if (isSetAside) return 'renamed_after_set_aside';
  return 'renamed';
}

// Runs fn in one transaction: all of its writes land, or none do. A dry run rolls them all back after fn, so fn's result
// (read inside the transaction) says exactly what a real run would do, by the same code.
export function inTransaction<Result>(database: DatabaseSync, fn: () => Result, isDryRun = false): Result {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    database.exec(isDryRun ? 'ROLLBACK' : 'COMMIT');
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
export function backupDaily(databasePath: string, backupsDirectory: string, name: string, now = new Date()): string | null {
  if (!existsSync(databasePath)) return null;
  const backupPath = join(backupsDirectory, `${name}-${localDateText(now)}.sqlite`);
  if (existsSync(backupPath)) return null;
  mkdirSync(backupsDirectory, { recursive: true });
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    database.prepare('VACUUM INTO ?').run(backupPath);
  } finally {
    database.close();
  }
  const backupPattern = new RegExp(`^${name}-\\d{4}-\\d{2}-\\d{2}\\.sqlite$`);
  const backups = readdirSync(backupsDirectory).filter((fileName) => backupPattern.test(fileName)).sort();
  for (const oldBackup of backups.slice(0, Math.max(0, backups.length - BACKUPS_KEPT))) rmSync(join(backupsDirectory, oldBackup));
  return backupPath;
}
