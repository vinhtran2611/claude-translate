// The shared HTTP helpers (src/shared/server/http.ts) that need no server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jsonProblemOf } from '../src/shared/server/http.ts';

test('a JSON mistake is named by line and column', () => {
  assert.equal(jsonProblemOf('{\n  "answer": oops\n}'), 'Not valid JSON (line 2, column 13).');
  assert.equal(jsonProblemOf('{"a": 1,}'), 'Not valid JSON (line 1, column 9).');
  assert.equal(jsonProblemOf('{"a" 1}'), 'Not valid JSON (line 1, column 6).');
  assert.equal(jsonProblemOf('{"a": "\\x"}'), 'Not valid JSON (line 1, column 9).');
});

test('text that ends too early points just past its end; extra text points at the extra', () => {
  assert.equal(jsonProblemOf(''), 'Not valid JSON (line 1, column 1).');
  assert.equal(jsonProblemOf('[1, 2'), 'Not valid JSON (line 1, column 6).');
  assert.equal(jsonProblemOf('{} x'), 'Not valid JSON (line 1, column 4).');
  assert.equal(jsonProblemOf('01'), 'Not valid JSON (line 1, column 2).');
});
