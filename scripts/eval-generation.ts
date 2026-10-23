// Runs one generation (docs/practice-from-translation-design.md §10, step 1) on a translation from Translate's history,
// outside the server: the same prompt, plan and check. Writes the project as an import file and prints a report next to a
// hand-made sample, so the prompt and the model can be judged before the feature is used.
//
//   node scripts/eval-generation.ts <translationId> [--model claude-opus-5-5] [--effort medium] [--sample file.json] [--out file.json]
//
// The history is read from TRANSLATE_DATABASE_PATH (default data/translate.sqlite), read only. The default output is
// data/practice-imports/t-<id>-gen.json.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import type { Effort, GenerationBlock, TranslatedBlock } from '../src/shared/api-types.ts';
import { runClaude } from '../src/shared/server/claude-runner.ts';
import { formatSeconds } from '../src/shared/server/log.ts';
import { DATA_DIRECTORY } from '../src/shared/server/paths.ts';
import type { FileExercise, ImportFile } from '../src/features/practice/api-types.ts';
import {
  checkReply, firstTokenAllowanceMsOf, GENERATION_KINDS, hasVietnamese, kindOf, planOf, postWordCount, projectFileOf, projectKeyOf,
  userMessageOf, type GenerationPost,
} from '../src/features/practice/generation-check.ts';
import { checkImportValue } from '../src/features/practice/import-check.ts';
import { GENERATION_SETTINGS, systemPrompt } from '../src/features/practice/server/generation.ts';

const QUARTER_COUNT = 4;

interface TranslationRow {
  id: number;
  source_language: string;
  run_status: string;
  blocks_json: string;
}

// The post of a finished en->vi translation, as the Translate page would send it.
function readPost(databasePath: string, translationId: number): GenerationPost {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database.prepare('SELECT id, source_language, run_status, blocks_json FROM translations WHERE id = ?').get(translationId) as TranslationRow | undefined;
    if (row === undefined) throw new Error(`no translation ${translationId} in ${databasePath}`);
    if (row.source_language !== 'en' || row.run_status !== 'succeeded') throw new Error(`translation ${translationId} is not a finished English post`);
    const translatedBlocks = JSON.parse(row.blocks_json) as TranslatedBlock[];
    const blocks: GenerationBlock[] = translatedBlocks.map(({ sourceText, translatedText }) => ({ sourceText, translatedText }));
    const heading = translatedBlocks.find((block) => block.blockType === 'heading');
    const title = heading?.sourceText ?? blocks[0].sourceText.slice(0, 80);
    return { translationId, title, blocks };
  } finally {
    database.close();
  }
}

// Resolves with the reply text, or rejects with the runner's error.
function generate(post: GenerationPost, userMessage: string, modelId: string, effort: Effort): Promise<{ replyText: string; servedModelId: string }> {
  return new Promise((resolve, reject) => {
    let characterCount = 0;
    let lastPrinted = 0;
    const run = runClaude({
      requestNumber: null,
      settings: { modelId, effort, systemPrompt: systemPrompt() },
      userMessage,
      firstTokenAllowanceMs: firstTokenAllowanceMsOf(post.blocks),
      handlers: {
        onText: (text) => {
          characterCount += text.length;
          // A dot per 2,000 characters shows it is alive.
          if (characterCount - lastPrinted >= 2_000) {
            process.stdout.write('.');
            lastPrinted = characterCount;
          }
        },
        onDone: (replyText) => resolve({ replyText, servedModelId: run.servedModelId() }),
        onError: (error) => reject(new Error(`${error.errorCode}: ${error.message}`)),
      },
    });
  });
}

