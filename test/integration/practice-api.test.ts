// Practice's key-addressed API (docs/practice-api-design.md §3) through the real server, with a fake claude.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, type TestServer } from '../helpers/server-harness.ts';

let server: TestServer;
before(async () => { server = await startTestServer(); });
after(async () => { await server.stop(); });

// ---- Helpers ----

interface Reply {
  status: number;
  // The parsed JSON body; null when the body is empty (a 204).
  body: any;
  headers: Headers;
}

// Sends one request to /api/practice<path>. A body that is not a string is sent as JSON.
async function call(method: string, path: string, body?: unknown): Promise<Reply> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const response = await fetch(`${server.baseUrl}/api/practice${path}`, init);
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : JSON.parse(text), headers: response.headers };
}

// The body of a GET that must succeed.
async function get(path: string): Promise<any> {
  const reply = await call('GET', path);
  assert.equal(reply.status, 200, `GET ${path}`);
  return reply.body;
}

// The problems of a 400 invalid, as "path code" lines, easy to compare.
function problemsOf(reply: Reply): string[] {
  assert.equal(reply.status, 400);
  assert.equal(reply.body.error.code, 'invalid');
  return reply.body.error.problems.map((problem: { path: string; code: string }) => `${problem.path} ${problem.code}`);
}

function keysOf(items: { key: string }[]): string[] {
  return items.map((item) => item.key);
}

function card(key: string, front: string) {
  return { key, content: { type: 'flashcard', front, back: 'b' } };
}

function rewrite(key: string, text: string) {
  return { key, topic: 'transport', content: { type: 'rewrite', instruction: 'Fix it.', sourceText: text, length: 'sentence' } };
}

function fileOf(projectKey: string, ...exercises: object[]) {
  return { format: 4, project: { key: projectKey, name: `Project ${projectKey}` }, exercises };
}

const KNEW = { type: 'flashcard', rating: 'knew' };

// ---- Discovery ----

test('the index tells an agent the version, the types, the formats and the limits', async () => {
  const index = await get('');
  assert.equal(index.api, 'practice');
  assert.equal(index.version, 4);
  assert.deepEqual(index.types, ['rewrite', 'translation', 'correction', 'essay', 'choice', 'gap_fill', 'flashcard']);
  assert.deepEqual(index.importFormats, [4, 3]);
  assert.equal(index.limits.keyPattern, '^[a-z0-9][a-z0-9-]{0,63}$');
  assert.equal(index.limits.attemptsPageMax, 200);
});

test('the index lists every endpoint with its method, path, parameters and one line', async () => {
  const index = await get('');
  assert.equal(index.endpoints.length, 28);
  const lines = index.endpoints.map((endpoint: any) => `${endpoint.method} ${endpoint.path}`);
  assert.ok(lines.includes('GET /api/practice'));
  assert.ok(lines.includes('POST /api/practice/projects/{p}/rename'));
  assert.ok(lines.includes('POST /api/practice/projects/{p}/exercises/{e}/rename'));
  assert.ok(lines.includes('POST /api/practice/projects/{p}/exercises/{e}/move'));
  assert.ok(lines.includes('PUT /api/practice/projects/{p}/order'));
  assert.ok(lines.includes('GET /api/practice/attempts/{id}/stream'));
  assert.ok(lines.includes('POST /api/practice/generations/{id}/retry'));
  assert.equal(index.limits.generationBodyBytes, 1_000_000);
  for (const endpoint of index.endpoints) assert.ok(endpoint.about.length > 0, endpoint.path);

  const attempts = index.endpoints.find((endpoint: any) => endpoint.method === 'GET' && endpoint.path === '/api/practice/attempts');
  assert.deepEqual(attempts.query, ['project', 'exercise', 'status', 'since', 'before', 'limit']);
});

test('the exercise schema has one entry per type, made from the checker', async () => {
  const schema = await get('/schemas/exercise.json');
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.oneOf.length, 7);

  const flashcard = schema.$defs.flashcard;
  assert.equal(flashcard.additionalProperties, false);
  assert.deepEqual(flashcard.required, ['key', 'content']);
  const content = flashcard.properties.content;
  assert.deepEqual(content.properties.type, { const: 'flashcard' });
  assert.deepEqual(content.required, ['type', 'front', 'back']);

  // A field that may be left out may also be null.
  const explanation = content.properties.explanationMarkdown;
  assert.equal(explanation.anyOf[0].maxLength, 5000);
  assert.deepEqual(explanation.anyOf[1], { type: 'null' });
  assert.match(explanation.description, /^Markdown/);

  // The rule a schema cannot say is in the type's description.
  assert.match(schema.$defs.choice.description, /At least one option has isCorrect: true/);
});

