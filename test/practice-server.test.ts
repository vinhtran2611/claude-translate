// Practice's HTTP API through the real server (features/practice/server/routes.ts), with a fake claude.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startTestServer, type TestServer } from './server-harness.ts';

const GRADE_PROMPT = readFileSync(new URL('../features/practice/prompts/grade.md', import.meta.url), 'utf8');
const EXAMPLE_TEXT = readFileSync(new URL('../features/practice/examples/example-project.json', import.meta.url), 'utf8');

let server: TestServer;
before(async () => { server = await startTestServer(); });
after(async () => { await server.stop(); });

const call = (path: string, body?: unknown) => fetch(`${server.base_url}/api/practice${path}`, body === undefined ? {} : {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const json = async (path: string, body?: unknown) => (await call(path, body)).json() as Promise<any>;
const createProject = (file: string, extra: object = {}) => call('/projects', { file, ...extra });
// The example's exercises by file key, in a project made from it.
async function exampleProject(extra: object = {}) {
  const { id } = await (await createProject(EXAMPLE_TEXT, extra)).json();
  const detail = await json(`/projects/${id}`);
  return { id, detail, exercise: (key: string) => detail.exercises[Number(key.slice(3)) - 1].id as number };
}

async function waitForGrading(attempt_id: number): Promise<any> {
  for (let tries = 0; tries < 100; tries++) {
    const attempt = await json(`/attempts/${attempt_id}`);
    if (attempt.status !== 'grading') return attempt;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`attempt ${attempt_id} is still grading`);
}

test('the page, its modules and its stylesheet are served; the shared helpers too', async () => {
  const page = await fetch(`${server.base_url}/practice`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>Practice · Claude Translate<\/title>/);
  const css = await fetch(`${server.base_url}/practice/web/practice.css`);
  assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8');
  assert.equal((await fetch(`${server.base_url}/shared/web/ui.ts`)).status, 200);
  assert.equal((await fetch(`${server.base_url}/shared/web/base.css`)).status, 200);
  const example = await fetch(`${server.base_url}/practice/example-project.json`);
  assert.equal(example.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(JSON.parse(await example.text()).format, 2);
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

test('a file with problems creates nothing and lists every problem; a good file makes a project', async () => {
  const file = JSON.parse(EXAMPLE_TEXT);
  delete file.exercises[8].content.back;
  file.exercises[5].content.options.forEach((option: { correct?: boolean }) => delete option.correct);
  const bad = await createProject(JSON.stringify(file));
  assert.equal(bad.status, 400);
  assert.deepEqual((await bad.json()).error, {
    code: 'invalid', message: 'The request has 2 problems.', problems: [
      { path: '/file/exercises/5/content/options', code: 'no_correct_option', message: 'content.options: no option is marked correct.' },
      { path: '/file/exercises/8/content/back', code: 'required', message: 'content.back is missing.' },
    ],
  });
  assert.equal((await createProject('{ not json')).status, 400);
  assert.equal((await call('/projects', { name: 'x' })).status, 400);
  assert.deepEqual(await json('/projects'), { items: [] });
  const response = await createProject(EXAMPLE_TEXT, { name: '  My week  ', description: 'Mine' });
  assert.equal(response.status, 201);
  const { id } = await response.json();
  const { items: [project] } = await json('/projects');
  assert.deepEqual({ ...project, created_at: null, updated_at: null }, {
    id, key: 'my-week', name: 'My week', description: 'Mine', archived: false, created_at: null, updated_at: null, last_activity_at: null,
    exercise_count: 10, done_count: 0, type_counts: { rewrite: 4, write: 1, choice: 2, fill: 1, flashcard: 2 },
  });
  const detail = await json(`/projects/${id}`);
  assert.deepEqual(detail.exercises.slice(0, 2).map((exercise: any) => [exercise.kind, exercise.topic, exercise.done]), [['Rewrite sentence', 'transport', false], ['Rewrite paragraph', 'technology', false]]);
  assert.deepEqual(detail.history, []);
  assert.equal((await fetch(`${server.base_url}/api/practice/projects/9999`)).status, 404);
  assert.equal((await createProject(EXAMPLE_TEXT, { name: 'x'.repeat(81) })).status, 400);
});

test('exercises can be added to a project, but not twice', async () => {
  const { id } = await exampleProject();
  const more = JSON.stringify({ format: 2, project: { name: 'More' }, exercises: [{ id: 'extra', type: 'flashcard', content: { front: 'f', back: 'b' } }] });
  assert.deepEqual(await json(`/projects/${id}/exercises`, { file: more }), { added: 1 });
  assert.equal((await json(`/projects/${id}`)).exercises.length, 11);
  const again = await call(`/projects/${id}/exercises`, { file: more });
  assert.equal(again.status, 400);
  assert.deepEqual((await again.json()).error.problems, [{ path: '/file/exercises/0/id', code: 'duplicate_key', message: 'id "extra" is already in this project.' }]);
  assert.equal((await json(`/projects/${id}`)).exercises.length, 11);
  assert.equal((await call('/projects/9999/exercises', { file: more })).status, 404);
});

const attempt = (exercise_id: number, answer: unknown) => call('/attempts', { exercise_id, answer, writing_ms: 4200 });

// The fake claude (test/fake-claude/claude) answers with the text after FAKE:reply= in the message, or a canned reply.
const FEEDBACK = '## What is good - A clear idea. **Fix:** "for reduce" -> "to reduce".';
const CANNED_REPLY = '<pair type="paragraph">\n<source>\nHello\n</source>\n<translation>\nXin chào\n</translation>\n</pair>';

test('a flashcard is graded at once by your rating and never reaches claude', async () => {
  const { id, exercise } = await exampleProject();
  const runs_before = server.claudeRuns().length;
  const card = await json('/attempts', { exercise_id: exercise('ex-09'), answer: { rating: 'almost' }, writing_ms: 900 });
  assert.deepEqual([card.status, card.summary, card.result, card.writing_ms], ['graded', 'Almost', { rating: 'almost' }, 900]);
  assert.equal(server.claudeRuns().length, runs_before);
  const detail = await json(`/projects/${id}`);
  assert.deepEqual(detail.history.map((item: any) => [item.kind, item.summary]), [['Flashcard', 'Almost']]);
  assert.equal(detail.project.done_count, 1);
  assert.notEqual(detail.project.last_activity_at, null);
  assert.deepEqual((await json(`/attempts/${card.id}`)).snapshot, { type: 'flashcard', topic: 'IELTS vocabulary', tags: [], content: card.snapshot.content });
});

test('answers that do not fit their exercise are refused and nothing is saved', async () => {
  const { id, exercise } = await exampleProject();
  const bad: [string, unknown][] = [['ex-06', { chosen: [7] }], ['ex-06', { chosen: [0, 1] }], ['ex-08', { gaps: ['one'] }], ['ex-09', { rating: 'great' }], ['ex-01', { text: '  ' }], ['ex-01', 'text']];
  for (const [key, answer] of bad) assert.equal((await attempt(exercise(key), answer)).status, 400, key);
  assert.equal((await call('/attempts', { exercise_id: 999999, answer: { rating: 'known' } })).status, 404);
  assert.equal((await call('/attempts', { answer: { rating: 'known' } })).status, 404);
  assert.equal((await fetch(`${server.base_url}/api/practice/attempts`, { method: 'POST', body: 'nope' })).status, 400);
  assert.deepEqual((await json(`/projects/${id}`)).history, []);
  assert.equal((await fetch(`${server.base_url}/api/practice/attempts/999999`)).status, 404);
  assert.equal((await fetch(`${server.base_url}/api/practice/exercises/999999`)).status, 404);
});

const lastRun = () => server.claudeRuns().at(-1) as { args: string[]; content: string };
const argOf = (name: string) => lastRun().args[lastRun().args.indexOf(name) + 1];

test('a rewrite is saved, graded by claude with the common prompt, and the text stored as it came', async () => {
  const { id, exercise } = await exampleProject();
  const response = await attempt(exercise('ex-01'), { text: `New lanes for reduce traffic. FAKE:reply=${FEEDBACK}` });
  assert.equal(response.status, 201);
  const started = await response.json();
  assert.deepEqual([started.status, started.result, started.summary], ['grading', null, null]);
  assert.equal((await json(`/projects/${id}`)).history[0].summary, null);
  const graded = await waitForGrading(started.id);
  assert.deepEqual([graded.status, graded.summary, graded.error], ['graded', 'Graded', null]);
  assert.equal(graded.result.text, FEEDBACK);
  assert.deepEqual([graded.result.model, graded.result.effort, graded.result.thinking_text, graded.result.thinking_ms], ['claude-sonnet-5-5', 'low', '', null]);
  assert.equal(typeof graded.result.ms, 'number');
  assert.match(lastRun().content, /"type": "rewrite"/);
  assert.match(lastRun().content, /Many cities have built new cycle lanes/);
  assert.match(lastRun().content, /"reference": "New cycle lanes have been built/);
  assert.match(lastRun().content, /<answer word_count="\d+">\nNew lanes for reduce traffic\./);
  assert.equal(argOf('--model'), 'claude-sonnet-5-5');
  assert.equal(argOf('--effort'), 'low');
  assert.equal(argOf('--system-prompt'), `${GRADE_PROMPT.trim()}\n`);
  for (const section of ['<role>', '<context>', '<how_to_evaluate>', '<output_structure>']) assert.ok(argOf('--system-prompt').includes(section), section);
  assert.deepEqual((await json(`/projects/${id}`)).history.map((item: any) => [item.kind, item.summary]), [['Rewrite sentence', 'Graded']]);
  assert.equal((await json(`/projects/${id}`)).project.done_count, 1);
});

test('a writing attempt is graded with the whole exercise, and with the model and effort the person picked', async () => {
  const { exercise } = await exampleProject();
  const started = await (await call('/attempts', {
    exercise_id: exercise('ex-05'), answer: { text: 'Public transport matters. FAKE:reply=Band 6.0 overall.' }, writing_ms: 1, model_id: 'claude-haiku-5-5', effort: 'high',
  })).json();
  const graded = await waitForGrading(started.id);
  assert.equal(graded.result.text, 'Band 6.0 overall.');
  assert.deepEqual([graded.result.model, graded.result.effort], ['claude-haiku-5-5', 'high']);
  assert.equal(argOf('--model'), 'claude-haiku-5-5');
  assert.equal(argOf('--effort'), 'high');
  assert.match(lastRun().content, /"type": "write"/);
  assert.match(lastRun().content, /"min_words": 250/);
  assert.match(lastRun().content, /Some people think that governments/);
});

test('error correction sends the planted mistakes to the grader', async () => {
  const { exercise } = await exampleProject();
  const started = await (await attempt(exercise('ex-04'), { text: 'Many students prefer online classes because it save time. FAKE:reply=Two of three fixed.' })).json();
  assert.equal((await waitForGrading(started.id)).result.text, 'Two of three fixed.');
  assert.match(lastRun().content, /"wrong": "it saves"/);
  assert.match(lastRun().content, /"right": "they save"/);
});

test('a choice is graded by claude with the correct options and the reasons, and the picked options as letters', async () => {
  const { exercise } = await exampleProject();
  const started = await (await attempt(exercise('ex-06'), { chosen: [0] })).json();
  const graded = await waitForGrading(started.id);
  assert.deepEqual([graded.status, graded.summary, graded.result.text], ['graded', 'Graded', CANNED_REPLY.trim()]);
  assert.match(lastRun().content, /"type": "choice"/);
  assert.match(lastRun().content, /"correct": true/);
  assert.match(lastRun().content, /"why": "Second conditional: if \+ past simple, would \+ verb\."/);
  assert.match(lastRun().content, /<answer>\nA\. use\n<\/answer>/);
  assert.equal(argOf('--effort'), 'low');
});

test('a fill is graded by claude with the accepted answers and the typed gaps', async () => {
  const { exercise } = await exampleProject();
  const started = await (await attempt(exercise('ex-08'), { gaps: ['have rised', ''] })).json();
  assert.equal((await waitForGrading(started.id)).status, 'graded');
  assert.match(lastRun().content, /"type": "fill"/);
  assert.match(lastRun().content, /"have been rising"/);
  assert.match(lastRun().content, /<answer>\nGap 1: have rised\nGap 2: \(blank\)\n<\/answer>/);
});

test('the grading options are the ones Claude Translate offers, and an option that is not offered is refused', async () => {
  const options = await json('/grading-options');
  assert.deepEqual(options.models.map((model: any) => model.model_id), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
  assert.deepEqual(options.efforts.map((effort: any) => effort.effort), ['low', 'medium', 'high']);
  const translate_options = await (await fetch(`${server.base_url}/translation-options`)).json() as any;
  assert.deepEqual([options.default_model_id, options.default_effort], [translate_options.default_model_id, translate_options.default_effort]);
  assert.deepEqual(options.models, translate_options.models);
  const { id, exercise } = await exampleProject();
  const runs_before = server.claudeRuns().length;
  for (const settings of [{ model_id: 'gpt-5' }, { effort: 'extreme' }, { model_id: 7 }, { effort: null }]) {
    const refused = await call('/attempts', { exercise_id: exercise('ex-01'), answer: { text: 'Text.' }, writing_ms: 1, ...settings });
    assert.equal(refused.status, 400, JSON.stringify(settings));
    assert.match(await refused.text(), /must be one of/);
  }
  assert.deepEqual((await json(`/projects/${id}`)).history, []);
  const failed = await (await attempt(exercise('ex-01'), { text: 'Text. FAKE:error' })).json();
  await waitForGrading(failed.id);
  assert.equal((await call(`/attempts/${failed.id}/regrade`, { effort: 'extreme' })).status, 400);
  assert.equal((await json(`/attempts/${failed.id}`)).status, 'failed');
  assert.equal(server.claudeRuns().length, runs_before + 1);
});

// The events of a grading's stream as [name, data], read until it ends.
async function watch(attempt_id: number): Promise<[string, any][]> {
  const response = await fetch(`${server.base_url}/api/practice/attempts/${attempt_id}/stream`);
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  return (await response.text()).split('\n\n').filter((block) => block.trim() !== '').map((block) => [/^event: (.*)$/m.exec(block)![1], JSON.parse(/^data: (.*)$/m.exec(block)![1])]);
}

test('a grading streams its thinking and words, a page that joins midway gets what it missed, and the stored result matches', async () => {
  const { exercise } = await exampleProject();
  const reply = '**Close.** You wrote the main idea but one verb is wrong. ## Fix first 1. Use the passive.';
  const started = await (await attempt(exercise('ex-01'), { text: `Lanes were built. FAKE:stream=${reply}` })).json();
  // Joined before the first words: the whole thing arrives live, after an (empty or short) snapshot.
  const first = watch(started.id);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const midway = await watch(started.id).then((events) => events, () => []) as [string, any][];
  const events = await first;
  assert.equal(events[0][0], 'snapshot');
  assert.deepEqual([events[0][1].model_id, events[0][1].effort], ['claude-sonnet-5-5', 'low']);
  assert.equal(events.at(-1)![0], 'done');
  const streamed = events.filter(([name]) => name === 'text_delta').map(([, data]) => data.text).join('');
  assert.equal(events[0][1].text + streamed, reply);
  // The second watcher was a whole page reload: its snapshot already held the words so far, and it ended when the grading did.
  assert.equal(midway[0][0], 'snapshot');
  assert.ok(midway[0][1].text.length > 0 && midway[0][1].text.length < reply.length, 'the snapshot holds some of the words, not all');
  assert.equal(midway[0][1].text + midway.filter(([name]) => name === 'text_delta').map(([, data]) => data.text).join(''), reply);
  assert.equal(midway.at(-1)![0], 'done');
  assert.deepEqual(events.find(([name]) => name === 'thinking_delta')![1], { text: 'Thinking it over.' });
  const graded = await json(`/attempts/${started.id}`);
  assert.deepEqual([graded.status, graded.result.text, graded.result.thinking_text, typeof graded.result.thinking_ms], ['graded', reply, 'Thinking it over.', 'number']);
  // Once it is over there is nothing to join.
  assert.deepEqual(await watch(started.id), [['finished', {}]]);
  assert.equal((await fetch(`${server.base_url}/api/practice/attempts/999999/stream`)).status, 404);
});

test('a grading goes on and is saved when nobody is watching, and a failure reaches the watcher and the attempt', async () => {
  const { exercise } = await exampleProject();
  const started = await (await attempt(exercise('ex-01'), { text: 'Text. FAKE:stream=One two three four.' })).json();
  const response = await fetch(`${server.base_url}/api/practice/attempts/${started.id}/stream`);
  await response.body!.cancel();
  assert.equal((await waitForGrading(started.id)).result.text, 'One two three four.');
  const crash = await (await attempt(exercise('ex-01'), { text: 'Text. FAKE:error' })).json();
  const events = await watch(crash.id);
  assert.ok(['error', 'finished'].includes(events.at(-1)![0]));
  const failed = await waitForGrading(crash.id);
  assert.equal(failed.status, 'failed');
  if (events.at(-1)![0] === 'error') assert.equal(events.at(-1)![1].message, failed.error);
});

test('a failed run fails the attempt with its error, and Grade again redoes it', async () => {
  const { exercise } = await exampleProject();
  const crash = await (await attempt(exercise('ex-01'), { text: 'Text. FAKE:error' })).json();
  const failed = await waitForGrading(crash.id);
  assert.deepEqual([failed.status, failed.result, failed.summary], ['failed', null, null]);
  assert.match(failed.error, /\S/);
  assert.equal((await call(`/attempts/${crash.id}/regrade`, {})).status, 202);
  assert.equal((await waitForGrading(crash.id)).status, 'failed');
  assert.equal((await call('/attempts/999999/regrade', {})).status, 404);
  const ok = await (await attempt(exercise('ex-01'), { text: 'Text. FAKE:reply=Fine.' })).json();
  await waitForGrading(ok.id);
  assert.equal((await call(`/attempts/${ok.id}/regrade`, {})).status, 409);
});

test('one malformed row never breaks the lists, and an attempt keeps its exercise after the exercise changes', async () => {
  const { id, detail, exercise } = await exampleProject();
  const card = await (await attempt(exercise('ex-10'), { rating: 'known' })).json();
  const database = new DatabaseSync(join(server.data_directory, 'practice-v2.sqlite'));
  database.prepare("UPDATE exercises SET content_json = 'null' WHERE id = ?").run(detail.exercises[0].id);
  database.prepare("UPDATE exercises SET content_json = '{\"front\":\"changed\",\"back\":\"b\"}' WHERE id = ?").run(exercise('ex-10'));
  database.close();
  const after_change = await json(`/projects/${id}`);
  assert.deepEqual([after_change.exercises[0].preview, after_change.exercises[9].preview, after_change.history[0].preview], ['', 'changed', 'resilient']);
  assert.equal((await json(`/attempts/${card.id}`)).snapshot.content.front, 'resilient');
});

test('every API error has the one shape: bad JSON, too large, invalid, not found, wrong method, unknown path', async () => {
  const raw = (path: string, init: RequestInit = {}) => fetch(`${server.base_url}/api/practice${path}`, init);
  const errorOf = async (response: Response) => [response.status, response.headers.get('content-type'), (await response.json()).error];
  const bad_json = await errorOf(await raw('/attempts', { method: 'POST', body: '{\n  "answer": oops\n}' }));
  assert.deepEqual(bad_json.slice(0, 2), [400, 'application/json; charset=utf-8']);
  assert.equal(bad_json[2].code, 'bad_json');
  assert.match(bad_json[2].message, /line 2, column 13/);
  const too_large = await errorOf(await raw('/attempts', { method: 'POST', body: JSON.stringify({ answer: { text: 'x'.repeat(300_000) } }) }));
  assert.deepEqual([too_large[0], too_large[2].code], [413, 'too_large']);
  assert.deepEqual(await errorOf(await raw('/attempts', { method: 'POST', body: '[]' })), [400, 'application/json; charset=utf-8', {
    code: 'invalid', message: 'The request has 1 problem.', problems: [{ path: '', code: 'wrong_type', message: 'The body must be a JSON object.' }],
  }]);
  assert.deepEqual(await errorOf(await raw('/attempts/999999')), [404, 'application/json; charset=utf-8', { code: 'not_found', message: 'No such attempt.' }]);
  const wrong_method = await raw('/grading-options', { method: 'PUT' });
  assert.equal(wrong_method.headers.get('allow'), 'GET');
  assert.deepEqual((await errorOf(wrong_method)).slice(0, 1), [405]);
  assert.equal((await raw('/attempts/1/regrade')).status, 405);
  assert.deepEqual(await errorOf(await raw('/nothing/here')), [404, 'application/json; charset=utf-8', { code: 'not_found', message: 'Nothing at /api/practice/nothing/here.' }]);
  // Outside the API a 404 stays bare.
  assert.equal((await fetch(`${server.base_url}/nothing`)).headers.get('content-type'), null);
});