function normalized(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

// The text of the post an exercise quotes: a flashcard's example, a choice's context, or the longest part of its question
// around the gap.
function quotedTextOf(exercise: FileExercise): string {
  const { content } = exercise;
  if (content.type === 'flashcard') return content.example ?? content.front;
  if (content.type !== 'choice') return '';
  if (content.context !== null) return content.context;
  const parts = content.question.split('____').map((part) => part.trim());
  parts.sort((first, second) => second.length - first.length);
  return parts[0];
}

// Which quarter of the post (0 to 3) an exercise comes from; null when its quote is not found.
function quarterOf(exercise: FileExercise, blocks: GenerationBlock[]): number | null {
  const quoted = normalized(quotedTextOf(exercise));
  if (quoted === '') return null;
  // A quote may span two blocks or be cut; its first 40 characters are enough to place it.
  const probe = quoted.slice(0, 40);
  const blockIndex = blocks.findIndex((block) => normalized(block.sourceText).includes(probe));
  if (blockIndex === -1) return null;
  return Math.floor((blockIndex * QUARTER_COUNT) / blocks.length);
}

function percent(part: number, whole: number): string {
  if (whole === 0) return '-';
  return `${Math.round((part * 100) / whole)}%`;
}

// One column of the report: the numbers of one set of exercises.
function reportColumn(exercises: FileExercise[], blocks: GenerationBlock[]): Record<string, string> {
  const column: Record<string, string> = {};
  column.exercises = String(exercises.length);
  for (const kind of GENERATION_KINDS) {
    const count = exercises.filter((exercise) => kindOf(exercise) === kind).length;
    column[kind] = String(count);
  }
  const grammarTags = new Set(exercises.flatMap((exercise) => exercise.tags.filter((tag) => tag.startsWith('grammar:'))));
  column['grammar tags'] = String(grammarTags.size);
  const quarterCounts = [0, 0, 0, 0];
  let notFound = 0;
  for (const exercise of exercises) {
    const quarter = quarterOf(exercise, blocks);
    if (quarter === null) notFound++;
    else quarterCounts[quarter]++;
  }
  column['quarters 1/2/3/4'] = quarterCounts.join('/');
  column['quote not found'] = String(notFound);
  const glossed = exercises.filter((exercise) => exercise.content.type === 'flashcard' || kindOf(exercise) === 'meaning');
  const withVietnamese = glossed.filter(hasVietnamese).length;
  column['Vietnamese in gloss'] = `${withVietnamese}/${glossed.length} (${percent(withVietnamese, glossed.length)})`;
  return column;
}

function frontsOf(exercises: FileExercise[]): Set<string> {
  const fronts = new Set<string>();
  for (const exercise of exercises) {
    if (exercise.content.type === 'flashcard') fronts.add(normalized(exercise.content.front));
  }
  return fronts;
}

function printTable(columns: Record<string, Record<string, string>>): void {
  const names = Object.keys(columns);
  const rows = Object.keys(columns[names[0]]);
  console.log(`${''.padEnd(22)}${names.map((name) => name.padStart(16)).join('')}`);
  for (const row of rows) {
    const cells = names.map((name) => (columns[name][row] ?? '').padStart(16));
    console.log(`${row.padEnd(22)}${cells.join('')}`);
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      model: { type: 'string', default: GENERATION_SETTINGS.modelId },
      effort: { type: 'string', default: GENERATION_SETTINGS.effort },
      sample: { type: 'string' },
      out: { type: 'string' },
    },
  });
  const translationId = Number(positionals[0]);
  if (!Number.isInteger(translationId) || translationId < 1) throw new Error('usage: node scripts/eval-generation.ts <translationId> [--model id] [--effort e] [--sample file] [--out file]');
  const databasePath = process.env.TRANSLATE_DATABASE_PATH ?? join(DATA_DIRECTORY, 'translate.sqlite');
  const outPath = values.out ?? join(DATA_DIRECTORY, 'practice-imports', `t-${translationId}-gen.json`);
  const modelId = values.model;
  const effort = values.effort as Effort;

  const post = readPost(databasePath, translationId);
  const words = postWordCount(post.blocks);
  const plan = planOf(words);
  const userMessage = userMessageOf(post, plan);
  console.log(`Translation ${translationId}: "${post.title}", ${words} words in ${post.blocks.length} blocks`);
  console.log(`Plan: ${JSON.stringify(plan)}  ${modelId} ${effort}`);

  const startedAt = Date.now();
  const { replyText, servedModelId } = await generate(post, userMessage, modelId, effort);
  const durationMs = Date.now() - startedAt;
  console.log(`\nReply: ${replyText.length} characters from ${servedModelId} in ${formatSeconds(durationMs)}`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath.replace(/\.json$/, '.reply.txt'), replyText);

  const checked = checkReply(replyText, plan);
  if (checked.reply === null) {
    console.log(`FAILED: ${checked.problem}`);
    process.exitCode = 1;
    return;
  }
  const { reply } = checked;
  const file = projectFileOf(post, reply, projectKeyOf(translationId, reply.name));
  const importFile: ImportFile = { format: 4, project: { key: file.key, name: file.name, description: file.description }, exercises: file.exercises };
  writeFileSync(outPath, `${JSON.stringify(importFile, null, 2)}\n`);
  const importProblems = checkImportValue(importFile).problems;
  console.log(`Wrote ${outPath} (project ${file.key}, "${file.name}"); import check: ${importProblems === null ? 'valid' : `${importProblems.length} problems`}`);

  console.log(`\nDropped: ${reply.droppedCount}`);
  for (const line of reply.droppedLines) console.log(`  ${line}`);
  console.log(`Warnings: ${reply.warnings.length}`);
  for (const warning of reply.warnings) console.log(`  ${warning}`);

  const columns: Record<string, Record<string, string>> = { generated: reportColumn(reply.exercises, post.blocks) };
  const plannedColumn: Record<string, string> = { exercises: String(plan.total) };
  for (const kind of GENERATION_KINDS) plannedColumn[kind] = String(plan[kind]);
  plannedColumn['grammar tags'] = '>= 10';
  columns.plan = plannedColumn;
  let sampleExercises: FileExercise[] | null = null;
  if (values.sample !== undefined) {
    const sample = checkImportValue(JSON.parse(readFileSync(values.sample, 'utf8')));
    if (sample.file === null) throw new Error(`the sample ${values.sample} is not a valid import file`);
    sampleExercises = sample.file.exercises;
    columns.sample = reportColumn(sampleExercises, post.blocks);
  }
  console.log('');
  printTable(columns);

  const grammarTags = [...new Set(reply.exercises.flatMap((exercise) => exercise.tags.filter((tag) => tag.startsWith('grammar:'))))];
  console.log(`\nGrammar tags: ${grammarTags.join(', ')}`);
  const fronts = frontsOf(reply.exercises);
  if (sampleExercises !== null) {
    const sampleFronts = frontsOf(sampleExercises);
    const shared = [...fronts].filter((front) => sampleFronts.has(front));
    console.log(`Flashcard fronts shared with the sample: ${shared.length} of ${fronts.size}: ${shared.join('; ')}`);
  }
  console.log(`Flashcard fronts: ${[...fronts].join('; ')}`);
}

await main();