test('the import schema points at the exercise schema; an unknown schema is a 404', async () => {
  const schema = await get('/schemas/import.json');
  assert.deepEqual(schema.properties.format, { const: 4 });
  assert.deepEqual(schema.properties.exercises.items, { $ref: 'exercise.json' });
  assert.deepEqual(schema.properties.project.required, ['key', 'name']);

  const missing = await call('GET', '/schemas/nope.json');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'not_found');
});

// ---- Import ----

test('a dry run of an import says what would happen and writes nothing', async () => {
  const file = fileOf('dry', card('c1', 'cheap'));
  const reply = await call('POST', '/import?dry_run=true', file);
  assert.equal(reply.status, 200);
  assert.equal(reply.body.dryRun, true);
  assert.equal(reply.body.projectChange, 'created');
  assert.deepEqual(reply.body.exercises.created, ['c1']);

  const project = await call('GET', '/projects/dry');
  assert.equal(project.status, 404);
});

test('importing the same file twice: created, then unchanged', async () => {
  const file = fileOf('m1-day-01', card('d1-card-1', 'cheap'), rewrite('d1-fix-1', 'It go.'));

  const first = await call('POST', '/import', file);
  assert.equal(first.status, 200);
  assert.equal(first.body.projectChange, 'created');
  assert.equal(first.body.project.exerciseCount, 2);

  const second = await call('POST', '/import', file);
  assert.equal(second.body.projectChange, 'unchanged');
  assert.deepEqual(second.body.exercises, { created: [], updated: [], unchanged: ['d1-card-1', 'd1-fix-1'] });
});

test('importing a fixed file updates in place: changed content gets a new version', async () => {
  await call('POST', '/import', fileOf('fixed', card('c1', 'cheap'), rewrite('r1', 'It go.')));

  const fixed = fileOf('fixed', card('c1', 'cheap'), rewrite('r1', 'It go home.'), card('c2', 'expensive'));
  const reply = await call('POST', '/import', fixed);
  assert.deepEqual(reply.body.exercises, { created: ['c2'], updated: ['r1'], unchanged: ['c1'] });

  const r1 = await get('/projects/fixed/exercises/r1');
  assert.equal(r1.version, 2);
  assert.equal(r1.content.sourceText, 'It go home.');
  const c1 = await get('/projects/fixed/exercises/c1');
  assert.equal(c1.version, 1);
});

test('a bad file is refused with every problem, and nothing is written', async () => {
  const blank = card('a', ' ');
  const unknownField = { ...card('a', 'x'), colour: 'red' };
  const reply = await call('POST', '/import', fileOf('bad', blank, unknownField));
  assert.equal(reply.body.error.message, 'The request has 3 problems.');
  assert.deepEqual(problemsOf(reply), [
    '/exercises/0/content/front empty',
    '/exercises/1/colour unknown_field',
    '/exercises/1/key duplicate_key',
  ]);

  const project = await call('GET', '/projects/bad');
  assert.equal(project.status, 404);
});

test('a format 3 file is still imported, converted to the new model', async () => {
  const oldFile = {
    format: 3,
    project: { key: 'old-format', name: 'Old format' },
    exercises: [{ key: 'w1', type: 'write', content: { prompt: 'Discuss.', sample: 'S' } }],
  };
  const reply = await call('POST', '/import', oldFile);
  assert.equal(reply.status, 200);
  const essay = await get('/projects/old-format/exercises/w1');
  assert.deepEqual(essay.content, { type: 'essay', instruction: 'Discuss.', minWords: 250, suggestedMinutes: null, constraints: [], modelAnswer: 'S' });
});

