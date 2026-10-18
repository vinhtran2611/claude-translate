// Opening a feature's SQLite file: the same safety rules as server/history-store.ts, for any feature's database.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
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
