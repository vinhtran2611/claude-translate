// Tests for detect-language.ts: which way a text is translated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectSourceLanguage } from './detect-language.ts';

test('English text is detected as English', () => {
  assert.equal(detectSourceLanguage('Please check the latency of this service.'), 'en');
});

test('Vietnamese mixed with English terms is detected as Vietnamese', () => {
  assert.equal(detectSourceLanguage('anh check giúp em latency p99'), 'vi');
});

test('English that names a Vietnamese person stays English', () => {
  assert.equal(detectSourceLanguage('Thanks Nguyễn Văn An for the review'), 'en');
});

test('quoted Vietnamese inside English does not count', () => {
  assert.equal(detectSourceLanguage('The sign said "cấm đỗ xe" in red.'), 'en');
});