test('a format 2 file is refused with the edits that make it format 3', async () => {
  const oldFile = { format: 2, project: { name: 'Old' }, exercises: [{ id: 'a', type: 'flashcard', content: { front: 'f', back: 'b' } }] };
  const reply = await call('POST', '/import', oldFile);
  const [formatProblem] = reply.body.error.problems;
  assert.equal(formatProblem.code, 'unsupported_format');
  assert.match(formatProblem.message, /rename each exercise's "id" to "key"/);
});

test('import: bad JSON, a body over 2 MB, and unknown or wrong query parameters', async () => {
  const badJson = await call('POST', '/import', '{"format": 4,');
  assert.equal(badJson.status, 400);
  assert.equal(badJson.body.error.code, 'bad_json');

  const tooLarge = `${JSON.stringify(fileOf('huge', card('a', 'f')))}${' '.repeat(2_000_000)}`;
  const large = await call('POST', '/import', tooLarge);
  assert.equal(large.status, 413);
  assert.equal(large.body.error.code, 'too_large');

  const typo = await call('POST', '/import?dryrun=true', fileOf('x', card('a', 'f')));
  assert.deepEqual(problemsOf(typo), ['?dryrun unknown_parameter']);

  const wrongValue = await call('POST', '/import?dry_run=yes', fileOf('x', card('a', 'f')));
  assert.deepEqual(problemsOf(wrongValue), ['?dry_run not_allowed']);
});

// ---- Projects ----

test('PUT a project: 201 the first time, 200 and no change the second time', async () => {
  const created = await call('PUT', '/projects/week-2', { name: ' Week 2 ', description: 'Linking words' });
  assert.equal(created.status, 201);
  assert.equal(created.body.key, 'week-2');
  assert.equal(created.body.name, 'Week 2');
  assert.equal(created.body.archivedAt, null);

  const again = await call('PUT', '/projects/week-2', { name: 'Week 2', description: 'Linking words' });
  assert.equal(again.status, 200);
  assert.equal(again.body.updatedAt, created.body.updatedAt);
});

test('a project read with GET can be sent back with PUT (no description is null)', async () => {
  await call('PUT', '/projects/round', { name: 'Round' });
  const project = await get('/projects/round');
  assert.equal(project.description, null);

  const archivedAt = '2026-10-21T08:30:00.000Z';
  const reply = await call('PUT', '/projects/round', { name: project.name, description: project.description, archivedAt });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.archivedAt, archivedAt);
  assert.deepEqual(problemsOf(await call('PUT', '/projects/round', { name: 'Round', archived: true })), ['/archived unknown_field']);
});

test('an archived project is hidden from the default list', async () => {
  await call('PUT', '/projects/old-week', { name: 'Old week', archivedAt: '2026-10-21T08:30:00.000Z' });

  const active = await get('/projects');
  const archived = await get('/projects?archived=true');
  const all = await get('/projects?archived=all');
  assert.equal(keysOf(active.items).includes('old-week'), false);
  assert.equal(keysOf(archived.items).includes('old-week'), true);
  assert.equal(keysOf(all.items).includes('old-week'), true);

  assert.deepEqual(problemsOf(await call('GET', '/projects?archived=maybe')), ['?archived not_allowed']);
});

test('PUT a project checks the key in the URL and the body; a dry run writes nothing', async () => {
  assert.deepEqual(problemsOf(await call('PUT', '/projects/Week_2', { name: 'x' })), ['#key bad_key']);
  assert.deepEqual(problemsOf(await call('PUT', '/projects/week-3', { title: 'x' })), ['/title unknown_field', '/name required']);

  const dry = await call('PUT', '/projects/week-3?dry_run=true', { name: 'Week 3' });
  assert.equal(dry.status, 201);
  const project = await call('GET', '/projects/week-3');
  assert.equal(project.status, 404);
});

test('deleting a project with attempts needs ?with_attempts=true', async () => {
  await call('POST', '/import', fileOf('gone', card('c1', 'one')));
  await call('POST', '/projects/gone/exercises/c1/attempts', { answer: KNEW });

  const refused = await call('DELETE', '/projects/gone');
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'has_attempts');

  const deleted = await call('DELETE', '/projects/gone?with_attempts=true');
  assert.equal(deleted.status, 204);
  assert.equal((await call('GET', '/projects/gone')).status, 404);

  const attempts = await get('/attempts?limit=200');
  assert.equal(attempts.items.some((attempt: any) => attempt.projectKey === 'gone'), false);
});

test('a project without attempts is deleted in one call', async () => {
  await call('PUT', '/projects/empty', { name: 'Empty' });
  const deleted = await call('DELETE', '/projects/empty');
  assert.equal(deleted.status, 204);
  assert.equal(deleted.body, null);
});

test('export gives back the file with every default written out, and importing it again changes nothing', async () => {
  const file = {
    format: 4,
    project: { key: 'round-trip', name: 'Round trip', description: 'Soon' },
    exercises: [{ ...card('c1', 'one'), tags: ['t'] }, rewrite('r1', 'It go.')],
  };
  await call('POST', '/import', file);

  const exported = await call('GET', '/projects/round-trip/export');
  assert.equal(exported.headers.get('content-disposition'), 'attachment; filename="round-trip.json"');
  assert.deepEqual(exported.body.project, file.project);
  assert.deepEqual(exported.body.exercises[0], {
    key: 'c1', topic: null, tags: ['t'], content: { type: 'flashcard', front: 'one', back: 'b', hint: null, example: null, explanationMarkdown: null },
  });
  assert.deepEqual(exported.body.exercises[1].content, { type: 'rewrite', instruction: 'Fix it.', sourceText: 'It go.', length: 'sentence', constraints: [], modelAnswer: null });

  const again = await call('POST', '/import', exported.body);
  assert.deepEqual(again.body.exercises.unchanged, ['c1', 'r1']);
});

