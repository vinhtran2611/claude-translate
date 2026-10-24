// Characterization tests for POST /translate through the real server and a fake claude (test/helpers/fake-claude/claude).
// They pin what the page sees, so moving the claude runner into shared/ cannot change it unnoticed. A run is a job owned
// by the server (docs/translate-background-jobs-design.md): its stream starts with a snapshot, a page can leave and come
// back, and only cancel stops it.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_RUNNING_TRANSLATIONS } from '../../src/features/translate/server/translation-jobs.ts';
import {
  openEventStream, startTestServer, startTranslation, translate, waitForTranslation, type EventStream, type StreamEvent, type TestServer,
} from '../helpers/server-harness.ts';

let server: TestServer;
before(async () => { server = await startTestServer(); });
after(async () => { await server.stop(); });

const eventNames = (events: StreamEvent[]) => events.map(([name]) => name);

// A reply the fake claude streams a word every 250 ms (about 2 s in all), so a test can act while it runs.
const STREAM_REPLY = '<pair type="paragraph"><source>One two three four</source><translation>Một hai ba bốn</translation></pair>';
const STREAM_BLOCK = { blockType: 'paragraph', level: 0, marker: null, sourceText: 'One two three four', translatedText: 'Một hai ba bốn' };

function watchRun(translationId: number) {
  return openEventStream(`${server.baseUrl}/history/${translationId}/events`);
}

function cancelRun(translationId: number): Promise<Response> {
  return fetch(`${server.baseUrl}/history/${translationId}/cancel`, { method: 'POST' });
}

// Reads the stream until an event of this name, and returns it.
async function readUntil(stream: EventStream, name: string): Promise<StreamEvent> {
  let streamEvent = await stream.next();
  while (streamEvent !== null && streamEvent[0] !== name) streamEvent = await stream.next();
  assert.ok(streamEvent, `the stream ended before ${name}`);
  return streamEvent;
}

test('a normal reply streams the block and ends with done, saved to history', async () => {
  const events = await translate(server.baseUrl, 'Hello FAKE:ok');
  assert.deepEqual(eventNames(events), ['snapshot', 'block_start', 'source_delta', 'translation_delta', 'done']);
  assert.deepEqual(events[1][1], { blockIndex: 0, blockType: 'paragraph', level: 0, marker: null });
  assert.deepEqual(events[2][1], { blockIndex: 0, text: 'Hello' });
  assert.deepEqual(events[3][1], { blockIndex: 0, text: 'Xin chào' });
  const done = events[4][1];
  assert.equal(done.servedModelId, 'claude-sonnet-5-5');
  assert.equal(done.isFallback, false);
  assert.equal(typeof done.durationMs, 'number');
  assert.equal(done.translationId, events[0][1].translation.id);
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
  const run = server.claudeRuns().find((loggedRun) => loggedRun.content.includes('Flags FAKE:ok'));
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
  assert.deepEqual(eventNames(events), ['snapshot', 'error']);
  assert.equal(events[1][1].errorCode, 'claude_error');
  assert.equal(events[1][1].message, 'Fake API error');
  const translation = await (await fetch(`${server.baseUrl}/history/${events[1][1].translationId}`)).json();
  assert.equal(translation.run.status, 'failed');
  assert.equal(translation.run.errorCode, 'claude_error');
  assert.equal(translation.run.errorMessage, 'Fake API error');
  assert.deepEqual(translation.blocks, []);
  assert.notEqual(translation.run.finishedAt, null);
});

test('a crash ends with error exited and the stderr text', async () => {
  const events = await translate(server.baseUrl, 'Hello FAKE:crash');
  assert.deepEqual(eventNames(events), ['snapshot', 'error']);
  assert.equal(events[1][1].errorCode, 'exited');
  assert.equal(events[1][1].message, 'fake claude crashed');
  const translation = await (await fetch(`${server.baseUrl}/history/${events[1][1].translationId}`)).json();
  assert.equal(translation.run.errorCode, 'exited');
});

test('a silent model hands over to the next one down after 10s', { timeout: 30_000 }, async () => {
  const events = await translate(server.baseUrl, 'Hello FAKE:silent_first');
  assert.deepEqual(eventNames(events), ['snapshot', 'fallback', 'block_start', 'source_delta', 'translation_delta', 'done']);
  assert.deepEqual(events[1][1], { fromModelId: 'claude-sonnet-5-5', toModelId: 'claude-haiku-5-5' });
  assert.equal(events[5][1].servedModelId, 'claude-haiku-5-5');
  assert.equal(events[5][1].isFallback, true);
  const translation = await (await fetch(`${server.baseUrl}/history/${events[5][1].translationId}`)).json();
  assert.equal(translation.run.requestedModelId, 'claude-sonnet-5-5');
  assert.equal(translation.run.servedModelId, 'claude-haiku-5-5');
});

