// Practice through the real server (src/features/practice/server/routes.ts), with a fake claude: the page and its files,
// grading, the grading stream and errors. The key-addressed resources themselves are in practice-api.test.ts.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startTestServer, type TestServer } from '../helpers/server-harness.ts';

const GRADE_PROMPT = readFileSync(new URL('../../src/features/practice/prompts/grade.md', import.meta.url), 'utf8');
const EXAMPLE = JSON.parse(readFileSync(new URL('../../src/features/practice/static/example-project.json', import.meta.url), 'utf8'));

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
  return fetch(`${server.baseUrl}/api/practice${path}`, init);
}

async function get(path: string): Promise<any> {
  const response = await call('GET', path);
  assert.equal(response.status, 200, `GET ${path}`);
  return response.json();
}

// Imports the example file as a new project, and returns its key.
let projectCount = 0;
async function exampleProject(): Promise<string> {
  projectCount++;
  const key = `example-${projectCount}`;
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

// The latest grading of an attempt: the one the page shows (rule 7).
function latestOf(attempt: any): any {
  return attempt.gradings.at(-1);
}

async function waitForGrading(attemptId: number): Promise<any> {
  for (let tries = 0; tries < 100; tries++) {
    const attempt = await get(`/attempts/${attemptId}`);
    if (latestOf(attempt).run.status !== 'running') return attempt;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`attempt ${attemptId} is still grading`);
}

// The last run the fake claude saw, and one of its arguments.
function lastRun(): { args: string[]; content: string } {
  return server.claudeRuns().at(-1) as { args: string[]; content: string };
}

function argOf(name: string): string {
  const { args } = lastRun();
  return args[args.indexOf(name) + 1];
}

// The fake claude (test/helpers/fake-claude/claude) answers with the text after FAKE:reply= in the message, or a canned reply.
const FEEDBACK = '## What is good - A clear idea. **Fix:** "for reduce" -> "to reduce".';
const CANNED_REPLY = '<pair type="paragraph">\n<source>\nHello\n</source>\n<translation>\nXin chào\n</translation>\n</pair>';

// ---- The page ----

test('the page, its modules and its stylesheet are served; the shared helpers too', async () => {
  const page = await fetch(`${server.baseUrl}/practice`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>Practice · Claude Translate<\/title>/);

  const css = await fetch(`${server.baseUrl}/features/practice/web/practice.css`);
  assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8');
  assert.equal((await fetch(`${server.baseUrl}/shared/web/ui.ts`)).status, 200);
  // A module in a folder under shared/web/ is served too: markdown.ts imports its parts from markdown/.
  assert.equal((await fetch(`${server.baseUrl}/shared/web/markdown/inline.ts`)).status, 200);
  assert.equal((await fetch(`${server.baseUrl}/shared/web/base.css`)).status, 200);

  const example = await fetch(`${server.baseUrl}/features/practice/static/example-project.json`);
  assert.equal(example.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(JSON.parse(await example.text()).format, 4);
  assert.equal((await fetch(`${server.baseUrl}/features/practice/static/import-format.md`)).status, 200);

  // Server code, prompts and the entry file stay on the server.
  assert.equal((await fetch(`${server.baseUrl}/features/practice/web/../../../server.ts`)).status, 404);
  assert.equal((await fetch(`${server.baseUrl}/features/practice/server/store.ts`)).status, 404);
  assert.equal((await fetch(`${server.baseUrl}/features/practice/prompts/grade.md`)).status, 404);
  assert.equal((await fetch(`${server.baseUrl}/shared/server/paths.ts`)).status, 404);
  assert.equal((await fetch(`${server.baseUrl}/features/practice/web/format.test.ts`)).status, 404);
});

test('every module the page loads, however deep, is served as JavaScript without types', async () => {
  const seen = new Set<string>();
  const pending = [`${server.baseUrl}/features/practice/web/practice.ts`];
  while (pending.length > 0) {
    const url = pending.pop() as string;
    if (seen.has(url)) continue;
    seen.add(url);
    const response = await fetch(url);
    assert.equal(response.status, 200, url);
    assert.equal(response.headers.get('content-type'), 'text/javascript; charset=utf-8', url);
    const source = await response.text();
    assert.doesNotMatch(source, /import type|^\s*(export )?(enum|namespace) /m, url);
    for (const [, importPath] of source.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g)) pending.push(new URL(importPath, url).href);
  }
  const expectedModules = [
    'features/practice/web/exercise.ts',
    'features/practice/web/templates/index.ts',
    'features/practice/import-check.ts',
    'features/practice/format-3.ts',
    'features/practice/text.ts',
    'shared/web/ui.ts',
  ];
  for (const name of expectedModules) {
    assert.ok(seen.has(`${server.baseUrl}/${name}`), name);
  }
});

test('the translate page links to Practice and keeps its title', async () => {
  const page = await (await fetch(`${server.baseUrl}/`)).text();
  assert.match(page, /<title>Claude Translate<\/title>/);
  assert.match(page, /href="\/practice"/);
});

test('the example file imports as a project with every type', async () => {
  const key = await exampleProject();
  const project = await get(`/projects/${key}`);
  assert.equal(project.name, 'IELTS Writing Task 2 – Example');
  assert.equal(project.exerciseCount, 10);
  assert.deepEqual(project.typeCounts, { rewrite: 2, translation: 1, correction: 1, essay: 1, choice: 2, gap_fill: 1, flashcard: 2 });

  const { items } = await get(`/projects/${key}/exercises`);
  assert.equal(items[0].label, 'Rewrite, sentence');
  assert.equal(items[0].topic, 'transport');
  assert.equal(items[1].label, 'Rewrite, paragraph');
  assert.equal(items[2].label, 'Translation, sentence');
});

// ---- Grading ----

test('a flashcard has no grading: the rating is the result, and it never reaches claude', async () => {
  const key = await exampleProject();
  const runsBefore = server.claudeRuns().length;
  const card = await answerAndRead(key, 'ex-09', { answer: { type: 'flashcard', rating: 'almost' }, timeSpentMs: 900 });
  assert.deepEqual(card.gradings, []);
  assert.deepEqual(card.answer, { type: 'flashcard', rating: 'almost' });
  assert.equal(card.timeSpentMs, 900);
  assert.equal(server.claudeRuns().length, runsBefore);

  const project = await get(`/projects/${key}`);
  assert.equal(project.doneCount, 1);
  assert.equal(project.lastActivityAt, card.createdAt);

  const stored = await get(`/attempts/${card.id}`);
  assert.equal(stored.exerciseSnapshot.content.type, 'flashcard');
  assert.equal(stored.exerciseSnapshot.topic, 'IELTS vocabulary');
  const regrade = await call('POST', `/attempts/${card.id}/regrade`, {});
  assert.equal(regrade.status, 409);
  assert.equal((await regrade.json()).error.code, 'not_graded_by_ai');
});

test('answers that do not fit their exercise are refused and nothing is saved', async () => {
  const key = await exampleProject();
  const badAnswers: [string, unknown][] = [
    ['ex-06', { type: 'choice', chosenOptionIndexes: [7] }],
    ['ex-06', { type: 'choice', chosenOptionIndexes: [0, 1] }],
    ['ex-08', { type: 'gap_fill', gapAnswers: ['one'] }],
    ['ex-09', { type: 'flashcard', rating: 'great' }],
    ['ex-01', { type: 'rewrite', text: '  ' }],
    ['ex-01', { type: 'translation', text: 'Right text, wrong type.' }],
    ['ex-01', 'text'],
  ];
  for (const [exercise, badAnswer] of badAnswers) {
    const response = await answer(key, exercise, { answer: badAnswer });
    assert.equal(response.status, 400, `${exercise} ${JSON.stringify(badAnswer)}`);
  }
  const missing = await answer(key, 'ex-01', {});
  assert.equal(missing.status, 400);

  const attempts = await get(`/attempts?project=${key}`);
  assert.equal(attempts.items.length, 0);
});

test('a rewrite is saved, graded by claude with the common prompt, and the text stored as it came', async () => {
  const key = await exampleProject();
  const started = await answerAndRead(key, 'ex-01', { answer: { type: 'rewrite', text: `New lanes for reduce traffic. FAKE:reply=${FEEDBACK}` } });
  assert.equal(started.gradings.length, 1);
  assert.equal(latestOf(started).run.status, 'running');
  assert.equal(latestOf(started).feedbackMarkdown, null);

  const graded = latestOf(await waitForGrading(started.id));
  assert.equal(graded.run.status, 'succeeded');
  assert.equal(graded.run.errorCode, null);
  assert.equal(graded.feedbackMarkdown, FEEDBACK);
  assert.equal(graded.run.requestedModelId, 'claude-sonnet-5-5');
  assert.equal(graded.run.servedModelId, 'claude-sonnet-5-5');
  assert.equal(graded.run.effort, 'low');
  assert.equal(graded.run.thinkingText, null);
  assert.equal(graded.run.thinkingMs, null);
  assert.ok(Date.parse(graded.run.finishedAt) >= Date.parse(graded.run.startedAt));

  assert.match(lastRun().content, /"type": "rewrite"/);
  assert.match(lastRun().content, /Many cities have built new cycle lanes/);
  assert.match(lastRun().content, /"modelAnswer": "New cycle lanes have been built/);
  assert.match(lastRun().content, /<answer word_count="\d+">\nNew lanes for reduce traffic\./);
  assert.equal(argOf('--model'), 'claude-sonnet-5-5');
  assert.equal(argOf('--effort'), 'low');
  assert.equal(argOf('--system-prompt'), `${GRADE_PROMPT.trim()}\n`);
  for (const section of ['<role>', '<context>', '<how_to_evaluate>', '<output_structure>']) {
    assert.ok(argOf('--system-prompt').includes(section), section);
  }

  const { items } = await get(`/projects/${key}/exercises`);
  assert.equal(items[0].lastAttempt.historyLine, 'Graded');
  assert.equal(items[0].lastAttempt.gradingStatus, 'succeeded');
  assert.equal((await get(`/projects/${key}`)).doneCount, 1);
});

test('an essay is graded with the whole exercise, and with the model and effort the person picked', async () => {
  const key = await exampleProject();
  const answerText = 'Public transport matters. FAKE:reply=Band 6.0 overall.';
  const body = { answer: { type: 'essay', text: answerText }, timeSpentMs: 1, modelId: 'claude-haiku-5-5', effort: 'high' };
  const started = await answerAndRead(key, 'ex-05', body);
  const graded = latestOf(await waitForGrading(started.id));
  assert.equal(graded.feedbackMarkdown, 'Band 6.0 overall.');
  assert.equal(graded.run.requestedModelId, 'claude-haiku-5-5');
  assert.equal(graded.run.effort, 'high');
  assert.equal(argOf('--model'), 'claude-haiku-5-5');
  assert.equal(argOf('--effort'), 'high');
  assert.match(lastRun().content, /"type": "essay"/);
  assert.match(lastRun().content, /"minWords": 250/);
  assert.match(lastRun().content, /Some people think that governments/);
});

test('a translation and a correction send their own fields to the grader', async () => {
  const key = await exampleProject();
  const translated = await answerAndRead(key, 'ex-03', { answer: { type: 'translation', text: 'More young people live in big cities. FAKE:reply=Good.' } });
  await waitForGrading(translated.id);
  assert.match(lastRun().content, /"sourceLanguage": "vi"/);

  const answerText = 'Many students prefer online classes because it save time. FAKE:reply=Two of three fixed.';
  const started = await answerAndRead(key, 'ex-04', { answer: { type: 'correction', text: answerText } });
  assert.equal(latestOf(await waitForGrading(started.id)).feedbackMarkdown, 'Two of three fixed.');
  assert.match(lastRun().content, /"wrongText": "it saves"/);
  assert.match(lastRun().content, /"correctText": "they save"/);
});

test('a choice is graded by claude with the correct options and the explanations, and the picked options as letters', async () => {
  const key = await exampleProject();
  const started = await answerAndRead(key, 'ex-06', { answer: { type: 'choice', chosenOptionIndexes: [0] } });
  const graded = latestOf(await waitForGrading(started.id));
  assert.equal(graded.run.status, 'succeeded');
  assert.equal(graded.feedbackMarkdown, CANNED_REPLY.trim());
  assert.match(lastRun().content, /"type": "choice"/);
  assert.match(lastRun().content, /"isCorrect": true/);
  assert.match(lastRun().content, /"explanationMarkdown": "Second conditional: if \+ past simple, would \+ verb\."/);
  assert.match(lastRun().content, /<answer>\nA\. use\n<\/answer>/);
});

test('a gap fill is graded by claude with the accepted answers and the typed gaps', async () => {
  const key = await exampleProject();
  const started = await answerAndRead(key, 'ex-08', { answer: { type: 'gap_fill', gapAnswers: ['have rised', ''] } });
  assert.equal(latestOf(await waitForGrading(started.id)).run.status, 'succeeded');
  assert.match(lastRun().content, /"type": "gap_fill"/);
  assert.match(lastRun().content, /"have been rising"/);
  assert.match(lastRun().content, /<answer>\nGap 1: have rised\nGap 2: \(blank\)\n<\/answer>/);
});

test('the grading options are the ones Claude Translate offers', async () => {
  const options = await get('/grading-options');
  assert.deepEqual(options.models.map((model: any) => model.modelId), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
  assert.deepEqual(options.efforts.map((effort: any) => effort.effort), ['low', 'medium', 'high']);

  const translateOptions = await (await fetch(`${server.baseUrl}/translation-options`)).json() as any;
  assert.equal(options.defaultModelId, translateOptions.defaultModelId);
  assert.equal(options.defaultEffort, translateOptions.defaultEffort);
  assert.deepEqual(options.models, translateOptions.models);
});

test('a model or effort that is not offered is refused, for an answer and for Grade again', async () => {
  const key = await exampleProject();
  const runsBefore = server.claudeRuns().length;
  const textAnswer = { type: 'rewrite', text: 'Text.' };
  for (const settings of [{ modelId: 'gpt-5' }, { effort: 'extreme' }, { modelId: 7 }, { effort: null }, { effort: 'max' }]) {
    const refused = await answer(key, 'ex-01', { answer: textAnswer, ...settings });
    assert.equal(refused.status, 400, JSON.stringify(settings));
    assert.match(await refused.text(), /must be one of/);
  }
  assert.equal((await get(`/attempts?project=${key}`)).items.length, 0);

  const failed = await answerAndRead(key, 'ex-01', { answer: { type: 'rewrite', text: 'Text. FAKE:error' } });
  await waitForGrading(failed.id);
  const regrade = await call('POST', `/attempts/${failed.id}/regrade`, { effort: 'extreme' });
  assert.equal(regrade.status, 400);
  assert.equal((await get(`/attempts/${failed.id}`)).gradings.length, 1);
  assert.equal(server.claudeRuns().length, runsBefore + 1);
});

// ---- The grading stream ----

// The events of a grading's stream as [name, data], read until it ends.
async function watch(attemptId: number): Promise<[string, any][]> {
  const response = await fetch(`${server.baseUrl}/api/practice/attempts/${attemptId}/stream`);
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
  const started = await answerAndRead(key, 'ex-01', { answer: { type: 'rewrite', text: `Lanes were built. FAKE:stream=${reply}` } });

  // Joined before the first words: the whole thing arrives live, after an (empty or short) snapshot.
  const first = watch(started.id);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const midway = await watch(started.id).catch(() => [] as [string, any][]);
  const events = await first;

  const [snapshotName, snapshot] = events[0];
  assert.equal(snapshotName, 'snapshot');
  assert.equal(snapshot.modelId, 'claude-sonnet-5-5');
  assert.equal(typeof snapshot.elapsedMs, 'number');
  assert.equal(snapshot.effort, 'low');
  assert.equal(events.at(-1)![0], 'done');
  assert.equal(snapshot.text + streamedText(events), reply);

  // The second watcher was a whole page reload: its snapshot already held the words so far, and it ended when the grading did.
  const [midwayName, midwaySnapshot] = midway[0];
  assert.equal(midwayName, 'snapshot');
  assert.ok(midwaySnapshot.text.length > 0, 'the snapshot holds some of the words');
  assert.ok(midwaySnapshot.text.length < reply.length, 'the snapshot does not hold all of the words');
  assert.equal(midwaySnapshot.text + streamedText(midway), reply);
  assert.equal(midway.at(-1)![0], 'done');

  const thinking = events.find(([name]) => name === 'thinking_delta')!;
  assert.deepEqual(thinking[1], { text: 'Thinking it over.' });

  const thinkingDone = events.find(([name]) => name === 'thinking_done')!;
  assert.equal(typeof thinkingDone[1].durationMs, 'number');

  const graded = latestOf(await get(`/attempts/${started.id}`));
  assert.equal(graded.run.status, 'succeeded');
  assert.equal(graded.feedbackMarkdown, reply);
  assert.equal(graded.run.thinkingText, 'Thinking it over.');
  assert.equal(typeof graded.run.thinkingMs, 'number');

  // Once it is over there is nothing to join.
  assert.deepEqual(await watch(started.id), [['finished', {}]]);
  assert.equal((await fetch(`${server.baseUrl}/api/practice/attempts/999999/stream`)).status, 404);
});

test('a grading goes on and is saved when nobody is watching, and a failure reaches the watcher and the attempt', async () => {
  const key = await exampleProject();
  const started = await answerAndRead(key, 'ex-01', { answer: { type: 'rewrite', text: 'Text. FAKE:stream=One two three four.' } });
  const response = await fetch(`${server.baseUrl}/api/practice/attempts/${started.id}/stream`);
  await response.body!.cancel();
  assert.equal(latestOf(await waitForGrading(started.id)).feedbackMarkdown, 'One two three four.');

  const crash = await answerAndRead(key, 'ex-01', { answer: { type: 'rewrite', text: 'Text. FAKE:error' } });
  const events = await watch(crash.id);
  const [lastName, lastData] = events.at(-1)!;
  assert.ok(['error', 'finished'].includes(lastName));
  const failed = latestOf(await waitForGrading(crash.id));
  assert.equal(failed.run.status, 'failed');
  if (lastName === 'error') assert.equal(lastData.message, failed.run.errorMessage);
});

test('a failed run keeps its error code and message; Grade again adds a new grading, at any time but one at a time', async () => {
  const key = await exampleProject();
  const crash = await answerAndRead(key, 'ex-01', { answer: { type: 'rewrite', text: 'Text. FAKE:error' } });
  const failed = latestOf(await waitForGrading(crash.id));
  assert.equal(failed.run.status, 'failed');
  assert.equal(failed.run.errorCode, 'claude_error');
  assert.equal(failed.run.errorMessage, 'Fake API error');
  assert.equal(failed.feedbackMarkdown, null);

  const regrade = await call('POST', `/attempts/${crash.id}/regrade`, {});
  assert.equal(regrade.status, 202);
  const after = await waitForGrading(crash.id);
  assert.deepEqual(after.gradings.map((grading: any) => grading.run.status), ['failed', 'failed']);
  assert.equal((await call('POST', '/attempts/999999/regrade', {})).status, 404);

  // A succeeded attempt may be graded again too (rule 7), with another model; the first result is kept.
  const ok = await answerAndRead(key, 'ex-01', { answer: { type: 'rewrite', text: 'Text. FAKE:stream=Fine and good.' } });
  const busy = await call('POST', `/attempts/${ok.id}/regrade`, {});
  assert.equal(busy.status, 409);
  assert.equal((await busy.json()).error.code, 'grading_in_progress');
  await waitForGrading(ok.id);
  const again = await call('POST', `/attempts/${ok.id}/regrade`, { modelId: 'claude-haiku-5-5' });
  assert.equal(again.status, 202);
  const both = (await waitForGrading(ok.id)).gradings;
  assert.deepEqual(both.map((grading: any) => grading.run.requestedModelId), ['claude-sonnet-5-5', 'claude-haiku-5-5']);
  assert.equal(both[0].feedbackMarkdown, 'Fine and good.');
});

// ---- Robustness ----

test('one malformed row never breaks the lists, and an attempt keeps its exercise after the exercise changes', async () => {
  const key = await exampleProject();
  const card = await answerAndRead(key, 'ex-10', { answer: { type: 'flashcard', rating: 'knew' } });

  const database = new DatabaseSync(join(server.dataDirectory, 'practice.sqlite'));
  const projectId = (await get(`/projects/${key}`)).id;
  database.prepare("UPDATE exercises SET content_json = 'null' WHERE project_id = ? AND key = 'ex-01'").run(projectId);
  const changed = JSON.stringify({ type: 'flashcard', front: 'changed', back: 'b', hint: null, example: null, explanationMarkdown: null });
  database.prepare("UPDATE exercises SET content_json = ? WHERE project_id = ? AND key = 'ex-10'").run(changed, projectId);
  database.close();

  const { items } = await get(`/projects/${key}/exercises`);
  assert.equal(items[0].preview, '');
  assert.equal(items[9].preview, 'changed');
  assert.equal((await get(`/attempts/${card.id}`)).exerciseSnapshot.content.front, 'resilient');
});

test('every API error has the one shape: bad JSON, too large, invalid, not found, wrong method, unknown path', async () => {
  const key = await exampleProject();
  const attemptsPath = `/projects/${key}/exercises/ex-01/attempts`;

  const badJson = await call('POST', attemptsPath, '{\n  "answer": oops\n}');
  assert.equal(badJson.status, 400);
  assert.equal(badJson.headers.get('content-type'), 'application/json; charset=utf-8');
  const badJsonError = (await badJson.json()).error;
  assert.equal(badJsonError.code, 'bad_json');
  assert.match(badJsonError.message, /line 2, column 13/);

  const tooLarge = await call('POST', attemptsPath, { answer: { text: 'x'.repeat(300_000) } });
  assert.equal(tooLarge.status, 413);
  assert.equal((await tooLarge.json()).error.code, 'too_large');

  const notObject = await call('POST', attemptsPath, '[]');
  assert.deepEqual(await notObject.json(), {
    error: { code: 'invalid', message: 'The request has 1 problem.', problems: [{ path: '', code: 'wrong_type', message: 'The body must be a JSON object.' }] },
  });

  const missing = await call('GET', '/attempts/999999');
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: { code: 'not_found', message: 'No such attempt.' } });

  const wrongMethod = await call('PUT', '/grading-options');
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'GET');
  assert.equal((await call('GET', '/attempts/1/regrade')).status, 405);

  const unknownPath = await call('GET', '/nothing/here');
  assert.equal(unknownPath.status, 404);
  assert.deepEqual(await unknownPath.json(), { error: { code: 'not_found', message: 'Nothing at /api/practice/nothing/here.' } });

  // Outside the API a 404 stays bare.
  assert.equal((await fetch(`${server.baseUrl}/nothing`)).headers.get('content-type'), null);
});

test('the first API is gone', async () => {
  assert.equal((await call('POST', '/projects', { file: '{}' })).status, 405);
  assert.equal((await call('POST', '/attempts', { exercise_id: 1, answer: {} })).status, 405);
  assert.equal((await call('GET', '/exercises/1')).status, 404);
});
