// The modular-monolith rule (docs/practice-proposal.md §6), checked over all of src/, tests included: code in
// src/features/<name>/ imports only from its own feature and from src/shared/; src/shared/ imports only itself; and
// nothing in src/ imports from outside src/ (test/ helpers included).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { APP_DIRECTORY, FEATURES_DIRECTORY, SHARED_DIRECTORY, SOURCE_DIRECTORY } from '../src/shared/server/paths.ts';

const IMPORT_PATH = /(?:^|\n)\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/g;

function typeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name));
}

test('features import only from themselves and shared/', () => {
  const violations: string[] = [];
  for (const filePath of typeScriptFiles(FEATURES_DIRECTORY)) {
    const featureName = relative(FEATURES_DIRECTORY, filePath).split('/')[0];
    for (const [, importPath] of readFileSync(filePath, 'utf8').matchAll(IMPORT_PATH)) {
      if (!importPath.startsWith('.')) continue;
      // The import's target, relative to src/.
      const target = relative(SOURCE_DIRECTORY, resolve(dirname(filePath), importPath));
      if (!target.startsWith(`features/${featureName}/`) && !target.startsWith('shared/')) {
        violations.push(`${relative(APP_DIRECTORY, filePath)} imports ${target}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('shared/ imports nothing from features/, server/ or web/', () => {
  const violations: string[] = [];
  for (const filePath of typeScriptFiles(SHARED_DIRECTORY)) {
    for (const [, importPath] of readFileSync(filePath, 'utf8').matchAll(IMPORT_PATH)) {
      if (!importPath.startsWith('.')) continue;
      // The import's target, relative to src/.
      const target = relative(SOURCE_DIRECTORY, resolve(dirname(filePath), importPath));
      if (!target.startsWith('shared/')) violations.push(`${relative(APP_DIRECTORY, filePath)} imports ${target}`);
    }
  }
  assert.deepEqual(violations, []);
});

test('nothing in src/ imports from outside src/', () => {
  const violations: string[] = [];
  for (const filePath of typeScriptFiles(SOURCE_DIRECTORY)) {
    for (const [, importPath] of readFileSync(filePath, 'utf8').matchAll(IMPORT_PATH)) {
      if (!importPath.startsWith('.')) continue;
      // The import's target, relative to src/; one outside src/ starts with "..".
      const target = relative(SOURCE_DIRECTORY, resolve(dirname(filePath), importPath));
      if (target.startsWith('..')) violations.push(`${relative(APP_DIRECTORY, filePath)} imports ${target}`);
    }
  }
  assert.deepEqual(violations, []);
});
