// Practice through the real server (features/practice/server/routes.ts), with a fake claude: the page and its files,
// grading, the grading stream and errors. The key-addressed resources themselves are in practice-api.test.ts.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startTestServer, type TestServer } from './server-harness.ts';

const GRADE_PROMPT = readFileSync(new URL('../features/practice/prompts/grade.md', import.meta.url), 'utf8');
const EXAMPLE = JSON.parse(readFileSync(new URL('../features/practice/examples/example-project.json', import.meta.url), 'utf8'));

let server: TestServer;
before(async () => { server = await startTestServer(); });
after(async () => { await server.stop(); });

// ---- Helpers ----

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  return fetch(`${server.base_url}/api/practice${path}`, init);
}

async function get(path: string): Promise<any> {
  const response = await call('GET', path);
  assert.equal(response.status, 200, `GET ${path}`);
  return response.json();
}

// Imports the example file as a new project, and returns its key.
let project_count = 0;
async function exampleProject(): Promise<string> {
  project_count++;
  const key = `example-${project_count}`;
  const response = await call('POST', '/import', { ...EXAMPLE, project: { ...EXAMPLE.project, key } });
  assert.equal(response.status, 200);
  return key;
}

// Answers one exercise of the example (ex-01 ... ex-10) and returns the response.
function answer(project: string, exercise: string, body: object): Promise<Response> {
  return call('POST', `/projects/${project}/exercises/${exercise}/attempts`, body);
}

async function answerAndRead(project: string, exercise: string, body: object): Promise<any> {
  const response = await answer(project, exercise, body);
  assert.equal(response.status, 201);
  return response.json();
}

async function waitForGrading(attempt_id: number): Promise<any> {
  for (let tries = 0; tries < 100; tries++) {
    const attempt = await get(`/attempts/${attempt_id}`);
    if (attempt.status !== 'grading') return attempt;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`attempt ${attempt_id} is still grading`);
}

// The last run the fake claude saw, and one of its arguments.
function lastRun(): { args: string[]; content: string } {
  return server.claudeRuns().at(-1) as { args: string[]; content: string };
}

function argOf(name: string): string {
  const { args } = lastRun();
  return args[args.indexOf(name) + 1];
}

// The fake claude (test/fake-claude/claude) answers with the text after FAKE:reply= in the message, or a canned reply.
const FEEDBACK = '## What is good - A clear idea. **Fix:** "for reduce" -> "to reduce".';
const CANNED_REPLY = '<pair type="paragraph">\n<source>\nHello\n</source>\n<translation>\nXin chào\n</translation>\n</pair>';

// ---- The page ----

test('the page, its modules and its stylesheet are served; the shared helpers too', async () => {
  const page = await fetch(`${server.base_url}/practice`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>Practice · Claude Translate<\/title>/);

  const css = await fetch(`${server.base_url}/practice/web/practice.css`);
  assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8');
  assert.equal((await fetch(`${server.base_url}/shared/web/ui.ts`)).status, 200);
  // A module in a folder under shared/web/ is served too: markdown.ts imports its parts from markdown/.
  assert.equal((await fetch(`${server.base_url}/shared/web/markdown/inline.ts`)).status, 200);
  assert.equal((await fetch(`${server.base_url}/shared/web/base.css`)).status, 200);

  const example = await fetch(`${server.base_url}/practice/example-project.json`);
  assert.equal(example.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(JSON.parse(await example.text()).format, 3);
  assert.equal((await fetch(`${server.base_url}/practice/format-guide.md`)).status, 200);

  assert.equal((await fetch(`${server.base_url}/practice/web/../../server/server.ts`)).status, 404);
  assert.equal((await fetch(`${server.base_url}/practice/server/store.ts`)).status, 404);
});

test('every module the page loads, however deep, is served as JavaScript without types', async () => {
  const seen = new Set<string>();
  const pending = [`${server.base_url}/practice/web/practice.ts`];
  while (pending.length > 0) {
    const url = pending.pop() as string;
    if (seen.has(url)) continue;
    seen.add(url);
    const response = await fetch(url);
    assert.equal(response.status, 200, url);
    assert.equal(response.headers.get('content-type'), 'text/javascript; charset=utf-8', url);
    const source = await response.text();
    assert.doesNotMatch(source, /import type|^\s*(export )?(enum|namespace) /m, url);
    for (const [, import_path] of source.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g)) pending.push(new URL(import_path, url).href);
  }
  for (const name of ['practice/web/exercise.ts', 'practice/web/templates/index.ts', 'practice/import-check.ts', 'practice/text.ts', 'shared/web/ui.ts']) {
    assert.ok(seen.has(`${server.base_url}/${name}`), name);
  }
});

