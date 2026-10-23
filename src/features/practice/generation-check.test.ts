// Making a project from a post (generation-check.ts): the plan, the message, and the check of the reply. The owner's
// hand-made sample is read from test/fixtures/practice/ and checked as if the model had written it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkReply, planOf, postWordCount, projectFileOf, projectKeyOf, userMessageOf, type GenerationPlan } from './generation-check.ts';

const SAMPLE = JSON.parse(readFileSync(new URL('../../../test/fixtures/practice/t-24-php-security.json', import.meta.url), 'utf8'));
const FULL_PLAN = planOf(1_860);

// The sample's exercises as a reply: what the model is asked to write.
function sampleReply(exercises: unknown[] = SAMPLE.exercises): string {
  return JSON.stringify({ name: 'PHP Security Release (Oct 2026)', topic: 'security', exercises });
}

// A copy of the sample's exercises, so a test can break one.
function sampleExercises() {
  return structuredClone(SAMPLE.exercises) as typeof SAMPLE.exercises;
}

function goodReplyOf(reply: string, plan: GenerationPlan = FULL_PLAN) {
  const checked = checkReply(reply, plan);
  assert.equal(checked.problem, null);
  return checked.reply!;
}

test('the plan: 37 words an exercise, from 10 to 50, split 18:10:13:9', () => {
  assert.deepEqual(planOf(1_860), { total: 50, flashcard: 18, vocab: 10, grammar: 13, meaning: 9 });
  assert.deepEqual(planOf(740), { total: 20, flashcard: 7, vocab: 4, grammar: 5, meaning: 4 });
  // 3.6 / 2 / 2.6 / 1.8: the largest remainders are meaning's, then flashcard's (listed before grammar's equal one).
  assert.deepEqual(planOf(370), { total: 10, flashcard: 4, vocab: 2, grammar: 2, meaning: 2 });
  assert.equal(planOf(150).total, 10);
  assert.equal(planOf(10_000).total, 50);
  for (const words of [150, 400, 999, 1_234, 1_700, 5_000]) {
    const plan = planOf(words);
    assert.equal(plan.flashcard + plan.vocab + plan.grammar + plan.meaning, plan.total, String(words));
  }
});

test('the message holds the plan and every block, English and Vietnamese', () => {
  const blocks = [
    { sourceText: 'Hello world.', translatedText: 'Xin chào thế giới.' },
    { sourceText: 'Second block.', translatedText: 'Khối thứ hai.' },
  ];
  assert.equal(postWordCount(blocks), 4);
  const message = userMessageOf({ translationId: 24, title: 'A "quoted" title', blocks }, planOf(370));
  assert.match(message, /^Make exercises from this post\.\n/);
  assert.match(message, /<plan total="10" flashcard="4" vocab="2" grammar="2" meaning="2"\/>/);
  assert.match(message, /<post title="A &quot;quoted&quot; title" translation_id="24">/);
  assert.match(message, /<block n="2"><en>Second block\.<\/en><vi>Khối thứ hai\.<\/vi><\/block>\n<\/post>$/);
});

test('the sample, as a reply, keeps all 50 exercises; three meaning answers give no Vietnamese', () => {
  const reply = goodReplyOf(sampleReply());
  assert.equal(reply.exercises.length, 50);
  assert.equal(reply.droppedCount, 0);
  assert.deepEqual(reply.droppedLines, []);
  const noVietnamese = ['me-7-post-about', 'me-8-defenders-attackers', 'me-9-without-funding'];
  assert.deepEqual(reply.warnings, noVietnamese.map((key) => `${key}: no Vietnamese in the gloss.`));
  assert.equal(reply.name, 'PHP Security Release (Oct 2026)');
  assert.equal(reply.exercises[0].key, 'fc-1-right-conditions');
  assert.equal(reply.exercises[0].content.type, 'flashcard');
});

test('an exercise without a topic takes the reply\'s', () => {
  const exercises = sampleExercises();
  delete exercises[0].topic;
  const reply = goodReplyOf(sampleReply(exercises));
  assert.equal(reply.exercises[0].topic, 'security');
});

