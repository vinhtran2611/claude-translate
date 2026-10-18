// Tests for the grading reply check, the grading prompt and the daily backup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkFeedback, countWords, deriveFields, extractJson, overallBandOf } from '../features/practice/server/feedback-validate.ts';
import { gradingSystemPromptOf, gradingUserMessageOf } from '../features/practice/server/grading.ts';
import { openPracticeStore } from '../features/practice/server/practice-store.ts';
import { backupDaily } from '../shared/server/sqlite.ts';

const GOOD_FEEDBACK = {
  feedback_version: 1, categories_version: 1, summary: 'Meaning is right. Fix the verb.', strengths: ['Good word choice.'],
  errors: [
    { original: 'help', correction: 'helps', category: 'subject_verb_agreement', severity: 'major', explanation: 'One activity.', rule: '-ing subject + verb-s.' },
    { original: 'foreign language', correction: 'a foreign language', category: 'article', severity: 'minor', explanation: 'Countable.', rule: 'a + countable noun.' },
  ],
  corrected_text: 'Learning a foreign language early helps children.', natural_version: 'Learning a foreign language early helps children.',
  meaning: 'complete', remember: ['-ing subject takes verb-s.'],
};

test('extractJson finds the object in a bare reply, a code fence, or surrounding text', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Here it is: {"a":1} hope it helps'), { a: 1 });
  assert.equal(extractJson('no json here'), null);
});

test('good feedback passes, keeps only known fields, and derives the counts', () => {
  const { feedback, problems } = checkFeedback({ ...GOOD_FEEDBACK, extra: 'dropped' }, 'sentence_translation');
  assert.deepEqual(problems, []);
  assert.ok(feedback);
  assert.equal('extra' in feedback, false);
  assert.deepEqual(deriveFields(feedback), { error_count: 2, major_error_count: 1, overall_band: null });
});

test('bad feedback lists each problem', () => {
  const bad = { ...GOOD_FEEDBACK, summary: '', meaning: 'perfect', errors: [{ ...GOOD_FEEDBACK.errors[0], category: 'grammar', severity: 'huge' }] };
  const { feedback, problems } = checkFeedback(bad, 'sentence_translation');
  assert.equal(feedback, null);
  assert.deepEqual(problems, [
    'summary must be a non-empty string',
    'errors[0].category is not a known category',
    'errors[0].severity must be major or minor',
    'meaning must be one of complete, minor_loss, major_loss',
  ]);
});

test('no errors is valid feedback', () => {
  assert.deepEqual(checkFeedback({ ...GOOD_FEEDBACK, errors: [] }, 'paragraph_translation').problems, []);
});

test('countWords counts runs of non-space characters', () => {
  assert.equal(countWords('  Learning a foreign\nlanguage. '), 4);
  assert.equal(countWords('   '), 0);
});

