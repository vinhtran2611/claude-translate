// The English log hooks: what gets checked, how the check block is read, and the submit → stop round trip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  CHECK_INSTRUCTION, finishCheck, openEnglishLog, ownText, parseCheckBlock, replyTextSinceLastPrompt, saveNewCheck, shouldCheck,
} from '../features/english-log/hook.ts';

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
    correctedText: 'I need you to think carefully.',
    mistakes: [
      { wrongText: 'need you think', correctText: 'need you to think', category: 'verb_form' },
      { wrongText: 'carfully', correctText: 'carefully', category: 'spelling' },
      { wrongText: 'simplyfy', correctText: 'simple', category: 'other' },
      { wrongText: 'i', correctText: 'I', category: 'punctuation' },
    ],
  });
});

test('parseCheckBlock keeps a correction that wraps onto more quote lines', () => {
  const reply = '> ✏️ **Corrected:** First sentence.\n> Second sentence.\n> - *a* → **b** · article';
  assert.equal(parseCheckBlock(reply)?.correctedText, 'First sentence.\nSecond sentence.');
});

test('parseCheckBlock reads a clean message (no corrected text, no mistakes) and returns null without a block', () => {
  assert.deepEqual(parseCheckBlock('> ✓ No mistakes.\n\nSure.'), { correctedText: null, mistakes: [] });
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
  const check = database.prepare(`
    SELECT claude_session_id, working_directory, source_text, corrected_text, run_status, run_requested_model_id, run_effort,
           run_finished_at IS NOT NULL AS is_finished
    FROM english_checks`).get();
  const mistakes = database.prepare('SELECT english_check_id, position, wrong_text, correct_text, category FROM english_mistakes').all();
  database.close();
  assert.deepEqual({ ...check }, {
    claude_session_id: 's1',
    working_directory: '/tmp',
    source_text: 'i need you think carfully',
    corrected_text: 'I need you to think carefully.',
    run_status: 'succeeded',
    run_requested_model_id: null,
    run_effort: null,
    is_finished: 1,
  });
  assert.deepEqual(mistakes.map((row) => ({ ...row })), [
    { english_check_id: 1, position: 1, wrong_text: 'need you think', correct_text: 'need you to think', category: 'verb_form' },
  ]);
});

test('a reply without a check block fails the check; a new message fails a check left running', () => {
  const database_path = join(mkdtempSync(join(tmpdir(), 'english-log-')), 'english-log.sqlite');
  const database = openEnglishLog(database_path);
  const first = saveNewCheck(database, 's1', null, 'one message that was cut off');
  saveNewCheck(database, 's1', null, 'a second message with no block');
  finishCheck(database, 's1', null);
  const rows = database.prepare('SELECT id, run_status, run_error_code FROM english_checks ORDER BY id').all().map((row) => ({ ...row }));
  database.close();
  assert.deepEqual(rows, [
    { id: first, run_status: 'failed', run_error_code: 'interrupted' },
    { id: first + 1, run_status: 'failed', run_error_code: 'no_check_block' },
  ]);
});

test('a schema 1 log is backed up and migrated: messages become checks, errors_json becomes mistake rows', () => {
  const directory = mkdtempSync(join(tmpdir(), 'english-log-'));
  const database_path = join(directory, 'english-log.sqlite');
  const old = new DatabaseSync(database_path);
  old.exec(`
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, session_id TEXT NOT NULL, cwd TEXT NOT NULL,
      original TEXT NOT NULL, corrected TEXT, errors_json TEXT, status TEXT NOT NULL, checked_at TEXT) STRICT;
    PRAGMA user_version = 1;`);
  const insert = old.prepare('INSERT INTO messages (created_at, session_id, cwd, original, corrected, errors_json, status, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const errors = JSON.stringify([{ wrong: 'i', right: 'I', category: 'punctuation' }, { wrong: 'go', right: 'goes', category: 'odd' }]);
  insert.run('2026-10-20T10:00:00.000Z', 's1', '/work', 'i go home', 'I go home.', errors, 'checked', '2026-10-20T10:00:05.000Z');
  insert.run('2026-10-20T11:00:00.000Z', 's1', '', 'All good here today', null, '[]', 'clean', '2026-10-20T11:00:03.000Z');
  insert.run('2026-10-20T12:00:00.000Z', 's2', '/work', 'no block came back', null, null, 'parse_failed', '2026-10-20T12:00:02.000Z');
  insert.run('2026-10-20T13:00:00.000Z', 's2', '/work', 'still waiting for it', null, null, 'pending', null);
  old.close();

  const database = openEnglishLog(database_path);
  const checks = database.prepare(`
    SELECT id, claude_session_id, working_directory, run_status, run_error_code, run_started_at, run_finished_at, created_at, updated_at
    FROM english_checks ORDER BY id`).all().map((row) => ({ ...row }));
  const mistakes = database.prepare('SELECT english_check_id, position, wrong_text, correct_text, category FROM english_mistakes ORDER BY id')
    .all().map((row) => ({ ...row }));
  database.close();
  assert.deepEqual(checks, [
    {
      id: 1, claude_session_id: 's1', working_directory: '/work', run_status: 'succeeded', run_error_code: null,
      run_started_at: '2026-10-20T10:00:00.000Z', run_finished_at: '2026-10-20T10:00:05.000Z', created_at: '2026-10-20T10:00:00.000Z',
      updated_at: '2026-10-20T10:00:00.000Z',
    },
    {
      id: 2, claude_session_id: 's1', working_directory: null, run_status: 'succeeded', run_error_code: null,
      run_started_at: '2026-10-20T11:00:00.000Z', run_finished_at: '2026-10-20T11:00:03.000Z', created_at: '2026-10-20T11:00:00.000Z',
      updated_at: '2026-10-20T11:00:00.000Z',
    },
    {
      id: 3, claude_session_id: 's2', working_directory: '/work', run_status: 'failed', run_error_code: 'no_check_block',
      run_started_at: '2026-10-20T12:00:00.000Z', run_finished_at: '2026-10-20T12:00:02.000Z', created_at: '2026-10-20T12:00:00.000Z',
      updated_at: '2026-10-20T12:00:00.000Z',
    },
    {
      id: 4, claude_session_id: 's2', working_directory: '/work', run_status: 'running', run_error_code: null,
      run_started_at: '2026-10-20T13:00:00.000Z', run_finished_at: null, created_at: '2026-10-20T13:00:00.000Z',
      updated_at: '2026-10-20T13:00:00.000Z',
    },
  ]);
  assert.deepEqual(mistakes, [
    { english_check_id: 1, position: 1, wrong_text: 'i', correct_text: 'I', category: 'punctuation' },
    { english_check_id: 1, position: 2, wrong_text: 'go', correct_text: 'goes', category: 'other' },
  ]);
  const backup = new DatabaseSync(join(directory, 'backups', 'english-log-before-schema-2.sqlite'), { readOnly: true });
  assert.deepEqual({ ...backup.prepare('SELECT count(*) AS count FROM messages').get() }, { count: 4 });
  backup.close();
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
