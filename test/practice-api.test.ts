// Practice's key-addressed API (docs/practice-api-design.md §3) through the real server, with a fake claude.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, type TestServer } from './server-harness.ts';

let server: TestServer;
before(async () => { server = await startTestServer(); });
after(async () => { await server.stop(); });

const send = (method: string, path: string, body?: unknown) => fetch(`${server.base_url}/api/practice${path}`, body === undefined ? { method } : {
  method, headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
});
// [status, body] of a request; body is null for an empty answer.
async function call(method: string, path: string, body?: unknown): Promise<[number, any]> {
  const response = await send(method, path, body);
  const text = await response.text();
  return [response.status, text === '' ? null : JSON.parse(text)];
}
const get = async (path: string) => (await call('GET', path))[1];
const codesOf = (body: any) => body.error.problems.map(({ path, code }: { path: string; code: string }) => [path, code]);

const card = (key: string, front: string, extra: object = {}) => ({ key, type: 'flashcard', content: { front, back: 'b' }, ...extra });
const rewrite = (key: string, text: string) => ({ key, type: 'rewrite', topic: 'transport', content: { instruction: 'Fix it.', text, length: 'sentence' } });
const fileOf = (key: string, ...exercises: object[]) => ({ format: 3, project: { key, name: `Project ${key}` }, exercises });