test('a bad request is rejected with 400, and an old snake_case body is a bad request', async () => {
  const response = await fetch(`${server.baseUrl}/translate`, { method: 'POST', body: '{}' });
  assert.equal(response.status, 400);
  const oldBody = { source_language: 'en', target_language: 'vi', text: 'Hi', model_id: 'claude-sonnet-5-5', effort: 'low', mode: 'translate' };
  const old = await fetch(`${server.baseUrl}/translate`, { method: 'POST', body: JSON.stringify(oldBody) });
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

// ---- Runs as jobs ----

test('the first event is a snapshot of the new running row, and leaving the stream does not stop the run', async () => {
  const stream = await startTranslation(server.baseUrl, `Leave FAKE:stream=${STREAM_REPLY}`);
  const [name, snapshot] = (await stream.next())!;
  stream.close();
  assert.equal(name, 'snapshot');
  assert.equal(typeof snapshot.translation.id, 'number');
  assert.equal(snapshot.translation.run.status, 'running');
  assert.equal(snapshot.translation.sourceText, `Leave FAKE:stream=${STREAM_REPLY}`);
  assert.equal(snapshot.notice, null);
  assert.equal(typeof snapshot.elapsedMs, 'number');
  const translation = await waitForTranslation(server.baseUrl, snapshot.translation.id);
  assert.equal(translation.run.status, 'succeeded');
  assert.deepEqual(translation.blocks, [STREAM_BLOCK]);
});

test('a page that joins midway gets a snapshot, then the rest; both pages get done', async () => {
  const first = await startTranslation(server.baseUrl, `Join FAKE:stream=${STREAM_REPLY}`);
  const [, { translation: { id } }] = (await first.next())!;
  await readUntil(first, 'source_delta');
  const second = await watchRun(id);
  const [secondName, secondSnapshot] = (await second.next())!;
  const secondEvents = await second.rest();
  const firstEvents = await first.rest();
  assert.equal(secondName, 'snapshot');
  assert.notEqual(secondSnapshot.translation.blocks[0].sourceText, '');
  assert.equal(secondSnapshot.translation.run.thinkingText, 'Thinking it over.');
  assert.equal(eventNames(firstEvents).at(-1), 'done');
  assert.equal(eventNames(secondEvents).at(-1), 'done');

  // The snapshot's blocks plus the events after it are the whole reply.
  const blocks = structuredClone(secondSnapshot.translation.blocks);
  for (const [name, data] of secondEvents) {
    if (name === 'block_start') blocks[data.blockIndex] = { ...data, sourceText: '', translatedText: '' };
    else if (name === 'source_delta') blocks[data.blockIndex].sourceText += data.text;
    else if (name === 'translation_delta') blocks[data.blockIndex].translatedText += data.text;
  }
  for (const block of blocks) delete block.blockIndex;
  assert.deepEqual(blocks, [STREAM_BLOCK]);
});

test('cancel stops a run, keeps its partial blocks, and reaches every page watching it', async () => {
  const first = await startTranslation(server.baseUrl, 'Stop FAKE:stall');
  const [, { translation: { id } }] = (await first.next())!;
  await readUntil(first, 'block_start');
  const second = await watchRun(id);
  const [, secondSnapshot] = (await second.next())!;
  assert.equal(secondSnapshot.translation.blocks.length, 1);

  const cancel = await cancelRun(id);
  assert.equal(cancel.status, 204);
  const firstEvents = await first.rest();
  const secondEvents = await second.rest();
  assert.deepEqual(eventNames(firstEvents), ['cancelled']);
  assert.deepEqual(eventNames(secondEvents), ['cancelled']);
  assert.equal(firstEvents[0][1].translationId, id);
  const translation = await (await fetch(`${server.baseUrl}/history/${id}`)).json();
  assert.equal(translation.run.status, 'cancelled');
  assert.deepEqual(translation.blocks, [{ blockType: 'paragraph', level: 0, marker: null, sourceText: '', translatedText: '' }]);

  // A run that has ended, or never was, is not running.
  const again = await cancelRun(id);
  assert.equal(again.status, 409);
  assert.equal(await again.text(), 'not_running');
  const unknown = await cancelRun(999_999);
  assert.equal(unknown.status, 409);
});

test('watching a finished run or an unknown id gives one finished event', async () => {
  const events = await translate(server.baseUrl, 'Old FAKE:ok');
  const { translationId } = events.at(-1)![1];
  const finished = await (await watchRun(translationId)).rest();
  assert.deepEqual(finished, [['finished', {}]]);
  const unknown = await (await watchRun(999_999)).rest();
  assert.deepEqual(unknown, [['finished', {}]]);
  const missing = await fetch(`${server.baseUrl}/history/999999`);
  assert.equal(missing.status, 404);
});

test('a page that joins during a retry gets the retry as the notice', async () => {
  const first = await startTranslation(server.baseUrl, 'Busy FAKE:retry');
  const [, { translation: { id } }] = (await first.next())!;
  await readUntil(first, 'retry');
  const second = await watchRun(id);
  const [, snapshot] = (await second.next())!;
  assert.deepEqual(snapshot.notice, { kind: 'retry', attempt: 1, maxRetries: 3, error: 'overloaded' });
  await cancelRun(id);
  await first.rest();
  await second.rest();
});

test('a run past the limit is refused with 429, and saves no row', async () => {
  const streams = [];
  const ids: number[] = [];
  for (let runNumber = 1; runNumber <= MAX_RUNNING_TRANSLATIONS; runNumber += 1) {
    const stream = await startTranslation(server.baseUrl, `Run ${runNumber} FAKE:stall`);
    const [, snapshot] = (await stream.next())!;
    streams.push(stream);
    ids.push(snapshot.translation.id);
  }
  const countBefore = (await (await fetch(`${server.baseUrl}/history`)).json()).length;
  const body = { sourceLanguage: 'en', targetLanguage: 'vi', sourceText: 'One more FAKE:ok', modelId: 'claude-sonnet-5-5', effort: 'low', sourceFormat: 'plain_text' };
  const oneMore = await fetch(`${server.baseUrl}/translate`, { method: 'POST', body: JSON.stringify(body) });
  assert.equal(oneMore.status, 429);
  assert.ok((await oneMore.text()).startsWith(`${MAX_RUNNING_TRANSLATIONS} translations are already running.`));
  const countAfter = (await (await fetch(`${server.baseUrl}/history`)).json()).length;
  assert.equal(countAfter, countBefore);

  for (const id of ids) await cancelRun(id);
  for (const stream of streams) await stream.rest();
});

test('a run that ends with no page watching is unread until marked read; one watched to the end is not', async () => {
  const left = await startTranslation(server.baseUrl, `Away FAKE:stream=${STREAM_REPLY}`);
  const [, { translation: { id: leftId } }] = (await left.next())!;
  left.close();
  await waitForTranslation(server.baseUrl, leftId);
  const watched = await translate(server.baseUrl, 'Here FAKE:ok');
  const watchedId = watched.at(-1)![1].translationId;

  const isUnreadOf = async (id: number) => {
    const list = await (await fetch(`${server.baseUrl}/history`)).json();
    return list.find((summary: any) => summary.id === id).isUnread;
  };
  assert.equal(await isUnreadOf(leftId), true);
  assert.equal(await isUnreadOf(watchedId), false);

  const read = await fetch(`${server.baseUrl}/history/${leftId}/read`, { method: 'POST' });
  assert.equal(read.status, 204);
  assert.equal(await isUnreadOf(leftId), false);
  const unknown = await fetch(`${server.baseUrl}/history/999999/read`, { method: 'POST' });
  assert.equal(unknown.status, 404);
});

test('deleting a live run stops it and removes the row', async () => {
  const stream = await startTranslation(server.baseUrl, 'Gone FAKE:stall');
  const [, { translation: { id } }] = (await stream.next())!;
  const deleted = await fetch(`${server.baseUrl}/history/${id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 204);
  assert.deepEqual(eventNames(await stream.rest()), ['cancelled']);
  const missing = await fetch(`${server.baseUrl}/history/${id}`);
  assert.equal(missing.status, 404);
  const cancel = await cancelRun(id);
  assert.equal(cancel.status, 409);
});

test('a server killed mid-run leaves the row interrupted with its last checkpoint', { timeout: 30_000 }, async () => {
  const crashing = await startTestServer();
  // 40 words at 250 ms each stream for 10 s, past one checkpoint interval (5 s).
  const words = Array.from({ length: 40 }, (_, index) => `word${index}`).join(' ');
  const stream = await startTranslation(crashing.baseUrl, `Crash FAKE:stream=<pair type="paragraph"><source>${words}</source></pair>`);
  const [, { translation: { id } }] = (await stream.next())!;
  await new Promise((resolve) => setTimeout(resolve, 6000));
  await crashing.kill();
  stream.close();

  const restarted = await startTestServer(crashing.dataDirectory);
  try {
    const translation = await (await fetch(`${restarted.baseUrl}/history/${id}`)).json();
    assert.equal(translation.run.status, 'failed');
    assert.equal(translation.run.errorCode, 'interrupted');
    assert.equal(translation.run.thinkingText, 'Thinking it over.');
    assert.equal(translation.blocks.length, 1);
    const savedText = translation.blocks[0].sourceText;
    assert.notEqual(savedText, '');
    assert.ok(words.startsWith(savedText), `not the start of the source: ${savedText}`);
    assert.ok(savedText.length < words.length, 'the whole source was saved, not a checkpoint');
  } finally {
    await restarted.stop();
  }
});