// ---- Exercises ----

const HOWEVER = { topic: 'linking', tags: ['day-2'], content: { type: 'flashcard', front: 'however', back: 'tuy nhiên' } };

test('PUT an exercise needs its project to exist', async () => {
  const reply = await call('PUT', '/projects/nope/exercises/c1', HOWEVER);
  assert.equal(reply.status, 404);
});

test('PUT an exercise: created, then unchanged, then a new version when it really changes', async () => {
  await call('PUT', '/projects/day-2', { name: 'Day 2' });

  const created = await call('PUT', '/projects/day-2/exercises/c1', HOWEVER);
  assert.equal(created.status, 201);
  assert.equal(created.body.projectKey, 'day-2');
  assert.equal(created.body.key, 'c1');
  assert.equal(created.body.version, 1);
  assert.equal(created.body.position, 1);

  const same = await call('PUT', '/projects/day-2/exercises/c1', { key: 'c1', ...HOWEVER });
  assert.equal(same.status, 200);
  assert.equal(same.body.version, 1);
  assert.equal(same.body.updatedAt, created.body.updatedAt);

  const changed = { ...HOWEVER, content: { type: 'flashcard', front: 'however', back: 'tuy nhiên (but)' } };
  const updated = await call('PUT', '/projects/day-2/exercises/c1', changed);
  assert.equal(updated.status, 200);
  assert.equal(updated.body.version, 2);
});

test('a dry-run PUT of an exercise reports the new version and writes nothing', async () => {
  await call('PUT', '/projects/day-3', { name: 'Day 3' });
  await call('PUT', '/projects/day-3/exercises/c1', HOWEVER);

  const changed = { ...HOWEVER, content: { type: 'flashcard', front: 'however', back: 'changed' } };
  const dry = await call('PUT', '/projects/day-3/exercises/c1?dry_run=true', changed);
  assert.equal(dry.body.version, 2);

  const stored = await get('/projects/day-3/exercises/c1');
  assert.equal(stored.version, 1);
  assert.equal(stored.content.back, 'tuy nhiên');
});

test('PUT an exercise: a key that is not the URL key, and a choice with no correct option, are refused', async () => {
  await call('PUT', '/projects/day-4', { name: 'Day 4' });

  const mismatch = await call('PUT', '/projects/day-4/exercises/c1', { key: 'c2', ...HOWEVER });
  assert.deepEqual(problemsOf(mismatch), ['/key key_mismatch']);

  const noCorrect = { content: { type: 'choice', question: 'Q', options: [{ text: 'a', explanationMarkdown: 'b' }, { text: 'c', explanationMarkdown: 'd' }] } };
  const choice = await call('PUT', '/projects/day-4/exercises/c2', noCorrect);
  assert.deepEqual(problemsOf(choice), ['/content/options no_correct_option']);
});

test('the exercise list filters by type and by tag', async () => {
  await call('POST', '/import', fileOf('filters', { ...card('c1', 'one'), tags: ['day-2'] }, rewrite('r1', 'He go.')));

  const rewrites = await get('/projects/filters/exercises?type=rewrite');
  assert.deepEqual(keysOf(rewrites.items), ['r1']);

  const tagged = await get('/projects/filters/exercises?tag=day-2');
  assert.deepEqual(keysOf(tagged.items), ['c1']);

  assert.deepEqual(problemsOf(await call('GET', '/projects/filters/exercises?type=write')), ['?type not_allowed']);
});

test('an unknown exercise is a 404 that names it; a wrong method is a 405 with Allow', async () => {
  await call('PUT', '/projects/day-5', { name: 'Day 5' });

  const missing = await call('GET', '/projects/day-5/exercises/nope');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.message, 'No such exercise "nope" in project "day-5".');

  const wrongMethod = await call('POST', '/projects/day-5/exercises/c1', HOWEVER);
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'GET, PUT, DELETE');
  assert.equal(wrongMethod.body.error.code, 'method_not_allowed');
});

