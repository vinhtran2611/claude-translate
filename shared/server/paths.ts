// The repo's folders, found in one place. Every other file builds its paths from these, so moving a file does not
// break the paths it reads.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The repo root: this file is shared/server/paths.ts, two folders down.
export const APP_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Runtime data (databases, backups, the server log). Ignored by git.
export const DATA_DIRECTORY = join(APP_DIRECTORY, 'data');
export const DOCS_DIRECTORY = join(APP_DIRECTORY, 'docs');
export const FEATURES_DIRECTORY = join(APP_DIRECTORY, 'features');
export const SHARED_DIRECTORY = join(APP_DIRECTORY, 'shared');
