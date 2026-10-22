// The translation modes and the system prompt each one runs with, built from the files in translate/prompts/.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Mode, ModeOption } from '../api-types.ts';
import { FEATURES_DIRECTORY } from '../../../shared/server/paths.ts';

const PROMPTS_DIRECTORY = join(FEATURES_DIRECTORY, 'translate', 'prompts');
// The system prompt, in order: these shared parts, then the mode's source part.
const SHARED_PROMPT_PATHS = ['core.md', 'style-vi.md', 'style-en.md'].map((name) => join(PROMPTS_DIRECTORY, name));
// Data, not prompt text: it replaces {{glossary}} in the style part.
const GLOSSARY_PATH = join(PROMPTS_DIRECTORY, 'glossary.tsv');

// source_prompt_path: the mode's "# Source" section, the last part of the system prompt.
interface ModeConfig extends ModeOption {
  source_prompt_path: string;
}

// Menu order.
export const MODE_OPTIONS: ModeConfig[] = [
  {
    mode: 'translate',
    label: 'As pasted',
    description: 'Keeps your text exactly as pasted.',
    source_prompt_path: join(PROMPTS_DIRECTORY, 'source-translate.md'),
  },
  {
    mode: 'translate_markdown',
    label: 'Markdown',
    description: 'Tidies pasted text into headings, lists and paragraphs, then translates. Words never change.',
    source_prompt_path: join(PROMPTS_DIRECTORY, 'source-translate_markdown.md'),
  },
];
export const DEFAULT_MODE: Mode = 'translate';

// Every file a system prompt is read from, so a change to any of them can be noticed.
export const PROMPT_PATHS = [...SHARED_PROMPT_PATHS, GLOSSARY_PATH, ...MODE_OPTIONS.map((option) => option.source_prompt_path)];

function modeOptionOf(mode: string | undefined): ModeConfig | undefined {
  return MODE_OPTIONS.find((option) => option.mode === mode);
}

export function isMode(mode: unknown): mode is Mode {
  return modeOptionOf(mode as string) !== undefined;
}

// The glossary as the prompt shows it: one "English term -> Vietnamese form" per line. "#" lines are comments.
function glossaryBlock(): string {
  const lines = readFileSync(GLOSSARY_PATH, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.startsWith('#'));
  const entries = lines.map((line) => line.replace(/\t+/g, ' -> ').trim());
  const heading = 'English term -> form to use in Vietnamese ("keep" = leave the English term):';
  return `<glossary>\n${heading}\n${entries.join('\n')}\n</glossary>`;
}

// Read at every spawn, so a prompt edit reaches the next process without a restart.
export function systemPromptOf(mode: Mode): string {
  const { source_prompt_path } = modeOptionOf(mode) as ModeConfig;
  const glossary_block = glossaryBlock();
  // A function as the replacement, so a "$" in the glossary is not read as a pattern.
  const shared_parts = SHARED_PROMPT_PATHS.map((path) => readFileSync(path, 'utf8').trim().replace('{{glossary}}', () => glossary_block));
  const source_part = readFileSync(source_prompt_path, 'utf8').trim();
  return `${shared_parts.join('\n\n')}\n\n${source_part}\n`;
}
