// Characterization tests for POST /translate through the real server and a fake claude (test/fake-claude/claude).
// They pin what the page sees, so moving the claude runner into shared/ cannot change it unnoticed.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, translate, type TestServer } from './server-harness.ts';

let server: TestServer;
before(async () => { server = await startTestServer(); });
after(async () => { await server.stop(); });

const eventNames = (events: [string, any][]) => events.map(([name]) => name);

test('a normal reply streams the pair and ends with done, saved to history', async () => {
  const events = await translate(server.base_url, 'Hello FAKE:ok');
  assert.deepEqual(eventNames(events), ['pair_start', 'source_delta', 'translation_delta', 'done']);
  assert.deepEqual(events[0][1], { pair_index: 0, pair_type: 'paragraph', level: 0, marker: '' });
  assert.deepEqual(events[1][1], { pair_index: 0, text: 'Hello' });
  assert.deepEqual(events[2][1], { pair_index: 0, text: 'Xin chào' });
  const done = events[3][1];
  assert.equal(done.served_model_id, 'claude-sonnet-5-5');
  assert.equal(done.is_fallback, false);
  assert.equal(typeof done.history_id, 'number');
  const translation = await (await fetch(`${server.base_url}/history/${done.history_id}`)).json();
  assert.equal(translation.run.status, 'succeeded');
  assert.equal(translation.run.requestedModelId, 'claude-sonnet-5-5');
  assert.equal(translation.run.servedModelId, 'claude-sonnet-5-5');
  assert.equal(translation.sourceFormat, 'plain_text');
  assert.equal(translation.sourceText, 'Hello FAKE:ok');
  assert.deepEqual(translation.blocks, [{ blockType: 'paragraph', level: 0, marker: null, sourceText: 'Hello', translatedText: 'Xin chào' }]);
  assert.equal(translation.textOutsideBlocks, null);

  const list = await (await fetch(`${server.base_url}/history`)).json();
  const summary = list.find((item: any) => item.id === done.history_id);
  assert.equal(summary.sourcePreview, 'Hello FAKE:ok');
  assert.equal(summary.outputPreview, 'Xin chào');
});

test('claude is started with the same flags and the translate system prompt', async () => {
  await translate(server.base_url, 'Flags FAKE:ok');
  const run = server.claudeRuns().find((logged_run) => logged_run.content.includes('Flags FAKE:ok'));
  assert.ok(run);
  const { args } = run;
  for (const flag of ['-p', '--tools', '--setting-sources', '--disable-slash-commands', '--strict-mcp-config', '--no-session-persistence',
    '--input-format', '--output-format', '--verbose', '--include-partial-messages', '--thinking-display']) {
    assert.ok(args.includes(flag), `missing ${flag}`);
  }
  assert.equal(args[args.indexOf('--model') + 1], 'claude-sonnet-5-5');
  assert.equal(args[args.indexOf('--effort') + 1], 'low');
  assert.match(args[args.indexOf('--system-prompt') + 1], /<glossary>/);
  assert.match(run.content, /^Translate from English into Vietnamese\.\n\n<input_text>\nFlags FAKE:ok\n<\/input_text>$/);
});

test('an error result ends with error claude_error, and the failed run is saved with its reason', async () => {
  const events = await translate(server.base_url, 'Hello FAKE:error');
  assert.deepEqual(eventNames(events), ['error']);
  assert.equal(events[0][1].error_kind, 'claude_error');
  assert.equal(events[0][1].message, 'Fake API error');
  const translation = await (await fetch(`${server.base_url}/history/${events[0][1].history_id}`)).json();
  assert.equal(translation.run.status, 'failed');
  assert.equal(translation.run.errorCode, 'claude_error');
  assert.equal(translation.run.errorMessage, 'Fake API error');
  assert.deepEqual(translation.blocks, []);
  assert.notEqual(translation.run.finishedAt, null);
});

test('a crash ends with error exited and the stderr text', async () => {
  const events = await translate(server.base_url, 'Hello FAKE:crash');
  assert.deepEqual(eventNames(events), ['error']);
  assert.equal(events[0][1].error_kind, 'exited');
  assert.equal(events[0][1].message, 'fake claude crashed');
  const translation = await (await fetch(`${server.base_url}/history/${events[0][1].history_id}`)).json();
  assert.equal(translation.run.errorCode, 'exited');
});

test('a silent model hands over to the next one down after 10s', { timeout: 30_000 }, async () => {
  const events = await translate(server.base_url, 'Hello FAKE:silent_first');
  assert.deepEqual(eventNames(events), ['fallback', 'pair_start', 'source_delta', 'translation_delta', 'done']);
  assert.deepEqual(events[0][1], { from_model_id: 'claude-sonnet-5-5', to_model_id: 'claude-haiku-5-5' });
  assert.equal(events[4][1].served_model_id, 'claude-haiku-5-5');
  assert.equal(events[4][1].is_fallback, true);
  const translation = await (await fetch(`${server.base_url}/history/${events[4][1].history_id}`)).json();
  assert.equal(translation.run.requestedModelId, 'claude-sonnet-5-5');
  assert.equal(translation.run.servedModelId, 'claude-haiku-5-5');
});

test('a bad request is rejected with 400', async () => {
  const response = await fetch(`${server.base_url}/translate`, { method: 'POST', body: '{}' });
  assert.equal(response.status, 400);
});