test('an exercise with attempts is deleted only with ?with_attempts=true, and its attempts go with it', async () => {
  await call('POST', '/import', fileOf('deletes', card('c1', 'cheap'), card('c2', 'dear')));
  const attempt = await call('POST', '/projects/deletes/exercises/c1/attempts', { answer: KNEW });

  const refused = await call('DELETE', '/projects/deletes/exercises/c1');
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'has_attempts');
  assert.equal((await call('GET', `/attempts/${attempt.body.id}`)).status, 200);

  const deleted = await call('DELETE', '/projects/deletes/exercises/c1?with_attempts=true');
  assert.equal(deleted.status, 204);
  const again = await call('DELETE', '/projects/deletes/exercises/c1');
  assert.equal(again.status, 404);
  assert.equal((await call('GET', `/attempts/${attempt.body.id}`)).status, 404);
  assert.equal((await call('DELETE', '/projects/deletes/exercises/c2')).status, 204);

  const project = await get('/projects/deletes');
  assert.equal(project.doneCount, 0);
  assert.equal(project.exerciseCount, 0);
});

// ---- Attempts ----

test('a flashcard answer has no grading: its rating is the result, and it records the version it answered', async () => {
  await call('POST', '/import', fileOf('answers', card('c1', 'cheap')));
  const runsBefore = server.claudeRuns().length;

  const answer = { type: 'flashcard', rating: 'almost' };
  const reply = await call('POST', '/projects/answers/exercises/c1/attempts', { answer, timeSpentMs: 900, exerciseVersion: 1 });
  assert.equal(reply.status, 201);
  assert.equal(reply.body.projectKey, 'answers');
  assert.equal(reply.body.exerciseKey, 'c1');
  assert.equal(reply.body.exerciseVersion, 1);
  assert.equal(reply.body.timeSpentMs, 900);
  assert.deepEqual(reply.body.answer, answer);
  assert.deepEqual(reply.body.gradings, []);
  assert.equal(reply.body.exerciseSnapshot.content.front, 'cheap');
  assert.equal(server.claudeRuns().length, runsBefore);

  const exercise = await get('/projects/answers/exercises/c1');
  assert.equal(exercise.isDone, true);
  assert.equal(exercise.attemptCount, 1);
  const { items } = await get('/projects/answers/exercises');
  assert.equal(items[0].lastAttempt.historyLine, 'Almost');
});

test('an answer sent for an old version of the exercise is a 409 exercise_changed', async () => {
  await call('POST', '/import', fileOf('changed', card('c1', 'cheap')));
  await call('POST', '/import', fileOf('changed', card('c1', 'cheap!')));

  const reply = await call('POST', '/projects/changed/exercises/c1/attempts', { answer: KNEW, exerciseVersion: 1 });
  assert.equal(reply.status, 409);
  assert.equal(reply.body.error.code, 'exercise_changed');
});

test('a bad answer, an unknown field or a setting that is not offered is a 400', async () => {
  await call('POST', '/import', fileOf('bad-answers', card('c1', 'cheap')));
  const path = '/projects/bad-answers/exercises/c1/attempts';

  assert.deepEqual(problemsOf(await call('POST', path, { answer: KNEW, colour: 1 })), ['/colour unknown_field']);
  assert.deepEqual(problemsOf(await call('POST', path, { answer: KNEW, writing_ms: 1 })), ['/writing_ms unknown_field']);
  const great = { type: 'flashcard', rating: 'great' };
  assert.deepEqual(problemsOf(await call('POST', path, { answer: great, effort: 'extreme' })), ['/answer wrong_type', '/effort not_allowed']);
  // Rule 1: the answer's type is the exercise's.
  assert.deepEqual(problemsOf(await call('POST', path, { answer: { rating: 'knew' } })), ['/answer wrong_type']);

  const missing = await call('POST', '/projects/bad-answers/exercises/nope/attempts', { answer: KNEW });
  assert.equal(missing.status, 404);
});

test('the attempts list is newest first, filters by exercise, and pages with before', async () => {
  await call('POST', '/import', fileOf('list', card('c1', 'one'), card('c2', 'two')));
  const ids: number[] = [];
  for (const key of ['c1', 'c2', 'c1']) {
    const reply = await call('POST', `/projects/list/exercises/${key}/attempts`, { answer: KNEW });
    ids.push(reply.body.id);
  }
  const [firstId, secondId, thirdId] = ids;

  const all = await get('/attempts?project=list');
  assert.deepEqual(all.items.map((attempt: any) => attempt.id), [thirdId, secondId, firstId]);

  const c1 = await get('/attempts?project=list&exercise=c1');
  assert.deepEqual(c1.items.map((attempt: any) => attempt.id), [thirdId, firstId]);

  const page1 = await get('/attempts?project=list&limit=2');
  assert.equal(page1.items.length, 2);
  assert.equal(page1.nextBefore, secondId);

  const page2 = await get(`/attempts?project=list&limit=2&before=${page1.nextBefore}`);
  assert.deepEqual(page2.items.map((attempt: any) => attempt.id), [firstId]);
  assert.equal(page2.nextBefore, undefined);
});

