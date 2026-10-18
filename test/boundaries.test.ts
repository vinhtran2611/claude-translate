// The modular-monolith rule (docs/practice-proposal.md §7.1): code in features/<name>/ imports only from its own
// feature and from shared/, never from another feature or from the legacy server/ and web/ folders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIRECTORY = dirname(dirname(fileURLToPath(import.meta.url)));
const FEATURES_DIRECTORY = join(APP_DIRECTORY, 'features');
const IMPORT_PATH = /(?:^|\n)\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/g;

function typeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name));
}

test('features import only from themselves and shared/', () => {
  const violations: string[] = [];
  for (const file_path of typeScriptFiles(FEATURES_DIRECTORY)) {
    const feature_name = relative(FEATURES_DIRECTORY, file_path).split('/')[0];
    for (const [, import_path] of readFileSync(file_path, 'utf8').matchAll(IMPORT_PATH)) {
      if (!import_path.startsWith('.')) continue;
      const target = relative(APP_DIRECTORY, resolve(dirname(file_path), import_path));
      if (!target.startsWith(`features/${feature_name}/`) && !target.startsWith('shared/')) {
        violations.push(`${relative(APP_DIRECTORY, file_path)} imports ${target}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('shared/ imports nothing from features/, server/ or web/', () => {
  const violations: string[] = [];
  for (const file_path of typeScriptFiles(join(APP_DIRECTORY, 'shared'))) {
    for (const [, import_path] of readFileSync(file_path, 'utf8').matchAll(IMPORT_PATH)) {
      if (!import_path.startsWith('.')) continue;
      const target = relative(APP_DIRECTORY, resolve(dirname(file_path), import_path));
      if (!target.startsWith('shared/')) violations.push(`${relative(APP_DIRECTORY, file_path)} imports ${target}`);
    }
  }
  assert.deepEqual(violations, []);
});
