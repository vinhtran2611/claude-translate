// Making a project from a translation through the real server (docs/practice-from-translation-design.md §5 and §6), with
// the fake claude as the model: the request check, a good and a bad reply, the stream, the 409s and Try again.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, type TestServer } from '../helpers/server-harness.ts';

let server: TestServer;
before(async () => { server = await startTestServer(); });
after(async () => { await server.stop(); });

// ---- Helpers ----

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  return fetch(`${server.baseUrl}/api/practice${path}`, init);
}

async function get(path: string): Promise<any> {
  const response = await call('GET', path);
  assert.equal(response.status, 200, `GET ${path}`);
  return response.json();
}

// The events of a generation's stream as [name, data], read until it ends.
async function watch(generationId: number): Promise<[string, any][]> {
  const response = await fetch(`${server.baseUrl}/api/practice/generations/${generationId}/stream`);
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const blocks = (await response.text()).split('\n\n').filter((block) => block.trim() !== '');
  return blocks.map((block) => {
    const name = /^event: (.*)$/m.exec(block)![1];
    const data = JSON.parse(/^data: (.*)$/m.exec(block)![1]);
    return [name, data];
  });
}

async function waitForGeneration(generationId: number): Promise<any> {
  for (let tries = 0; tries < 100; tries++) {
    const generation = await get(`/generations/${generationId}`);
    if (generation.run.status !== 'running') return generation;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`generation ${generationId} did not finish`);
}

const choice = (key: string, kind: string, right: string, wrong: string[]) => ({
  key,
  tags: [kind, `${kind}:x`],
  content: {
    type: 'choice',
    question: 'Pick ____.',
    options: [
      { text: right, isCorrect: true, explanationMarkdown: 'Right (đúng).' },
      ...wrong.map((text) => ({ text, isCorrect: false, explanationMarkdown: 'Wrong.' })),
    ],
  },
});
const card = (key: string) => ({ key, tags: ['vocab', 'vocab:collocation'], content: { type: 'flashcard', front: key, back: 'thẻ: a card' } });

// A good reply for a plan of 10: 4 flashcards, 2 vocab, 2 grammar, 2 meaning. One line, with few spaces, so the fake claude
// can stream it.
const GOOD_REPLY = JSON.stringify({
  name: 'Made from a post',
  topic: 'tech',
  exercises: [
    card('fc-1'), card('fc-2'), card('fc-3'), card('fc-4'),
    choice('vo-1', 'vocab', 'a', ['b', 'c', 'd']), choice('vo-2', 'vocab', 'a', ['b', 'c', 'd']),
    choice('gr-1', 'grammar', 'a', ['b', 'c', 'd']), choice('gr-2', 'grammar', 'a', ['b', 'c', 'd']),
    choice('me-1', 'meaning', 'a', ['b', 'c', 'd']), choice('me-2', 'meaning', 'a', ['b', 'c', 'd']),
  ],
});

// A request for translation translationId whose post holds 200 English words and the fake claude's scenario on a line of
// its own.
function requestOf(translationId: number, scenario: string) {
  const words = 'word '.repeat(200).trim();
  return {
    translationId,
    title: 'A post',
    sourceLanguage: 'en',
    blocks: [
      { sourceText: 'A post', translatedText: 'Một bài viết' },
      { sourceText: `${words}\n${scenario}\n`, translatedText: 'Các từ.' },
    ],
  };
}

async function startGeneration(translationId: number, scenario: string): Promise<any> {
  const response = await call('POST', '/generations', requestOf(translationId, scenario));
  assert.equal(response.status, 202);
  const { generation } = await response.json();
  return generation;
}

// ---- Tests ----

test('a generation request is checked: English only, a post long enough, the known fields', async () => {
  const cases: [object, string][] = [
    [{ ...requestOf(1, ''), sourceLanguage: 'vi' }, '/sourceLanguage'],
    [{ ...requestOf(1, ''), blocks: [] }, '/blocks'],
    [{ ...requestOf(1, ''), blocks: [{ sourceText: 'Too short.', translatedText: 'Quá ngắn.' }] }, '/blocks'],
    [{ ...requestOf(1, ''), blocks: [{ sourceText: '', translatedText: 'x' }] }, '/blocks/0/sourceText'],
    [{ ...requestOf(1, ''), translationId: undefined }, '/translationId'],
    [{ ...requestOf(1, ''), extra: true }, '/extra'],
  ];
  for (const [body, path] of cases) {
    const response = await call('POST', '/generations', body);
    assert.equal(response.status, 400, path);
    const { error } = await response.json();
    assert.equal(error.code, 'invalid');
    assert.equal(error.problems[0].path, path);
  }
  const short = await (await call('POST', '/generations', cases[2][0])).json();
  assert.match(short.error.problems[0].message, /has 2 English words; at least 150/);
});