test('the attempts list filters by the latest grading\'s status, and by time', async () => {
  await call('POST', '/import', fileOf('when', card('c1', 'one'), rewrite('r1', 'It go.')));
  await call('POST', '/projects/when/exercises/c1/attempts', { answer: KNEW });
  const graded = await call('POST', '/projects/when/exercises/r1/attempts', { answer: { type: 'rewrite', text: 'It goes. FAKE:reply=Fine.' } });
  await waitUntilGraded(graded.body.id);
  const today = new Date().toISOString().slice(0, 10);

  const succeeded = await get('/attempts?project=when&status=succeeded');
  assert.deepEqual(succeeded.items.map((attempt: any) => attempt.id), [graded.body.id]);
  assert.equal((await get('/attempts?project=when&status=failed')).items.length, 0);
  assert.equal((await get('/attempts?project=when')).items.length, 2);
  assert.equal((await get(`/attempts?project=when&since=${today}`)).items.length, 2);
  assert.equal((await get('/attempts?project=when&since=2999-01-01')).items.length, 0);
});

test('the attempts list checks its query', async () => {
  assert.deepEqual(problemsOf(await call('GET', '/attempts?exercise=c1')), ['?exercise required']);
  assert.deepEqual(problemsOf(await call('GET', '/attempts?limit=201&before=x&status=done&since=yesterday')), [
    '?status not_allowed',
    '?since wrong_type',
    '?before out_of_range',
    '?limit out_of_range',
  ]);
  const unknownProject = await call('GET', '/attempts?project=nope');
  assert.equal(unknownProject.status, 404);
});

test('an attempt cannot be deleted while it is graded; afterwards it can', async () => {
  await call('POST', '/import', fileOf('grading', rewrite('r1', 'It go.')));
  // The fake claude streams this reply slowly, so the grading is still going when we ask.
  const answer = { type: 'rewrite', text: 'It goes. FAKE:stream=One two three four five six.' };
  const slow = await call('POST', '/projects/grading/exercises/r1/attempts', { answer });
  const attemptId = slow.body.id;

  const refused = await call('DELETE', `/attempts/${attemptId}`);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'grading_in_progress');

  await waitUntilGraded(attemptId);
  const deleted = await call('DELETE', `/attempts/${attemptId}`);
  assert.equal(deleted.status, 204);
  assert.equal((await call('GET', `/attempts/${attemptId}`)).status, 404);
});

test('regrade refuses an unknown field', async () => {
  const reply = await call('POST', '/attempts/1/regrade', { model: 'x' });
  assert.deepEqual(problemsOf(reply), ['/model unknown_field']);
});

async function waitUntilGraded(attemptId: number): Promise<void> {
  for (let tries = 0; tries < 100; tries++) {
    const attempt = await get(`/attempts/${attemptId}`);
    if (attempt.gradings.at(-1).run.status !== 'running') return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`attempt ${attemptId} is still grading`);
}

// ---- Rename, move and order (docs/practice-api-design.md §10) ----

// Answers a flashcard; the attempt's id.
async function answerCard(projectKey: string, exerciseKey: string): Promise<number> {
  const reply = await call('POST', `/projects/${projectKey}/exercises/${exerciseKey}/attempts`, { answer: KNEW });
  assert.equal(reply.status, 201);
  return reply.body.id;
}

test('renaming a project keeps its exercises and attempts', async () => {
  await call('POST', '/import', fileOf('day-1-19-10-2026', card('c1', 'cheap')));
  const attemptId = await answerCard('day-1-19-10-2026', 'c1');

  const reply = await call('POST', '/projects/day-1-19-10-2026/rename', { key: 'm1-day-01-renamed' });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.key, 'm1-day-01-renamed');
  assert.equal(reply.body.exerciseCount, 1);
  assert.equal(reply.body.doneCount, 1);

  assert.equal((await call('GET', '/projects/day-1-19-10-2026')).status, 404);
  assert.deepEqual(keysOf((await get('/projects/m1-day-01-renamed/exercises')).items), ['c1']);
  const attempt = await get(`/attempts/${attemptId}`);
  assert.equal(attempt.projectKey, 'm1-day-01-renamed');
  const listed = await get('/attempts?project=m1-day-01-renamed&exercise=c1');
  assert.deepEqual(listed.items.map((item: any) => item.id), [attemptId]);
});

