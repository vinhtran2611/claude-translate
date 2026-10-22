// base.css writes the dark colours twice, for the system setting and for data-theme; the two must say the same.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('the two dark colour blocks of base.css say the same', () => {
  const css = readFileSync(new URL('./base.css', import.meta.url), 'utf8');
  const blockOf = (opening: string) => {
    const start = css.indexOf(opening) + opening.length;
    return css.slice(start, css.indexOf('}', start)).trim().replace(/\s+/g, ' ');
  };
  const by_system = blockOf(':root:not([data-theme="light"]) {');
  assert.ok(by_system.length > 200);
  assert.equal(blockOf(':root[data-theme="dark"] {'), by_system);
});
