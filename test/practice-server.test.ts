// Practice's HTTP API through the real server (features/practice/server/routes.ts).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestServer, type TestServer } from './server-harness.ts';

const EXAMPLE_TEXT = readFileSync(new URL('../features/practice/examples/exercises.example.json', import.meta.url), 'utf8');

let server: TestServer;
before(async () => { server = await startTestServer(); });
after(async () => { await server.stop(); });

const importText = (body: string, file_name = 'w01.json') => fetch(`${server.base_url}/api/practice/exercises/import`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-File-Name': file_name }, body,
});
const listExercises = async () => (await fetch(`${server.base_url}/api/practice/exercises`)).json();

test('the page and its module are served', async () => {
  const page = await fetch(`${server.base_url}/practice`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>Practice · Claude Translate<\/title>/);
  const module_response = await fetch(`${server.base_url}/practice/web/practice.ts`);
  assert.equal(module_response.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.doesNotMatch(await module_response.text(), /import type/);
  assert.equal((await fetch(`${server.base_url}/shared/web/ui.ts`)).status, 200);
  assert.equal((await fetch(`${server.base_url}/shared/web/base.css`)).status, 200);
});

test('a file with errors imports nothing and lists every error', async () => {
  const file = JSON.parse(EXAMPLE_TEXT);
  delete file.exercises[0].text_vi;
  file.exercises[3].essay_type = 'story';
  const response = await importText(JSON.stringify(file));
  assert.equal(response.status, 400);
  const { errors } = await response.json();
  assert.deepEqual(errors.map((error: { path: string }) => error.path), ['exercises[0].text_vi', 'exercises[3].essay_type']);
  assert.deepEqual(await listExercises(), []);
  assert.equal((await importText('{ not json')).status, 400);
});

test('importing the example adds 5 exercises in file order and keeps a copy of the file', async () => {
  const response = await importText(EXAMPLE_TEXT);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { added: 5, updated: 0, warnings: [] });
  const exercises = await listExercises();
  assert.deepEqual(exercises.map((exercise: { id: string }) => exercise.id), ['w01-s01', 'w01-p01', 'w01-e01', 'w01-f01', 'w01-c01']);
  assert.equal(exercises[0].attempt_count, 0);
  const copies = readdirSync(join(server.data_directory, 'practice-imports'));
  assert.equal(copies.length, 1);
  assert.match(copies[0], /-w01\.json$/);
});

test('importing again replaces by id and keeps the order', async () => {
  const file = JSON.parse(EXAMPLE_TEXT);
  file.exercises[0].text_vi = 'Câu mới.';
  file.exercises.push({ id: 'w02-s01', type: 'sentence_translation', text_vi: 'Một câu khác.' });
  const response = await importText(JSON.stringify(file), 'w01-fixed.json');
  assert.deepEqual(await response.json(), { added: 1, updated: 5, warnings: [] });
  const exercises = await listExercises();
  assert.equal(exercises.length, 6);
  assert.equal(exercises[0].id, 'w01-s01');
  assert.equal(exercises[0].title, 'Câu mới.');
  assert.equal(exercises[5].id, 'w02-s01');
  const detail = await (await fetch(`${server.base_url}/api/practice/exercises/w01-s01`)).json();
  assert.equal(detail.exercise.text_vi, 'Câu mới.');
  assert.equal((await fetch(`${server.base_url}/api/practice/exercises/nope`)).status, 404);
});

test('the translate page links to Practice and keeps its title', async () => {
  const page = await (await fetch(`${server.base_url}/`)).text();
  assert.match(page, /<title>Claude Translate<\/title>/);
  assert.match(page, /href="\/practice"/);
});

// Grading: the answer carries a FAKE: marker that tells the fake claude what to reply (test/fake-claude/claude).
const FEEDBACK = {
  feedback_version: 1, categories_version: 1, summary: 'Good. One verb to fix.', strengths: [],
  errors: [{ original: 'choose living', correction: 'choose to live', category: 'verb_form', severity: 'major', explanation: 'choose + to.', rule: 'choose + to + verb.' }],
  corrected_text: 'They choose to live here.', natural_version: 'They choose to live here.', meaning: 'complete', remember: ['choose + to + verb.'],
};

const submit = (exercise_id: string, text: string) => fetch(`${server.base_url}/api/practice/attempts`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ exercise_id, answer: { text }, writing_ms: 5000 }),
});

async function waitForGrading(attempt_id: number): Promise<any> {
  for (let tries = 0; tries < 100; tries++) {
    const attempt = await (await fetch(`${server.base_url}/api/practice/attempts/${attempt_id}`)).json();
    if (attempt.status !== 'grading') return attempt;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`attempt ${attempt_id} is still grading`);
}