test('the translate page links to Practice and keeps its title', async () => {
  const page = await (await fetch(`${server.base_url}/`)).text();
  assert.match(page, /<title>Claude Translate<\/title>/);
  assert.match(page, /href="\/practice"/);
});

test('the example file imports as a project with every type', async () => {
  const key = await exampleProject();
  const project = await get(`/projects/${key}`);
  assert.equal(project.name, 'IELTS Writing Task 2 – Example');
  assert.equal(project.exercise_count, 10);
  assert.deepEqual(project.type_counts, { rewrite: 4, write: 1, choice: 2, fill: 1, flashcard: 2 });

  const { items } = await get(`/projects/${key}/exercises`);
  assert.equal(items[0].kind, 'Rewrite sentence');
  assert.equal(items[0].topic, 'transport');
  assert.equal(items[1].kind, 'Rewrite paragraph');
});

// ---- Grading ----

test('a flashcard is graded at once by your rating and never reaches claude', async () => {
  const key = await exampleProject();
  const runs_before = server.claudeRuns().length;
  const card = await answerAndRead(key, 'ex-09', { answer: { rating: 'almost' }, writing_ms: 900 });
  assert.equal(card.status, 'graded');
  assert.equal(card.summary, 'Almost');
  assert.deepEqual(card.result, { rating: 'almost' });
  assert.equal(card.writing_ms, 900);
  assert.equal(server.claudeRuns().length, runs_before);

  const project = await get(`/projects/${key}`);
  assert.equal(project.done_count, 1);
  assert.notEqual(project.last_activity_at, null);

  const stored = await get(`/attempts/${card.id}`);
  assert.equal(stored.snapshot.type, 'flashcard');
  assert.equal(stored.snapshot.topic, 'IELTS vocabulary');
});

test('answers that do not fit their exercise are refused and nothing is saved', async () => {
  const key = await exampleProject();
  const bad_answers: [string, unknown][] = [
    ['ex-06', { chosen: [7] }],
    ['ex-06', { chosen: [0, 1] }],
    ['ex-08', { gaps: ['one'] }],
    ['ex-09', { rating: 'great' }],
    ['ex-01', { text: '  ' }],
    ['ex-01', 'text'],
  ];
  for (const [exercise, bad_answer] of bad_answers) {
    const response = await answer(key, exercise, { answer: bad_answer });
    assert.equal(response.status, 400, `${exercise} ${JSON.stringify(bad_answer)}`);
  }
  const missing = await answer(key, 'ex-01', {});
  assert.equal(missing.status, 400);

  const attempts = await get(`/attempts?project=${key}`);
  assert.equal(attempts.items.length, 0);
});