test('the index and the schemas tell an agent what is there and the rules', async () => {
  const index = await get('');
  assert.deepEqual([index.api, index.version, index.types, index.limits.key_pattern, index.limits.attempts_page_max], [
    'practice', 3, ['rewrite', 'write', 'choice', 'fill', 'flashcard'], '^[a-z0-9][a-z0-9-]{0,63}$', 200,
  ]);
  const exercise = await get('/schemas/exercise.json');
  assert.equal(exercise.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(exercise.oneOf.length, 5);
  const flashcard = exercise.$defs.flashcard;
  assert.deepEqual([flashcard.additionalProperties, flashcard.required, flashcard.properties.type], [false, ['key', 'type', 'content'], { const: 'flashcard' }]);
  assert.deepEqual(flashcard.properties.content.required, ['front', 'back']);
  assert.deepEqual(flashcard.properties.content.properties.explanation, {
    type: 'string', minLength: 1, maxLength: 5000, description: 'Markdown, up to 5,000 characters: the concept and a worked explanation, rendered under the answer.',
  });
  assert.match(exercise.$defs.choice.description, /At least one option has correct: true/);
  assert.deepEqual(exercise.$defs.fill.properties.content.properties.gaps.items.properties.answer.oneOf[1].maxItems, 10);
  const file = await get('/schemas/import.json');
  assert.deepEqual([file.properties.format, file.properties.exercises.items, file.properties.project.required], [{ const: 3 }, { $ref: 'exercise.json' }, ['key', 'name']]);
  assert.deepEqual(await call('GET', '/schemas/nope.json'), [404, { error: { code: 'not_found', message: 'No such schema "nope".' } }]);
});

test('import: created, then the same file again is unchanged, a fixed file updates in place; a dry run writes nothing', async () => {
  const file = fileOf('m1-day-01', card('d1-card-1', 'cheap'), rewrite('d1-fix-1', 'It go.'));
  const [dry_status, dry] = await call('POST', '/import?dry_run=true', file);
  assert.deepEqual([dry_status, dry.dry_run, dry.project_change, dry.exercises], [200, true, 'created', { created: ['d1-card-1', 'd1-fix-1'], updated: [], unchanged: [] }]);
  assert.deepEqual(await call('GET', '/projects/m1-day-01'), [404, { error: { code: 'not_found', message: 'No such project "m1-day-01".' } }]);
  const [status, first] = await call('POST', '/import', file);
  assert.deepEqual([status, first.dry_run, first.project_change, first.project.key, first.project.exercise_count], [200, false, 'created', 'm1-day-01', 2]);
  const [, again] = await call('POST', '/import', file);
  assert.deepEqual([again.project_change, again.exercises], ['unchanged', { created: [], updated: [], unchanged: ['d1-card-1', 'd1-fix-1'] }]);
  const fixed = fileOf('m1-day-01', card('d1-card-1', 'cheap'), rewrite('d1-fix-1', 'It go home.'), card('d1-card-2', 'expensive'));
  const [, update] = await call('POST', '/import', fixed);
  assert.deepEqual(update.exercises, { created: ['d1-card-2'], updated: ['d1-fix-1'], unchanged: ['d1-card-1'] });
  assert.deepEqual((await get('/projects/m1-day-01/exercises')).items.map(({ key, version }: any) => [key, version]), [['d1-card-1', 1], ['d1-fix-1', 2], ['d1-card-2', 1]]);
});

test('import refuses a bad file with every problem, a format 2 file with the edits to make, and a body over the limit', async () => {
  const bad = fileOf('bad', card('a', ' '), card('a', 'x', { colour: 'red' }));
  const [status, body] = await call('POST', '/import', bad);
  assert.equal(status, 400);
  assert.deepEqual(codesOf(body), [['/exercises/0/content/front', 'empty'], ['/exercises/1/colour', 'unknown_field'], ['/exercises/1/key', 'duplicate_key']]);
  assert.equal(body.error.message, 'The request has 3 problems.');
  const [, old] = await call('POST', '/import', { format: 2, project: { name: 'Old' }, exercises: [{ id: 'a', type: 'flashcard', content: { front: 'f', back: 'b' } }] });
  assert.equal(old.error.problems[0].code, 'unsupported_format');
  assert.match(old.error.problems[0].message, /rename each exercise's "id" to "key"/);
  assert.equal((await call('POST', '/import', '{"format": 3,')).at(1).error.code, 'bad_json');
  const huge = `${JSON.stringify(fileOf('huge', card('a', 'f')))}${' '.repeat(2_000_000)}`;
  assert.deepEqual((await call('POST', '/import', huge)).map((part, index) => (index === 1 ? part.error.code : part)), [413, 'too_large']);
  assert.deepEqual(codesOf((await call('POST', '/import?dryrun=true', fileOf('x', card('a', 'f'))))[1]), [['?dryrun', 'unknown_parameter']]);
  assert.deepEqual(codesOf((await call('POST', '/import?dry_run=yes', fileOf('x', card('a', 'f'))))[1]), [['?dry_run', 'not_allowed']]);
  assert.deepEqual((await get('/projects')).items.filter(({ key }: any) => ['bad', 'huge', 'x'].includes(key)), []);
});

test('PUT a project: created, then the same again changes nothing; archive hides it; the key must be valid', async () => {
  const [created_status, created] = await call('PUT', '/projects/week-2', { name: ' Week 2 ', description: 'Linking words' });
  assert.deepEqual([created_status, created.key, created.name, created.description, created.archived, created.exercise_count], [201, 'week-2', 'Week 2', 'Linking words', false, 0]);
  const [same_status, same] = await call('PUT', '/projects/week-2', { name: 'Week 2', description: 'Linking words' });
  assert.deepEqual([same_status, same.updated_at], [200, created.updated_at]);
  const [, archived] = await call('PUT', '/projects/week-2', { name: 'Week 2', description: 'Linking words', archived: true });
  assert.equal(archived.archived, true);
  assert.equal((await get('/projects')).items.some(({ key }: any) => key === 'week-2'), false);
  assert.equal((await get('/projects?archived=true')).items.some(({ key }: any) => key === 'week-2'), true);
  assert.equal((await get('/projects?archived=all')).items.some(({ key }: any) => key === 'week-2'), true);
  assert.deepEqual(codesOf((await call('GET', '/projects?archived=maybe'))[1]), [['?archived', 'not_allowed']]);
  assert.deepEqual(codesOf((await call('PUT', '/projects/Week_2', { name: 'x' }))[1]), [['#key', 'bad_key']]);
  assert.deepEqual(codesOf((await call('PUT', '/projects/week-3', { title: 'x' }))[1]), [['/title', 'unknown_field'], ['/name', 'required']]);
  assert.deepEqual(await call('PUT', '/projects/week-3?dry_run=true', { name: 'Week 3' }).then(([status, body]) => [status, body.key]), [201, 'week-3']);
  assert.equal((await call('GET', '/projects/week-3'))[0], 404);
});

test('PUT an exercise: 404 without its project, then created, unchanged, and a new version when it really changes', async () => {
  const exercise = { type: 'flashcard', topic: 'linking', tags: ['day-2'], content: { front: 'however', back: 'tuy nhiên' } };
  assert.deepEqual((await call('PUT', '/projects/nope/exercises/c1', exercise))[0], 404);
  await call('PUT', '/projects/day-2', { name: 'Day 2' });
  const [created_status, created] = await call('PUT', '/projects/day-2/exercises/c1', exercise);
  assert.deepEqual([created_status, created.project, created.key, created.version, created.position, created.done, created.attempt_count], [201, 'day-2', 'c1', 1, 1, false, 0]);
  const [same_status, same] = await call('PUT', '/projects/day-2/exercises/c1', { key: 'c1', ...exercise });
  assert.deepEqual([same_status, same.version, same.updated_at], [200, 1, created.updated_at]);
  const changed = { ...exercise, content: { ...exercise.content, back: 'tuy nhiên (but)' } };
  assert.equal((await call('PUT', '/projects/day-2/exercises/c1?dry_run=true', changed))[1].version, 2);
  assert.equal((await get('/projects/day-2/exercises/c1')).version, 1);
  assert.deepEqual((await call('PUT', '/projects/day-2/exercises/c1', changed)).map((part, index) => (index === 1 ? part.version : part)), [200, 2]);
  assert.deepEqual((await get('/projects/day-2/exercises/c1')).content, changed.content);
  assert.deepEqual(codesOf((await call('PUT', '/projects/day-2/exercises/c1', { key: 'c2', ...exercise }))[1]), [['/key', 'key_mismatch']]);
  assert.deepEqual(codesOf((await call('PUT', '/projects/day-2/exercises/c2', { type: 'choice', content: { question: 'Q', options: [{ text: 'a', why: 'b' }, { text: 'c', why: 'd' }] } }))[1]),
    [['/content/options', 'no_correct_option']]);
  await call('PUT', '/projects/day-2/exercises/r1', { type: 'rewrite', content: { instruction: 'Fix it.', text: 'He go.', length: 'sentence' } });
  assert.deepEqual((await get('/projects/day-2/exercises?type=rewrite')).items.map(({ key }: any) => key), ['r1']);
  assert.deepEqual((await get('/projects/day-2/exercises?tag=day-2')).items.map(({ key }: any) => key), ['c1']);
  assert.deepEqual(codesOf((await call('GET', '/projects/day-2/exercises?type=essay'))[1]), [['?type', 'not_allowed']]);
  assert.deepEqual((await call('GET', '/projects/day-2/exercises/nope'))[1].error, { code: 'not_found', message: 'No such exercise "nope" in project "day-2".' });
  const wrong = await send('POST', '/projects/day-2/exercises/c1', exercise);
  assert.deepEqual([wrong.status, wrong.headers.get('allow'), (await wrong.json()).error.code], [405, 'GET, PUT, DELETE', 'method_not_allowed']);
});

test('answering: an attempt records the version; an old version is a 409; bad answers and unknown fields are a 400', async () => {
  await call('POST', '/import', fileOf('answers', card('c1', 'cheap'), rewrite('r1', 'It go.')));
  const runs_before = server.claudeRuns().length;
  const [status, attempt] = await call('POST', '/projects/answers/exercises/c1/attempts', { answer: { rating: 'almost' }, writing_ms: 900, exercise_version: 1 });
  assert.deepEqual([status, attempt.project, attempt.exercise, attempt.exercise_version, attempt.exercise_deleted, attempt.status, attempt.summary, attempt.snapshot.content.front],
    [201, 'answers', 'c1', 1, false, 'graded', 'Almost', 'cheap']);
  assert.equal(server.claudeRuns().length, runs_before);
  await call('POST', '/import', fileOf('answers', card('c1', 'cheap!'), rewrite('r1', 'It go.')));
  const [changed_status, changed] = await call('POST', '/projects/answers/exercises/c1/attempts', { answer: { rating: 'known' }, exercise_version: 1 });
  assert.deepEqual([changed_status, changed.error.code], [409, 'exercise_changed']);
  assert.deepEqual(codesOf((await call('POST', '/projects/answers/exercises/c1/attempts', { answer: { rating: 'great' }, colour: 1 }))[1]), [['/colour', 'unknown_field']]);
  assert.deepEqual(codesOf((await call('POST', '/projects/answers/exercises/c1/attempts', { answer: { rating: 'great' }, effort: 'extreme' }))[1]), [['/answer', 'wrong_type'], ['/effort', 'not_allowed']]);
  assert.equal((await call('POST', '/projects/answers/exercises/nope/attempts', { answer: { rating: 'known' } }))[0], 404);
  const exercise = await get('/projects/answers/exercises/c1');
  assert.deepEqual([exercise.version, exercise.done, exercise.attempt_count], [2, true, 1]);
  const [, graded] = await call('POST', '/projects/answers/exercises/r1/attempts', { answer: { text: 'It goes. FAKE:reply=Good.' } });
  assert.equal(graded.status, 'grading');
});

test('deleting an exercise keeps its attempts readable and listed by its key', async () => {
  await call('POST', '/import', fileOf('deletes', card('c1', 'cheap'), card('c2', 'dear')));
  const [, attempt] = await call('POST', '/projects/deletes/exercises/c1/attempts', { answer: { rating: 'known' } });
  assert.deepEqual(await call('DELETE', '/projects/deletes/exercises/c1'), [204, null]);
  assert.equal((await call('DELETE', '/projects/deletes/exercises/c1'))[0], 404);
  const kept = await get(`/attempts/${attempt.id}`);
  assert.deepEqual([kept.exercise, kept.exercise_deleted, kept.snapshot.content.front, kept.answer], ['c1', true, 'cheap', { rating: 'known' }]);
  assert.deepEqual((await get('/attempts?project=deletes&exercise=c1')).items.map(({ id }: any) => id), [attempt.id]);
  assert.deepEqual((await get('/projects/deletes')).done_count, 0);
  assert.deepEqual((await get('/projects/deletes/exercises')).items.map(({ key }: any) => key), ['c2']);
});

test('the attempts list: filters, newest first, pages by before; and its query is checked', async () => {
  await call('POST', '/import', fileOf('list', card('c1', 'one'), card('c2', 'two')));
  const ids: number[] = [];
  for (const key of ['c1', 'c2', 'c1']) ids.push((await call('POST', `/projects/list/exercises/${key}/attempts`, { answer: { rating: 'known' } }))[1].id);
  assert.deepEqual((await get('/attempts?project=list')).items.map(({ id }: any) => id), [...ids].reverse());
  assert.deepEqual((await get('/attempts?project=list&exercise=c1')).items.map(({ id }: any) => id), [ids[2], ids[0]]);
  const first = await get('/attempts?project=list&limit=2');
  assert.deepEqual([first.items.length, first.next_before], [2, ids[1]]);
  const second = await get(`/attempts?project=list&limit=2&before=${first.next_before}`);
  assert.deepEqual([second.items.map(({ id }: any) => id), second.next_before], [[ids[0]], undefined]);
  assert.deepEqual((await get('/attempts?project=list&status=failed')).items, []);
  assert.equal((await get(`/attempts?project=list&since=${new Date().toISOString().slice(0, 10)}`)).items.length, 3);
  assert.deepEqual((await get('/attempts?project=list&since=2999-01-01')).items, []);
  assert.deepEqual(codesOf((await call('GET', '/attempts?exercise=c1'))[1]), [['?exercise', 'required']]);
  assert.deepEqual(codesOf((await call('GET', '/attempts?limit=201&before=x&status=done&since=yesterday'))[1]),
    [['?status', 'not_allowed'], ['?since', 'wrong_type'], ['?before', 'out_of_range'], ['?limit', 'out_of_range']]);
  assert.deepEqual((await call('GET', '/attempts?project=nope'))[0], 404);
});

test('deleting an attempt: refused while it grades, then gone', async () => {
  await call('POST', '/import', fileOf('grading', rewrite('r1', 'It go.')));
  const [, slow] = await call('POST', '/projects/grading/exercises/r1/attempts', { answer: { text: 'It goes. FAKE:stream=One two three four five six.' } });
  assert.deepEqual((await call('DELETE', `/attempts/${slow.id}`)).map((part, index) => (index === 1 ? part.error.code : part)), [409, 'grading_in_progress']);
  for (let tries = 0; tries < 100 && (await get(`/attempts/${slow.id}`)).status === 'grading'; tries++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(await call('DELETE', `/attempts/${slow.id}`), [204, null]);
  assert.equal((await call('GET', `/attempts/${slow.id}`))[0], 404);
  assert.deepEqual(codesOf((await call('POST', '/attempts/1/regrade', { model: 'x' }))[1]), [['/model', 'unknown_field']]);
});

test('deleting a project with attempts needs ?with_attempts=true; export gives back a file that imports unchanged', async () => {
  const file = { format: 3, project: { key: 'gone', name: 'Gone', description: 'Soon' }, exercises: [card('c1', 'one', { tags: ['t'] }), rewrite('r1', 'It go.')] };
  await call('POST', '/import', file);
  const exported = await send('GET', '/projects/gone/export');
  assert.equal(exported.headers.get('content-disposition'), 'attachment; filename="gone.json"');
  const exported_file = await exported.json();
  assert.deepEqual(exported_file, file);
  assert.deepEqual((await call('POST', '/import', exported_file))[1].exercises.unchanged, ['c1', 'r1']);
  await call('POST', '/projects/gone/exercises/c1/attempts', { answer: { rating: 'known' } });
  const [refused_status, refused] = await call('DELETE', '/projects/gone');
  assert.deepEqual([refused_status, refused.error.code], [409, 'has_attempts']);
  assert.equal((await call('GET', '/projects/gone'))[0], 200);
  assert.deepEqual(await call('DELETE', '/projects/gone?with_attempts=true'), [204, null]);
  assert.deepEqual((await call('GET', '/projects/gone'))[0], 404);
  assert.deepEqual((await get('/attempts?limit=200')).items.filter(({ project }: any) => project === 'gone'), []);
  assert.equal((await call('GET', '/projects/gone/export'))[0], 404);
  // A project with no attempts goes in one call.
  await call('PUT', '/projects/empty', { name: 'Empty' });
  assert.deepEqual(await call('DELETE', '/projects/empty'), [204, null]);
});