test('a bad exercise is dropped and named: 3 options, 2 correct, a duplicate key, another type', () => {
  const exercises = sampleExercises();
  exercises[18].content.options.pop();
  exercises[19].content.options[1].isCorrect = true;
  exercises[20].key = exercises[21].key;
  exercises[22].content = { type: 'gap_fill', textWithGaps: 'A {{1}}.', gaps: [{ acceptedAnswers: ['b'] }] };
  exercises[23].tags = ['grammar:article'];
  const reply = goodReplyOf(sampleReply(exercises));
  assert.equal(reply.exercises.length, 45);
  assert.equal(reply.droppedCount, 5);
  assert.deepEqual(reply.droppedLines, [
    'Exercise 19 (choice, vo-1-execute-code): content.options: must be 4 options (found 3).',
    'Exercise 20 (choice, vo-2-alike): content.options: exactly one must be correct (found 2).',
    'Exercise 22 (choice, vo-4-addressed): key "vo-4-addressed" is used twice.',
    'Exercise 23 (gap_fill, vo-5-ahead-of): content.type must be flashcard or choice.',
    'Exercise 24 (choice, vo-6-circulating): tags[0] must be vocab, grammar or meaning.',
  ]);
  assert.ok(reply.warnings.includes('5 vocab exercises, 10 planned.'));
});

test('a flashcard must be tagged vocab; two options with the same text are dropped', () => {
  const exercises = sampleExercises();
  exercises[0].tags = ['grammar', 'grammar:article'];
  exercises[18].content.options[1].text = 'Execute ';
  const reply = goodReplyOf(sampleReply(exercises));
  assert.equal(reply.droppedCount, 2);
  assert.match(reply.droppedLines[0], /^Exercise 1 \(flashcard, fc-1-right-conditions\): tags\[0\] must be vocab\.$/);
  assert.match(reply.droppedLines[1], /two options have the same text/);
});

test('warnings: the mix, too few grammar points, a gloss without Vietnamese', () => {
  const exercises = sampleExercises();
  for (const exercise of exercises) {
    if (exercise.tags[0] === 'grammar') exercise.tags[1] = 'grammar:tense';
  }
  exercises[0].content.back = 'under the right conditions: only when certain things are true';
  // The last five meaning exercises left out, the three without Vietnamese among them.
  const reply = goodReplyOf(sampleReply(exercises.slice(0, 45)));
  const expected = [
    '4 meaning exercises, 9 planned.',
    'Only 1 distinct grammar tags.',
    'fc-1-right-conditions: no Vietnamese in the gloss.',
  ];
  assert.deepEqual(reply.warnings, expected);
});

test('a reply in a ```json fence is read; a reply that is not the JSON object fails', () => {
  const fenced = `\n\`\`\`json\n${sampleReply()}\n\`\`\`\n`;
  assert.equal(goodReplyOf(fenced).exercises.length, 50);
  const notJson = checkReply('Here are your exercises: ...', FULL_PLAN);
  assert.equal(notJson.reply, null);
  assert.equal(notJson.problem, 'The reply is not a JSON object with name, topic and exercises.');
  assert.equal(checkReply(JSON.stringify({ name: 'x', topic: 'y' }), FULL_PLAN).reply, null);
  assert.equal(checkReply(JSON.stringify([]), FULL_PLAN).reply, null);
});

test('fewer than 80% of the plan kept fails the run, naming the first three problems', () => {
  // 40 of 50 is exactly 80%: kept.
  assert.equal(goodReplyOf(sampleReply(SAMPLE.exercises.slice(0, 40))).exercises.length, 40);
  const exercises = sampleExercises().slice(0, 40);
  exercises[18].content.options.pop();
  const checked = checkReply(sampleReply(exercises), FULL_PLAN);
  assert.equal(checked.reply, null);
  assert.equal(checked.problem, 'Only 39 of the 50 exercises asked for passed the check. Exercise 19 (choice, vo-1-execute-code): content.options: must be 4 options (found 3).');
});

test('the project key is t-<id>-<slug of the name>, at most 64 characters; the description names the post', () => {
  assert.equal(projectKeyOf(24, 'PHP Security Release (Oct 2026)'), 't-24-php-security-release-oct-2026');
  assert.equal(projectKeyOf(7, 'Đề số một'), 't-7-de-so-mot');
  assert.equal(projectKeyOf(7, '!!!'), 't-7');
  const long = projectKeyOf(123, 'word '.repeat(40));
  assert.ok(long.length <= 64);
  assert.match(long, /^t-123-word-word-.*[a-z]$/);

  const reply = goodReplyOf(sampleReply());
  const file = projectFileOf({ translationId: 24, title: 'Today\'s PHP Security Release' }, reply, 't-24-php');
  assert.equal(file.key, 't-24-php');
  assert.equal(file.name, 'PHP Security Release (Oct 2026)');
  assert.equal(file.description, SAMPLE.project.description.replace(', and How We\'re Strengthening PHP Security', ''));
  assert.equal(file.exercises.length, 50);
});