test('renaming a project: a dry run writes nothing; the same key is no change', async () => {
  await call('POST', '/import', fileOf('rename-dry', card('c1', 'cheap')));

  const dry = await call('POST', '/projects/rename-dry/rename?dry_run=true', { key: 'rename-dry-2' });
  assert.equal(dry.status, 200);
  assert.equal(dry.body.key, 'rename-dry-2');
  assert.equal((await call('GET', '/projects/rename-dry-2')).status, 404);

  const same = await call('POST', '/projects/rename-dry/rename', { key: 'rename-dry' });
  assert.equal(same.status, 200);
  assert.equal(same.body.key, 'rename-dry');
});

test('renaming a project: a taken key is a 409; a bad body or an unknown project is refused', async () => {
  await call('POST', '/import', fileOf('rename-a', card('c1', 'cheap')));
  await call('POST', '/import', fileOf('rename-b', card('c1', 'cheap')));

  const taken = await call('POST', '/projects/rename-a/rename', { key: 'rename-b' });
  assert.equal(taken.status, 409);
  assert.equal(taken.body.error.code, 'key_taken');

  assert.deepEqual(problemsOf(await call('POST', '/projects/rename-a/rename', {})), ['/key required']);
  assert.deepEqual(problemsOf(await call('POST', '/projects/rename-a/rename', { key: 'Bad Key' })), ['/key bad_key']);
  assert.deepEqual(problemsOf(await call('POST', '/projects/rename-a/rename', { key: 'x', name: 'y' })), ['/name unknown_field']);
  assert.deepEqual(problemsOf(await call('POST', '/projects/rename-a/rename?dry_run=yes', { key: 5 })), [
    '?dry_run not_allowed',
    '/key wrong_type',
  ]);

  const missing = await call('POST', '/projects/nope/rename', { key: 'nope-2' });
  assert.equal(missing.status, 404);
});

test('renaming an exercise keeps its attempts, which show the new key', async () => {
  await call('POST', '/import', fileOf('rename-ex', card('c1', 'cheap'), card('c2', 'fast')));
  const attemptId = await answerCard('rename-ex', 'c1');

  const reply = await call('POST', '/projects/rename-ex/exercises/c1/rename', { key: 'cheap-card' });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.key, 'cheap-card');
  assert.equal(reply.body.version, 1);
  assert.equal(reply.body.position, 1);
  assert.equal(reply.body.attemptCount, 1);
  assert.equal(reply.body.isDone, true);

  assert.equal((await call('GET', '/projects/rename-ex/exercises/c1')).status, 404);
  assert.equal((await get(`/attempts/${attemptId}`)).exerciseKey, 'cheap-card');
  const listed = await get('/attempts?project=rename-ex&exercise=cheap-card');
  assert.deepEqual(listed.items.map((item: any) => item.id), [attemptId]);
  assert.equal((await get('/attempts?project=rename-ex&exercise=c1')).items.length, 0);
});

test('renaming an exercise: a dry run writes nothing; a taken key is a 409; a bad body or unknown exercise is refused', async () => {
  await call('POST', '/import', fileOf('rename-ex-2', card('c1', 'cheap'), card('c2', 'fast')));

  const dry = await call('POST', '/projects/rename-ex-2/exercises/c1/rename?dry_run=true', { key: 'c3' });
  assert.equal(dry.status, 200);
  assert.equal(dry.body.key, 'c3');
  assert.deepEqual(keysOf((await get('/projects/rename-ex-2/exercises')).items), ['c1', 'c2']);

  const taken = await call('POST', '/projects/rename-ex-2/exercises/c1/rename', { key: 'c2' });
  assert.equal(taken.status, 409);
  assert.equal(taken.body.error.code, 'key_taken');

  assert.deepEqual(problemsOf(await call('POST', '/projects/rename-ex-2/exercises/c1/rename', { key: '-c' })), ['/key bad_key']);
  const missing = await call('POST', '/projects/rename-ex-2/exercises/nope/rename', { key: 'c9' });
  assert.equal(missing.status, 404);
});

test('moving an exercise takes its attempts to the new project, at the end', async () => {
  await call('POST', '/import', fileOf('move-from', card('c1', 'cheap'), card('c2', 'fast')));
  await call('POST', '/import', fileOf('move-to', card('t1', 'slow')));
  const attemptId = await answerCard('move-from', 'c1');

  const reply = await call('POST', '/projects/move-from/exercises/c1/move', { project: 'move-to' });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.projectKey, 'move-to');
  assert.equal(reply.body.key, 'c1');
  assert.equal(reply.body.version, 1);
  assert.equal(reply.body.attemptCount, 1);

  assert.deepEqual(keysOf((await get('/projects/move-from/exercises')).items), ['c2']);
  assert.deepEqual(keysOf((await get('/projects/move-to/exercises')).items), ['t1', 'c1']);
  assert.equal((await get(`/attempts/${attemptId}`)).projectKey, 'move-to');
  assert.equal((await get('/attempts?project=move-from')).items.length, 0);
  assert.equal((await get('/projects/move-from')).doneCount, 0);
  assert.equal((await get('/projects/move-from')).lastActivityAt, null);
  assert.equal((await get('/projects/move-to')).doneCount, 1);
});

