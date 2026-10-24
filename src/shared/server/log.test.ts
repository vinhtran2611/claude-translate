// The log line layout (log.ts): the columns line up whatever the level, #n and event.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatLogLine } from './log.ts';

// Local time, as the log prints it.
const DATE = new Date(2026, 9, 24, 9, 39, 7);

test('the message starts at the same column for the narrowest and widest level, #n and event', () => {
  const narrowLine = formatLogLine(DATE, 'info', 1, 'start', 'message', [], false);
  const wideLine = formatLogLine(DATE, 'error', 999, 'cancelled', 'message', [], false);
  const noRequestLine = formatLogLine(DATE, 'warn', null, 'http', 'message', [], false);
  assert.equal(narrowLine, '09:39:07       #1   start     message');
  assert.equal(wideLine, '09:39:07 ERROR #999 cancelled message');
  assert.equal(noRequestLine, '09:39:07 WARN       http      message');
});

test('detail lines print under the message column', () => {
  const line = formatLogLine(DATE, 'error', 2, 'error', 'exited', ['stderr one', 'stderr two'], false);
  const expected = [
    '09:39:07 ERROR #2   error     exited',
    '                              | stderr one',
    '                              | stderr two',
  ].join('\n');
  assert.equal(line, expected);
});