test('an answer is saved, graded with the grading prompt, and the feedback stored', async () => {
  const response = await submit('w01-s01', `They choose living here. FAKE:reply=${JSON.stringify(FEEDBACK)}`);
  assert.equal(response.status, 201);
  const { attempt_id } = await response.json();
  const attempt = await waitForGrading(attempt_id);
  assert.equal(attempt.status, 'graded');
  assert.deepEqual(attempt.feedback, FEEDBACK);
  assert.equal(attempt.error_count, 1);
  assert.equal(attempt.major_error_count, 1);
  assert.equal(attempt.served_model_id, 'claude-sonnet-5-5');
  assert.equal(attempt.writing_ms, 5000);
  assert.equal(attempt.exercise_snapshot.text_vi, 'Câu mới.');
  const run = server.claudeRuns().find((logged_run) => logged_run.content.includes('They choose living here.'));
  assert.ok(run);
  assert.match(run.args[run.args.indexOf('--system-prompt') + 1], /IELTS Writing examiner/);
  const exercises = await listExercises();
  assert.deepEqual(exercises[0].last_attempt.id, attempt_id);
  assert.equal(exercises[0].last_attempt.error_count, 1);
});

test('a reply that is not valid feedback fails with the raw reply kept, and Grade again works', async () => {
  const { attempt_id } = await (await submit('w01-p01', 'Some answer. FAKE:reply={"summary":"incomplete"}')).json();
  const failed = await waitForGrading(attempt_id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error_kind, 'invalid_feedback');
  assert.equal(failed.raw_output, '{"summary":"incomplete"}');
  assert.equal(failed.answer.text, 'Some answer. FAKE:reply={"summary":"incomplete"}');
  const regrade = await fetch(`${server.base_url}/api/practice/attempts/${attempt_id}/regrade`, { method: 'POST' });
  assert.equal(regrade.status, 202);
  assert.equal((await waitForGrading(attempt_id)).status, 'failed');
});

test('a crash fails the attempt; a graded attempt cannot be graded again', async () => {
  const { attempt_id } = await (await submit('w01-s01', 'Crash please FAKE:crash')).json();
  const failed = await waitForGrading(attempt_id);
  assert.equal(failed.error_kind, 'exited');
  assert.equal(failed.error_message, 'fake claude crashed');
  const graded_id = (await (await submit('w01-s01', `Fine. FAKE:reply=${JSON.stringify(FEEDBACK)}`)).json()).attempt_id;
  await waitForGrading(graded_id);
  assert.equal((await fetch(`${server.base_url}/api/practice/attempts/${graded_id}/regrade`, { method: 'POST' })).status, 409);
});

test('bad attempts are rejected before anything is saved', async () => {
  assert.equal((await submit('nope', 'Hello.')).status, 404);
  assert.equal((await submit('w01-s01', '   ')).status, 400);
  assert.equal((await submit('w01-s01', 'a'.repeat(1001))).status, 400);
  assert.equal((await submit('w01-f01', 'An essay.')).status, 400);
  const exercises = await listExercises();
  assert.equal(exercises.find((exercise: { id: string }) => exercise.id === 'w01-f01').is_gradable, false);
});

test('the server backs up both databases on start', async () => {
  const backups = readdirSync(join(server.data_directory, 'backups'));
  assert.ok(backups.some((name) => /^history-\d{4}-\d{2}-\d{2}\.sqlite$/.test(name)));
  assert.ok(backups.some((name) => /^practice-\d{4}-\d{2}-\d{2}\.sqlite$/.test(name)));
});

test('History lists attempts newest first, with filters by type and exercise', async () => {
  const all = await (await fetch(`${server.base_url}/api/practice/attempts`)).json();
  assert.ok(all.length >= 4);
  assert.deepEqual(all.map((attempt: { id: number }) => attempt.id), [...all.map((attempt: { id: number }) => attempt.id)].sort((a, b) => b - a));
  assert.deepEqual(Object.keys(all[0]).sort(), ['error_count', 'exercise_id', 'exercise_type', 'id', 'status', 'submitted_at', 'title']);
  const paragraphs = await (await fetch(`${server.base_url}/api/practice/attempts?type=paragraph_translation`)).json();
  assert.ok(paragraphs.length > 0);
  assert.ok(paragraphs.every((attempt: { exercise_type: string }) => attempt.exercise_type === 'paragraph_translation'));
  const for_exercise = await (await fetch(`${server.base_url}/api/practice/attempts?exercise_id=w01-s01`)).json();
  assert.ok(for_exercise.every((attempt: { exercise_id: string; title: string }) => attempt.exercise_id === 'w01-s01' && attempt.title === 'Câu mới.'));
  assert.ok(all.some((attempt: { status: string }) => attempt.status === 'failed'));
});
