// The log lines of a translation job (translation-jobs.ts), built by pure functions: start, closing and interrupted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TranslateRequest } from '../api-types.ts';
import { formatInterruptedLine, formatRequestSummary, formatStartLine } from './translation-jobs.ts';

const REQUEST: TranslateRequest = {
  sourceLanguage: 'en', targetLanguage: 'vi', sourceText: 'x'.repeat(10_476), modelId: 'claude-sonnet-5-5', effort: 'high',
  sourceFormat: 'markdown',
};

test('the start line names the row and the slots in use, with cold start last', () => {
  const warmLine = formatStartLine({ request: REQUEST, historyId: 64, runningCount: 2, isColdStart: false });
  assert.equal(warmLine, 'en->vi  10,476 chars  Sonnet 5.5 high  markdown  history 64  2/3 running');
  const coldLine = formatStartLine({ request: REQUEST, historyId: 63, runningCount: 1, isColdStart: true });
  assert.equal(coldLine, 'en->vi  10,476 chars  Sonnet 5.5 high  markdown  history 63  1/3 running  cold start');
});

const DONE_SUMMARY = {
  outcome: 'done' as const, modelLabel: 'Sonnet 5.5', effort: 'high' as const, durationMs: 72_500, failureText: '',
  firstTextMs: 24_100, thinkingDurationMs: 22_500, blockCount: 34, outsideCharCount: 0, outputTokens: 12_830,
  checkpointCount: 13, historyId: 63, runningCount: 2, isUnread: true,
};

test('the closing line keeps the old fields in order and adds checkpoints, slots and unread', () => {
  assert.equal(
    formatRequestSummary(DONE_SUMMARY),
    'Sonnet 5.5  high     72.5s  first text 24.1s  thought 22.5s  34 blocks  12,830 tokens  13 checkpoints  history 63  2/3 running  unread',
  );
});

test('the closing line leaves out no checkpoints and a watched end', () => {
  const summary = formatRequestSummary({ ...DONE_SUMMARY, checkpointCount: 0, isUnread: false, runningCount: 0 });
  assert.equal(summary, 'Sonnet 5.5  high     72.5s  first text 24.1s  thought 22.5s  34 blocks  12,830 tokens  history 63  0/3 running');
});

test('a cancel cause sits where a failure would', () => {
  const summary = formatRequestSummary({
    ...DONE_SUMMARY, outcome: 'cancelled', durationMs: 12_300, failureText: 'by delete', firstTextMs: 6000, thinkingDurationMs: null,
    blockCount: 2, outputTokens: null, checkpointCount: 2, historyId: 66, runningCount: 0, isUnread: false,
  });
  assert.equal(summary, 'Sonnet 5.5  high     12.3s  by delete  first text 6.0s  2 blocks  2 checkpoints  history 66  0/3 running');
});

test('the interrupted line lists each row and what it kept', () => {
  const line = formatInterruptedLine([{ id: 63, blockCount: 18 }, { id: 64, blockCount: 1 }, { id: 65, blockCount: 0 }]);
  assert.equal(line, '3 translations interrupted by a restart: 63 (18 blocks saved), 64 (1 block saved), 65 (nothing saved)');
  assert.equal(formatInterruptedLine([{ id: 67, blockCount: 21 }]), '1 translation interrupted by a restart: 67 (21 blocks saved)');
});

test('the interrupted line stops after 10 rows and counts the rest', () => {
  const rows = Array.from({ length: 14 }, (_, index) => ({ id: index + 1, blockCount: 0 }));
  const listed = rows.slice(0, 10).map((row) => `${row.id} (nothing saved)`).join(', ');
  assert.equal(formatInterruptedLine(rows), `14 translations interrupted by a restart: ${listed}, and 4 more`);
});