test('a good reply becomes a project; the translation is then made, and the run is listed', async () => {
  const generation = await startGeneration(101, `FAKE:reply=${GOOD_REPLY}`);
  assert.equal(generation.run.status, 'running');
  assert.equal(generation.targetCount, 10);
  assert.equal(generation.run.requestedModelId, 'claude-opus-5-5');
  assert.equal(generation.run.effort, 'medium');
  const finished = await waitForGeneration(generation.id);
  assert.equal(finished.run.status, 'succeeded');
  assert.equal(finished.projectKey, 't-101-made-from-a-post');
  assert.equal(finished.droppedCount, 0);
  assert.equal(finished.postJson, undefined);

  const project = await get('/projects/t-101-made-from-a-post');
  assert.equal(project.name, 'Made from a post');
  assert.equal(project.exerciseCount, 10);
  assert.match(project.description, /^Made from translation 101: "A post"\. 10 flashcards/);
  const exercise = await get('/projects/t-101-made-from-a-post/exercises/fc-1');
  assert.equal(exercise.topic, 'tech');

  const again = await call('POST', '/generations', requestOf(101, `FAKE:reply=${GOOD_REPLY}`));
  assert.equal(again.status, 409);
  assert.deepEqual((await again.json()).error, {
    code: 'already_made', message: 'This translation already made project "t-101-made-from-a-post".', projectKey: 't-101-made-from-a-post',
  });
  const { items } = await get('/generations?translation=101');
  assert.deepEqual(items.map((item: any) => item.id), [generation.id]);
  assert.equal((await call('GET', '/generations')).status, 400);

  // The project deleted, the post can make one again (Make again).
  assert.equal((await call('DELETE', '/projects/t-101-made-from-a-post')).status, 204);
  assert.equal((await get(`/generations/${generation.id}`)).projectKey, null);
  const remade = await call('POST', `/generations/${generation.id}/retry`);
  assert.equal(remade.status, 202);
  const { generation: second } = await remade.json();
  assert.equal((await waitForGeneration(second.id)).projectKey, 't-101-made-from-a-post');
});

test('a reply that is not the JSON asked for fails with invalid_reply; Try again starts a new run from the same post', async () => {
  const generation = await startGeneration(102, 'FAKE:reply=Here are your exercises.');
  const failed = await waitForGeneration(generation.id);
  assert.equal(failed.run.status, 'failed');
  assert.equal(failed.run.errorCode, 'invalid_reply');
  assert.equal(failed.run.errorMessage, 'The reply is not a JSON object with name, topic and exercises.');
  assert.equal(failed.projectKey, null);

  const retried = await call('POST', `/generations/${generation.id}/retry`);
  assert.equal(retried.status, 202);
  const { generation: second } = await retried.json();
  assert.notEqual(second.id, generation.id);
  assert.equal(second.translationId, 102);
  assert.equal((await waitForGeneration(second.id)).run.errorCode, 'invalid_reply');
  assert.equal((await call('POST', '/generations/999999/retry')).status, 404);
});

test('a CLI error fails the run with its code', async () => {
  const generation = await startGeneration(103, 'FAKE:error');
  const failed = await waitForGeneration(generation.id);
  assert.equal(failed.run.errorCode, 'claude_error');
  assert.equal(failed.run.errorMessage, 'Fake API error');
});

test('a page watching a run gets a snapshot, the progress and the project; a second request opens the same run', async () => {
  // The fake claude streams the reply word by word, 250ms apart: its few spaces make a few parts.
  const generation = await startGeneration(104, `FAKE:stream=${GOOD_REPLY}`);
  const second = await call('POST', '/generations', requestOf(104, 'FAKE:error'));
  assert.equal(second.status, 409);
  const { error } = await second.json();
  assert.equal(error.code, 'generating');
  assert.equal(error.generationId, generation.id);

  const events = await watch(generation.id);
  const names = events.map(([name]) => name);
  assert.equal(names[0], 'snapshot');
  assert.equal(events[0][1].targetCount, 10);
  assert.equal(events[0][1].modelId, 'claude-opus-5-5');
  assert.ok(names.includes('progress'));
  const counts = events.filter(([name]) => name === 'progress').map(([, data]) => data.exerciseCount);
  assert.deepEqual(counts, [...counts].sort((first, second) => first - second));
  assert.deepEqual(events.at(-1), ['done', { projectKey: 't-104-made-from-a-post' }]);
  // Once it has ended, the stream says so at once.
  assert.deepEqual(await watch(generation.id), [['finished', {}]]);
  assert.equal((await fetch(`${server.baseUrl}/api/practice/generations/999999/stream`)).status, 404);
});
