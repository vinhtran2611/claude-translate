// Characterization tests for POST /translate through the real server and a fake claude (test/helpers/fake-claude/claude).
// They pin what the page sees, so moving the claude runner into shared/ cannot change it unnoticed.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, translate, type TestServer } from '../helpers/server-harness.ts';

let server: TestServer;
before(async () => { server = await startTestServer(); });
after(async () => { await server.stop(); });

const eventNames = (events: [string, any][]) => events.map(([name]) => name);

test('a normal reply streams the block and ends with done, saved to history', async () => {
  const events = await translate(server.baseUrl, 'Hello FAKE:ok');
  assert.deepEqual(eventNames(events), ['block_start', 'source_delta', 'translation_delta', 'done']);
  assert.deepEqual(events[0][1], { blockIndex: 0, blockType: 'paragraph', level: 0, marker: null });
  assert.deepEqual(events[1][1], { blockIndex: 0, text: 'Hello' });
  assert.deepEqual(events[2][1], { blockIndex: 0, text: 'Xin chào' });
  const done = events[3][1];
  assert.equal(done.servedModelId, 'claude-sonnet-5-5');
  assert.equal(done.isFallback, false);
  assert.equal(typeof done.durationMs, 'number');
  assert.equal(typeof done.translationId, 'number');
  const translation = await (await fetch(`${server.baseUrl}/history/${done.translationId}`)).json();
  assert.equal(translation.run.status, 'succeeded');
  assert.equal(translation.run.requestedModelId, 'claude-sonnet-5-5');
  assert.equal(translation.run.servedModelId, 'claude-sonnet-5-5');
  assert.equal(translation.sourceFormat, 'plain_text');
  assert.equal(translation.sourceText, 'Hello FAKE:ok');
  assert.deepEqual(translation.blocks, [{ blockType: 'paragraph', level: 0, marker: null, sourceText: 'Hello', translatedText: 'Xin chào' }]);
  assert.equal(translation.textOutsideBlocks, null);

  const list = await (await fetch(`${server.baseUrl}/history`)).json();
  const summary = list.find((item: any) => item.id === done.translationId);
  assert.equal(summary.sourcePreview, 'Hello FAKE:ok');
  assert.equal(summary.outputPreview, 'Xin chào');
});

test('claude is started with the same flags and the translate system prompt', async () => {
  await translate(server.baseUrl, 'Flags FAKE:ok');
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
  const events = await translate(server.baseUrl, 'Hello FAKE:error');
  assert.deepEqual(eventNames(events), ['error']);
  assert.equal(events[0][1].errorCode, 'claude_error');
  assert.equal(events[0][1].message, 'Fake API error');
  const translation = await (await fetch(`${server.baseUrl}/history/${events[0][1].translationId}`)).json();
  assert.equal(translation.run.status, 'failed');
  assert.equal(translation.run.errorCode, 'claude_error');
  assert.equal(translation.run.errorMessage, 'Fake API error');
  assert.deepEqual(translation.blocks, []);
  assert.notEqual(translation.run.finishedAt, null);
});

test('a crash ends with error exited and the stderr text', async () => {
  const events = await translate(server.baseUrl, 'Hello FAKE:crash');
  assert.deepEqual(eventNames(events), ['error']);
  assert.equal(events[0][1].errorCode, 'exited');
  assert.equal(events[0][1].message, 'fake claude crashed');
  const translation = await (await fetch(`${server.baseUrl}/history/${events[0][1].translationId}`)).json();
  assert.equal(translation.run.errorCode, 'exited');
});

test('a silent model hands over to the next one down after 10s', { timeout: 30_000 }, async () => {
  const events = await translate(server.baseUrl, 'Hello FAKE:silent_first');
  assert.deepEqual(eventNames(events), ['fallback', 'block_start', 'source_delta', 'translation_delta', 'done']);
  assert.deepEqual(events[0][1], { fromModelId: 'claude-sonnet-5-5', toModelId: 'claude-haiku-5-5' });
  assert.equal(events[4][1].servedModelId, 'claude-haiku-5-5');
  assert.equal(events[4][1].isFallback, true);
  const translation = await (await fetch(`${server.baseUrl}/history/${events[4][1].translationId}`)).json();
  assert.equal(translation.run.requestedModelId, 'claude-sonnet-5-5');
  assert.equal(translation.run.servedModelId, 'claude-haiku-5-5');
});

test('a bad request is rejected with 400, and an old snake_case body is a bad request', async () => {
  const response = await fetch(`${server.baseUrl}/translate`, { method: 'POST', body: '{}' });
  assert.equal(response.status, 400);
  const old_body = { source_language: 'en', target_language: 'vi', text: 'Hi', model_id: 'claude-sonnet-5-5', effort: 'low', mode: 'translate' };
  const old = await fetch(`${server.baseUrl}/translate`, { method: 'POST', body: JSON.stringify(old_body) });
  assert.equal(old.status, 400);
});

test('the translation options use the same words: source formats and camelCase', async () => {
  const options = await (await fetch(`${server.baseUrl}/translation-options`)).json() as any;
  assert.deepEqual(options.sourceFormats.map((option: any) => option.sourceFormat), ['plain_text', 'markdown']);
  assert.equal(options.defaultSourceFormat, 'plain_text');
  assert.equal(options.defaultModelId, 'claude-sonnet-5-5');
  assert.equal(options.models[0].modelId, 'claude-opus-5-5');
  assert.equal(typeof options.models[0].shortLabel, 'string');
  assert.equal(options.quotaWarning, null);
});
