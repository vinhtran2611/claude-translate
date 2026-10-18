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