test('moving an exercise: a dry run writes nothing; a taken key is a 409; unknown projects are 404', async () => {
  await call('POST', '/import', fileOf('move-a', card('c1', 'cheap')));
  await call('POST', '/import', fileOf('move-b', card('c1', 'other')));
  await call('POST', '/import', fileOf('move-c', card('c9', 'other')));

  const dry = await call('POST', '/projects/move-a/exercises/c1/move?dry_run=true', { project: 'move-c' });
  assert.equal(dry.status, 200);
  assert.equal(dry.body.projectKey, 'move-c');
  assert.deepEqual(keysOf((await get('/projects/move-c/exercises')).items), ['c9']);

  const taken = await call('POST', '/projects/move-a/exercises/c1/move', { project: 'move-b' });
  assert.equal(taken.status, 409);
  assert.equal(taken.body.error.code, 'key_taken');

  const same = await call('POST', '/projects/move-a/exercises/c1/move', { project: 'move-a' });
  assert.equal(same.status, 200);
  assert.equal(same.body.projectKey, 'move-a');

  assert.equal((await call('POST', '/projects/move-a/exercises/c1/move', { project: 'nope' })).status, 404);
  assert.equal((await call('POST', '/projects/move-a/exercises/nope/move', { project: 'move-c' })).status, 404);
  assert.deepEqual(problemsOf(await call('POST', '/projects/move-a/exercises/c1/move', { key: 'x' })), ['/key unknown_field']);
});

test('PUT the order: the listed keys first, the others keep their order after them', async () => {
  await call('POST', '/import', fileOf('order', card('c1', 'a'), card('c2', 'b'), card('c3', 'c'), card('c4', 'd')));

  const reply = await call('PUT', '/projects/order/order', { keys: ['c3', 'c1'] });
  assert.equal(reply.status, 200);
  assert.deepEqual(keysOf(reply.body.items), ['c3', 'c1', 'c2', 'c4']);
  assert.deepEqual(keysOf((await get('/projects/order/exercises')).items), ['c3', 'c1', 'c2', 'c4']);
  assert.equal((await get('/projects/order/exercises/c2')).position, 3);

  // The same order again changes nothing; the versions never change.
  const again = await call('PUT', '/projects/order/order', { keys: ['c3', 'c1'] });
  assert.deepEqual(keysOf(again.body.items), ['c3', 'c1', 'c2', 'c4']);
  assert.deepEqual(again.body.items.map((item: any) => item.version), [1, 1, 1, 1]);
});

test('PUT the order: a dry run writes nothing; unknown, repeated or missing keys are refused', async () => {
  await call('POST', '/import', fileOf('order-2', card('c1', 'a'), card('c2', 'b')));

  const dry = await call('PUT', '/projects/order-2/order?dry_run=true', { keys: ['c2'] });
  assert.deepEqual(keysOf(dry.body.items), ['c2', 'c1']);
  assert.deepEqual(keysOf((await get('/projects/order-2/exercises')).items), ['c1', 'c2']);

  const bad = await call('PUT', '/projects/order-2/order', { keys: ['c2', 'nope', 'c2', 7] });
  assert.deepEqual(problemsOf(bad), ['/keys/1 unknown_key', '/keys/2 duplicate_key', '/keys/3 wrong_type']);
  assert.deepEqual(problemsOf(await call('PUT', '/projects/order-2/order', {})), ['/keys required']);
  assert.deepEqual(problemsOf(await call('PUT', '/projects/order-2/order', { keys: 'c1' })), ['/keys wrong_type']);
  assert.equal((await call('PUT', '/projects/nope/order', { keys: [] })).status, 404);
  assert.equal((await call('GET', '/projects/order-2/order')).status, 405);
});

test('a re-import puts existing exercises in the order of the file', async () => {
  await call('POST', '/import', fileOf('order-3', card('c1', 'a'), card('c2', 'b'), card('c3', 'c')));
  await call('PUT', '/projects/order-3/exercises/extra', card('extra', 'e'));
  await call('POST', '/import', fileOf('order-3', card('c3', 'c'), card('c1', 'a'), card('c2', 'b')));
  assert.deepEqual(keysOf((await get('/projects/order-3/exercises')).items), ['c3', 'c1', 'c2', 'extra']);
});