test('a rewrite is saved, graded by claude with the common prompt, and the text stored as it came', async () => {
  const key = await exampleProject();
  const started = await answerAndRead(key, 'ex-01', { answer: { text: `New lanes for reduce traffic. FAKE:reply=${FEEDBACK}` } });
  assert.equal(started.status, 'grading');
  assert.equal(started.result, null);
  assert.equal(started.summary, null);

  const graded = await waitForGrading(started.id);
  assert.equal(graded.status, 'graded');
  assert.equal(graded.summary, 'Graded');
  assert.equal(graded.error, null);
  assert.equal(graded.result.text, FEEDBACK);
  assert.equal(graded.result.model, 'claude-sonnet-5-5');
  assert.equal(graded.result.effort, 'low');
  assert.equal(graded.result.thinking_text, '');
  assert.equal(graded.result.thinking_ms, null);
  assert.equal(typeof graded.result.ms, 'number');

  assert.match(lastRun().content, /"type": "rewrite"/);
  assert.match(lastRun().content, /Many cities have built new cycle lanes/);
  assert.match(lastRun().content, /"reference": "New cycle lanes have been built/);
  assert.match(lastRun().content, /<answer word_count="\d+">\nNew lanes for reduce traffic\./);
  assert.equal(argOf('--model'), 'claude-sonnet-5-5');
  assert.equal(argOf('--effort'), 'low');
  assert.equal(argOf('--system-prompt'), `${GRADE_PROMPT.trim()}\n`);
  for (const section of ['<role>', '<context>', '<how_to_evaluate>', '<output_structure>']) {
    assert.ok(argOf('--system-prompt').includes(section), section);
  }

  const { items } = await get(`/projects/${key}/exercises`);
  assert.equal(items[0].last_attempt.summary, 'Graded');
  assert.equal((await get(`/projects/${key}`)).done_count, 1);
});

test('a writing attempt is graded with the whole exercise, and with the model and effort the person picked', async () => {
  const key = await exampleProject();
  const body = { answer: { text: 'Public transport matters. FAKE:reply=Band 6.0 overall.' }, writing_ms: 1, model_id: 'claude-haiku-5-5', effort: 'high' };
  const started = await answerAndRead(key, 'ex-05', body);
  const graded = await waitForGrading(started.id);
  assert.equal(graded.result.text, 'Band 6.0 overall.');
  assert.equal(graded.result.model, 'claude-haiku-5-5');
  assert.equal(graded.result.effort, 'high');
  assert.equal(argOf('--model'), 'claude-haiku-5-5');
  assert.equal(argOf('--effort'), 'high');
  assert.match(lastRun().content, /"type": "write"/);
  assert.match(lastRun().content, /"min_words": 250/);
  assert.match(lastRun().content, /Some people think that governments/);
});

test('error correction sends the planted mistakes to the grader', async () => {
  const key = await exampleProject();
  const started = await answerAndRead(key, 'ex-04', { answer: { text: 'Many students prefer online classes because it save time. FAKE:reply=Two of three fixed.' } });
  assert.equal((await waitForGrading(started.id)).result.text, 'Two of three fixed.');
  assert.match(lastRun().content, /"wrong": "it saves"/);
  assert.match(lastRun().content, /"right": "they save"/);
});

test('a choice is graded by claude with the correct options and the reasons, and the picked options as letters', async () => {
  const key = await exampleProject();
  const started = await answerAndRead(key, 'ex-06', { answer: { chosen: [0] } });
  const graded = await waitForGrading(started.id);
  assert.equal(graded.status, 'graded');
  assert.equal(graded.result.text, CANNED_REPLY.trim());
  assert.match(lastRun().content, /"type": "choice"/);
  assert.match(lastRun().content, /"correct": true/);
  assert.match(lastRun().content, /"why": "Second conditional: if \+ past simple, would \+ verb\."/);
  assert.match(lastRun().content, /<answer>\nA\. use\n<\/answer>/);
});

test('a fill is graded by claude with the accepted answers and the typed gaps', async () => {
  const key = await exampleProject();
  const started = await answerAndRead(key, 'ex-08', { answer: { gaps: ['have rised', ''] } });
  assert.equal((await waitForGrading(started.id)).status, 'graded');
  assert.match(lastRun().content, /"type": "fill"/);
  assert.match(lastRun().content, /"have been rising"/);
  assert.match(lastRun().content, /<answer>\nGap 1: have rised\nGap 2: \(blank\)\n<\/answer>/);
});

test('the grading options are the ones Claude Translate offers', async () => {
  const options = await get('/grading-options');
  assert.deepEqual(options.models.map((model: any) => model.model_id), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
  assert.deepEqual(options.efforts.map((effort: any) => effort.effort), ['low', 'medium', 'high']);

  const translate_options = await (await fetch(`${server.base_url}/translation-options`)).json() as any;
  assert.equal(options.default_model_id, translate_options.default_model_id);
  assert.equal(options.default_effort, translate_options.default_effort);
  assert.deepEqual(options.models, translate_options.models);
});

test('a model or effort that is not offered is refused, for an answer and for Grade again', async () => {
  const key = await exampleProject();
  const runs_before = server.claudeRuns().length;
  for (const settings of [{ model_id: 'gpt-5' }, { effort: 'extreme' }, { model_id: 7 }, { effort: null }]) {
    const refused = await answer(key, 'ex-01', { answer: { text: 'Text.' }, ...settings });
    assert.equal(refused.status, 400, JSON.stringify(settings));
    assert.match(await refused.text(), /must be one of/);
  }
  assert.equal((await get(`/attempts?project=${key}`)).items.length, 0);

  const failed = await answerAndRead(key, 'ex-01', { answer: { text: 'Text. FAKE:error' } });
  await waitForGrading(failed.id);
  const regrade = await call('POST', `/attempts/${failed.id}/regrade`, { effort: 'extreme' });
  assert.equal(regrade.status, 400);
  assert.equal((await get(`/attempts/${failed.id}`)).status, 'failed');
  assert.equal(server.claudeRuns().length, runs_before + 1);
});

// ---- The grading stream ----

// The events of a grading's stream as [name, data], read until it ends.
async function watch(attempt_id: number): Promise<[string, any][]> {
  const response = await fetch(`${server.base_url}/api/practice/attempts/${attempt_id}/stream`);
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const blocks = (await response.text()).split('\n\n').filter((block) => block.trim() !== '');
  return blocks.map((block) => {
    const name = /^event: (.*)$/m.exec(block)![1];
    const data = JSON.parse(/^data: (.*)$/m.exec(block)![1]);
    return [name, data];
  });
}

function streamedText(events: [string, any][]): string {
  return events.filter(([name]) => name === 'text_delta').map(([, data]) => data.text).join('');
}

test('a grading streams its thinking and words, a page that joins midway gets what it missed, and the stored result matches', async () => {
  const key = await exampleProject();
  const reply = '**Close.** You wrote the main idea but one verb is wrong. ## Fix first 1. Use the passive.';
  const started = await answerAndRead(key, 'ex-01', { answer: { text: `Lanes were built. FAKE:stream=${reply}` } });

  // Joined before the first words: the whole thing arrives live, after an (empty or short) snapshot.
  const first = watch(started.id);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const midway = await watch(started.id).catch(() => [] as [string, any][]);
  const events = await first;

  const [snapshot_name, snapshot] = events[0];
  assert.equal(snapshot_name, 'snapshot');
  assert.equal(snapshot.model_id, 'claude-sonnet-5-5');
  assert.equal(snapshot.effort, 'low');
  assert.equal(events.at(-1)![0], 'done');
  assert.equal(snapshot.text + streamedText(events), reply);

  // The second watcher was a whole page reload: its snapshot already held the words so far, and it ended when the grading did.
  const [midway_name, midway_snapshot] = midway[0];
  assert.equal(midway_name, 'snapshot');
  assert.ok(midway_snapshot.text.length > 0, 'the snapshot holds some of the words');
  assert.ok(midway_snapshot.text.length < reply.length, 'the snapshot does not hold all of the words');
  assert.equal(midway_snapshot.text + streamedText(midway), reply);
  assert.equal(midway.at(-1)![0], 'done');

  const thinking = events.find(([name]) => name === 'thinking_delta')!;
  assert.deepEqual(thinking[1], { text: 'Thinking it over.' });

  const graded = await get(`/attempts/${started.id}`);
  assert.equal(graded.status, 'graded');
  assert.equal(graded.result.text, reply);
  assert.equal(graded.result.thinking_text, 'Thinking it over.');
  assert.equal(typeof graded.result.thinking_ms, 'number');

  // Once it is over there is nothing to join.
  assert.deepEqual(await watch(started.id), [['finished', {}]]);
  assert.equal((await fetch(`${server.base_url}/api/practice/attempts/999999/stream`)).status, 404);
});

test('a grading goes on and is saved when nobody is watching, and a failure reaches the watcher and the attempt', async () => {
  const key = await exampleProject();
  const started = await answerAndRead(key, 'ex-01', { answer: { text: 'Text. FAKE:stream=One two three four.' } });
  const response = await fetch(`${server.base_url}/api/practice/attempts/${started.id}/stream`);
  await response.body!.cancel();
  assert.equal((await waitForGrading(started.id)).result.text, 'One two three four.');

  const crash = await answerAndRead(key, 'ex-01', { answer: { text: 'Text. FAKE:error' } });
  const events = await watch(crash.id);
  const [last_name, last_data] = events.at(-1)!;
  assert.ok(['error', 'finished'].includes(last_name));
  const failed = await waitForGrading(crash.id);
  assert.equal(failed.status, 'failed');
  if (last_name === 'error') assert.equal(last_data.message, failed.error);
});

test('a failed run fails the attempt with its error, and Grade again redoes it', async () => {
  const key = await exampleProject();
  const crash = await answerAndRead(key, 'ex-01', { answer: { text: 'Text. FAKE:error' } });
  const failed = await waitForGrading(crash.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.result, null);
  assert.equal(failed.summary, null);
  assert.match(failed.error, /\S/);

  const regrade = await call('POST', `/attempts/${crash.id}/regrade`, {});
  assert.equal(regrade.status, 202);
  assert.equal((await waitForGrading(crash.id)).status, 'failed');
  assert.equal((await call('POST', '/attempts/999999/regrade', {})).status, 404);

  const ok = await answerAndRead(key, 'ex-01', { answer: { text: 'Text. FAKE:reply=Fine.' } });
  await waitForGrading(ok.id);
  const not_failed = await call('POST', `/attempts/${ok.id}/regrade`, {});
  assert.equal(not_failed.status, 409);
  assert.equal((await not_failed.json()).error.code, 'not_failed');
});

// ---- Robustness ----

test('one malformed row never breaks the lists, and an attempt keeps its exercise after the exercise changes', async () => {
  const key = await exampleProject();
  const card = await answerAndRead(key, 'ex-10', { answer: { rating: 'known' } });

  const database = new DatabaseSync(join(server.data_directory, 'practice-v2.sqlite'));
  const project_id = (await get(`/projects/${key}`)).id;
  database.prepare("UPDATE exercises SET content_json = 'null' WHERE project_id = ? AND key = 'ex-01'").run(project_id);
  database.prepare("UPDATE exercises SET content_json = '{\"front\":\"changed\",\"back\":\"b\"}' WHERE project_id = ? AND key = 'ex-10'").run(project_id);
  database.close();

  const { items } = await get(`/projects/${key}/exercises`);
  assert.equal(items[0].preview, '');
  assert.equal(items[9].preview, 'changed');
  assert.equal((await get(`/attempts/${card.id}`)).snapshot.content.front, 'resilient');
});

test('every API error has the one shape: bad JSON, too large, invalid, not found, wrong method, unknown path', async () => {
  const key = await exampleProject();
  const attempts_path = `/projects/${key}/exercises/ex-01/attempts`;

  const bad_json = await call('POST', attempts_path, '{\n  "answer": oops\n}');
  assert.equal(bad_json.status, 400);
  assert.equal(bad_json.headers.get('content-type'), 'application/json; charset=utf-8');
  const bad_json_error = (await bad_json.json()).error;
  assert.equal(bad_json_error.code, 'bad_json');
  assert.match(bad_json_error.message, /line 2, column 13/);

  const too_large = await call('POST', attempts_path, { answer: { text: 'x'.repeat(300_000) } });
  assert.equal(too_large.status, 413);
  assert.equal((await too_large.json()).error.code, 'too_large');

  const not_object = await call('POST', attempts_path, '[]');
  assert.deepEqual(await not_object.json(), {
    error: { code: 'invalid', message: 'The request has 1 problem.', problems: [{ path: '', code: 'wrong_type', message: 'The body must be a JSON object.' }] },
  });

  const missing = await call('GET', '/attempts/999999');
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: { code: 'not_found', message: 'No such attempt.' } });

  const wrong_method = await call('PUT', '/grading-options');
  assert.equal(wrong_method.status, 405);
  assert.equal(wrong_method.headers.get('allow'), 'GET');
  assert.equal((await call('GET', '/attempts/1/regrade')).status, 405);

  const unknown_path = await call('GET', '/nothing/here');
  assert.equal(unknown_path.status, 404);
  assert.deepEqual(await unknown_path.json(), { error: { code: 'not_found', message: 'Nothing at /api/practice/nothing/here.' } });

  // Outside the API a 404 stays bare.
  assert.equal((await fetch(`${server.base_url}/nothing`)).headers.get('content-type'), null);
});

test('the first API is gone', async () => {
  assert.equal((await call('POST', '/projects', { file: '{}' })).status, 405);
  assert.equal((await call('POST', '/attempts', { exercise_id: 1, answer: {} })).status, 405);
  assert.equal((await call('GET', '/exercises/1')).status, 404);
});
