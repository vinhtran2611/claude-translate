// The English log hooks: what gets checked, how the check block is read, and the submit → stop round trip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECK_INSTRUCTION, openEnglishLog, ownText, parseCheckBlock, replyTextSinceLastPrompt, shouldCheck } from '../features/english-log/hook.ts';

const HOOK_PATH = join(dirname(dirname(fileURLToPath(import.meta.url))), 'features', 'english-log', 'hook.ts');

test('ownText drops pasted blocks and fenced code', () => {
  const prompt = 'look at this <pasted_content id="a1">\nsome pasted log\n</pasted_content id="a1"> and ```js\ncode()\n``` thanks';
  assert.equal(ownText(prompt), 'look at this   and   thanks');
});

test('shouldCheck skips slash commands, app events and short replies', () => {
  assert.equal(shouldCheck('/model opus'), false);
  assert.equal(shouldCheck('<side-sessions-event>done</side-sessions-event>'), false);
  assert.equal(shouldCheck('yes, do it'), false);
  assert.equal(shouldCheck('i need you think carfully'), true);
});

test('parseCheckBlock reads the corrected text and every mistake line', () => {
  const reply = [
    '> ✏️ **Corrected:** I need you to think carefully.',
    '> - *need you think* → **need you to think** · verb_form',
    '> - *carfully* → **carefully** · spelling',
    '> - *simplyfy* → **simple** · made_up_category',
    '> - *i* → **I** · capital letters',
    '> - a line in the wrong shape',
    '',
    'Here is the answer.',
  ].join('\n');
  assert.deepEqual(parseCheckBlock(reply), {
    status: 'checked',
    corrected: 'I need you to think carefully.',
    errors: [
      { wrong: 'need you think', right: 'need you to think', category: 'verb_form' },
      { wrong: 'carfully', right: 'carefully', category: 'spelling' },
      { wrong: 'simplyfy', right: 'simple', category: 'other' },
      { wrong: 'i', right: 'I', category: 'punctuation' },
    ],
  });
});

test('parseCheckBlock keeps a correction that wraps onto more quote lines', () => {
  const reply = '> ✏️ **Corrected:** First sentence.\n> Second sentence.\n> - *a* → **b** · article';
  const result = parseCheckBlock(reply);
  assert.equal(result?.status === 'checked' && result.corrected, 'First sentence.\nSecond sentence.');
});

test('parseCheckBlock reads a clean message and returns null without a block', () => {
  assert.deepEqual(parseCheckBlock('> ✓ No mistakes.\n\nSure.'), { status: 'clean' });
  assert.equal(parseCheckBlock('Just an answer.'), null);
});

test('replyTextSinceLastPrompt stops at the last real user message, not at tool results', () => {
  const transcript = [
    { type: 'user', message: { content: 'old message' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'old reply' }] } },
    { type: 'user', message: { content: 'new message' } },
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: '…' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'block' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'final' }] } },
  ].map((entry) => JSON.stringify(entry)).join('\n');
  assert.deepEqual(replyTextSinceLastPrompt(transcript), ['block', 'final']);
});

function runHook(mode: string, input: object, database_path: string) {
  return spawnSync(process.execPath, ['--no-warnings', HOOK_PATH, mode], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, ENGLISH_LOG_DATABASE_PATH: database_path },
  });
}

test('submit then stop saves the message and its correction in one row', () => {
  const directory = mkdtempSync(join(tmpdir(), 'english-log-'));
  const database_path = join(directory, 'english-log.sqlite');
  const transcript_path = join(directory, 'transcript.jsonl');

  const submit = runHook('submit', { session_id: 's1', cwd: '/tmp', prompt: 'i need you think carfully' }, database_path);
  assert.equal(submit.status, 0);
  assert.equal(JSON.parse(submit.stdout).hookSpecificOutput.additionalContext, CHECK_INSTRUCTION);

  writeFileSync(transcript_path, [
    { type: 'user', message: { content: 'i need you think carfully' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '> ✏️ **Corrected:** I need you to think carefully.\n> - *need you think* → **need you to think** · verb_form' }] } },
  ].map((entry) => JSON.stringify(entry)).join('\n'));
  const stop = runHook('stop', { session_id: 's1', transcript_path, last_assistant_message: 'Done.' }, database_path);
  assert.equal(stop.status, 0);

  const database = openEnglishLog(database_path);
  const row = database.prepare('SELECT original, corrected, errors_json, status FROM messages').get();
  database.close();
  assert.deepEqual({ ...row }, {
    original: 'i need you think carfully',
    corrected: 'I need you to think carefully.',
    errors_json: JSON.stringify([{ wrong: 'need you think', right: 'need you to think', category: 'verb_form' }]),
    status: 'checked',
  });
});

test('submit skips a short reply and a broken input never fails the hook', () => {
  const database_path = join(mkdtempSync(join(tmpdir(), 'english-log-')), 'english-log.sqlite');
  const skipped = runHook('submit', { session_id: 's1', prompt: 'ok go' }, database_path);
  assert.equal(skipped.status, 0);
  assert.equal(skipped.stdout, '');
  const broken = spawnSync(process.execPath, ['--no-warnings', HOOK_PATH, 'stop'], { input: 'not json', encoding: 'utf8' });
  assert.equal(broken.status, 0);
  assert.match(broken.stderr, /english-log:/);
});