test('the grading prompt has the core rules, the type part, the format and every category', () => {
  const prompt = gradingSystemPromptOf('paragraph_translation');
  assert.match(prompt, /<role>/);
  assert.match(prompt, /paragraph_translation: the learner translated/);
  assert.match(prompt, /<output_format>/);
  assert.match(prompt, /- subject_verb_agreement: verb does not match its subject/);
  assert.doesNotMatch(prompt, /\{\{/);
  const message = gradingUserMessageOf({ id: 'w01-s01', type: 'sentence_translation', text_vi: 'Xin chào.' }, { text: 'Hello.' }, 1);
  assert.match(message, /^Grade this answer\. Exercise type: sentence_translation\./);
  assert.doesNotMatch(message, /w01-s01/);
  assert.match(message, /<answer word_count="1">\nHello\.\n<\/answer>$/);
});

test('a server stopped mid-grading leaves no attempt stuck in grading', () => {
  const database_path = join(mkdtempSync(join(tmpdir(), 'practice-store-')), 'practice.sqlite');
  const store = openPracticeStore(database_path);
  store.importExercises([{ id: 's1', type: 'sentence_translation', text_vi: 'Xin chào.' }], 'test.json');
  const attempt_id = store.createAttempt({
    exercise: { id: 's1', type: 'sentence_translation', text_vi: 'Xin chào.' }, answer: { text: 'Hello.' }, word_count: 1, writing_ms: 1000,
    requested_model_id: 'claude-sonnet-5-5', effort: 'low',
  });
  const reopened_store = openPracticeStore(database_path);
  assert.equal(reopened_store.failInterruptedGradings(), 1);
  const attempt = reopened_store.readAttempt(attempt_id);
  assert.equal(attempt?.status, 'failed');
  assert.equal(attempt?.error_kind, 'interrupted');
  assert.equal(attempt?.answer.text, 'Hello.');
  assert.equal(reopened_store.restartGrading(attempt_id), true);
  assert.equal(reopened_store.restartGrading(attempt_id), false);
});

test('backupDaily makes one copy a day and keeps the newest 30', () => {
  const directory = mkdtempSync(join(tmpdir(), 'backup-'));
  const database_path = join(directory, 'practice.sqlite');
  const database = new DatabaseSync(database_path);
  database.exec('CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (42)');
  database.close();
  const backups_directory = join(directory, 'backups');
  const first = backupDaily(database_path, backups_directory, 'practice', new Date(2026, 9, 18));
  assert.ok(first);
  assert.equal(backupDaily(database_path, backups_directory, 'practice', new Date(2026, 9, 18)), null);
  const copy = new DatabaseSync(first, { readOnly: true });
  assert.deepEqual({ ...copy.prepare('SELECT x FROM t').get() }, { x: 42 });
  copy.close();
  for (let day = 1; day <= 31; day++) writeFileSync(join(backups_directory, `practice-2026-08-${String(day).padStart(2, '0')}.sqlite`), '');
  backupDaily(database_path, backups_directory, 'practice', new Date(2026, 9, 19));
  const kept = readdirSync(backups_directory).sort();
  assert.equal(kept.length, 30);
  assert.equal(kept.at(-1), 'practice-2026-10-19.sqlite');
  assert.equal(backupDaily(join(directory, 'missing.sqlite'), backups_directory, 'missing'), null);
});

const criterion = (band: unknown) => ({ band, comment: 'Why.', next_step: 'Do this.' });

test('free writing needs all 4 bands in steps of 0.5; essay translation only the 2 language ones', () => {
  const base = { ...GOOD_FEEDBACK, natural_version: undefined, meaning: undefined };
  const four = { task_response: criterion(6), coherence_cohesion: criterion(6.5), lexical_resource: criterion(7), grammatical_range_accuracy: criterion(5.5) };
  const free = checkFeedback({ ...base, bands: four }, 'free_writing');
  assert.deepEqual(free.problems, []);
  assert.equal(free.feedback?.meaning, undefined);
  assert.deepEqual(checkFeedback({ ...base, bands: { ...four, task_response: criterion(6.3) } }, 'free_writing').problems,
    ['bands.task_response.band must be 0 to 9 in steps of 0.5']);
  assert.deepEqual(checkFeedback({ ...base, bands: { lexical_resource: criterion(7) } }, 'free_writing').problems,
    ['bands.task_response is required', 'bands.coherence_cohesion is required', 'bands.grammatical_range_accuracy is required']);
  const essay = checkFeedback({
    ...base, meaning: 'complete', corrected_prompt_text: 'Task.', bands: four,
    errors: GOOD_FEEDBACK.errors.map((error) => ({ ...error, part: 'essay' })),
  }, 'essay_translation');
  assert.deepEqual(essay.problems, []);
  assert.deepEqual(Object.keys(essay.feedback?.bands ?? {}), ['lexical_resource', 'grammatical_range_accuracy']);
  assert.deepEqual(checkFeedback({ ...base, meaning: 'complete', corrected_prompt_text: 'Task.', bands: four }, 'essay_translation').problems,
    ['errors[0].part must be prompt or essay', 'errors[1].part must be prompt or essay']);
});

test('the overall band is the mean of 4 criteria rounded down to 0.5, and only for free writing', () => {
  const bands = (a: number, b: number, c: number, d: number) => ({
    task_response: criterion(a), coherence_cohesion: criterion(b), lexical_resource: criterion(c), grammatical_range_accuracy: criterion(d),
  }) as never;
  assert.equal(overallBandOf(bands(6, 6.5, 6.5, 6.5)), 6);
  assert.equal(overallBandOf(bands(7, 7, 7, 6.5)), 6.5);
  assert.equal(overallBandOf(bands(7, 7, 7, 7)), 7);
  assert.equal(overallBandOf({ lexical_resource: criterion(7), grammatical_range_accuracy: criterion(7) } as never), null);
  assert.equal(overallBandOf(undefined), null);
});

test('the free writing message leaves out the sample essay; essay translation sends both parts', () => {
  const free = gradingUserMessageOf({ id: 'f1', type: 'free_writing', prompt_en: 'Discuss.', essay_type: 'opinion', sample_essay_en: 'SAMPLE TEXT' }, { text: 'Mine.' }, 1);
  assert.doesNotMatch(free, /SAMPLE TEXT/);
  const essay = gradingUserMessageOf({ id: 'e1', type: 'essay_translation', prompt_vi: 'Đề.', essay_vi: 'Bài.' }, { text: 'Essay.', prompt_text: 'Task.' }, 1);
  assert.match(essay, /<answer_prompt>\nTask\.\n<\/answer_prompt>\n\n<answer_essay word_count="1">\nEssay\.\n<\/answer_essay>$/);
  assert.match(gradingSystemPromptOf('free_writing'), /Do not add an overall band/);
  assert.match(gradingSystemPromptOf('essay_translation'), /"part": "prompt or essay"/);
});

test('error correction needs one key result per planted mistake, in order', () => {
  const base = { ...GOOD_FEEDBACK, natural_version: undefined, meaning: undefined };
  const results = [
    { mistake_index: 0, status: 'fixed', learner_text: 'many students', comment: '' },
    { mistake_index: 1, status: 'partly', learner_text: 'make', comment: 'Still plural.' },
  ];
  const good = checkFeedback({ ...base, key_results: results }, 'error_correction', 2);
  assert.deepEqual(good.problems, []);
  assert.deepEqual(good.feedback?.key_results, [
    { mistake_index: 0, status: 'fixed', learner_text: 'many students' },
    { mistake_index: 1, status: 'partly', learner_text: 'make', comment: 'Still plural.' },
  ]);
  assert.deepEqual(checkFeedback({ ...base, key_results: results }, 'error_correction', 3).problems,
    ['key_results must be a list of 3, one per planted mistake']);
  assert.deepEqual(checkFeedback({ ...base, key_results: [{ ...results[1], mistake_index: 1 }, { ...results[0], status: 'done', mistake_index: 0 }] }, 'error_correction', 2).problems,
    ['key_results[0].mistake_index must be 0', 'key_results[1].mistake_index must be 1', 'key_results[1].status must be fixed, partly or missed']);
  assert.match(gradingSystemPromptOf('error_correction'), /"key_results" has exactly one entry per planted mistake/);
});
