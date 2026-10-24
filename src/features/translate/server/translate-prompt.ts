// The source formats a translation runs with, and the system prompt of each, built from the files in translate/prompts/.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SourceFormat, SourceFormatOption } from '../api-types.ts';
import { FEATURES_DIRECTORY } from '../../../shared/server/paths.ts';

const PROMPTS_DIRECTORY = join(FEATURES_DIRECTORY, 'translate', 'prompts');
// The system prompt, in order: these shared parts, then the source format's own part.
const SHARED_PROMPT_PATHS = ['core.md', 'style-vi.md', 'style-en.md'].map((name) => join(PROMPTS_DIRECTORY, name));
// Data, not prompt text: it replaces {{glossary}} in the style part.
const GLOSSARY_PATH = join(PROMPTS_DIRECTORY, 'glossary.tsv');

// sourcePromptPath: the source format's "# Source" section, the last part of the system prompt.
interface SourceFormatConfig extends SourceFormatOption {
  sourcePromptPath: string;
}

// Menu order.
export const SOURCE_FORMAT_OPTIONS: SourceFormatConfig[] = [
  {
    sourceFormat: 'plain_text',
    label: 'As pasted',
    description: 'Keeps your text exactly as pasted.',
    sourcePromptPath: join(PROMPTS_DIRECTORY, 'source-translate.md'),
  },
  {
    sourceFormat: 'markdown',
    label: 'Markdown',
    description: 'Lays pasted text out as sections, short paragraphs and lists, then translates. Every sentence is kept.',
    sourcePromptPath: join(PROMPTS_DIRECTORY, 'source-translate_markdown.md'),
  },
];
export const DEFAULT_SOURCE_FORMAT: SourceFormat = 'plain_text';

// Every file a system prompt is read from, so a change to any of them can be noticed.
export const PROMPT_PATHS = [...SHARED_PROMPT_PATHS, GLOSSARY_PATH, ...SOURCE_FORMAT_OPTIONS.map((option) => option.sourcePromptPath)];

function sourceFormatOptionOf(sourceFormat: string | undefined): SourceFormatConfig | undefined {
  return SOURCE_FORMAT_OPTIONS.find((option) => option.sourceFormat === sourceFormat);
}

export function isSourceFormat(sourceFormat: unknown): sourceFormat is SourceFormat {
  return sourceFormatOptionOf(sourceFormat as string) !== undefined;
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
export function systemPromptOf(sourceFormat: SourceFormat): string {
  const { sourcePromptPath } = sourceFormatOptionOf(sourceFormat) as SourceFormatConfig;
  const glossary = glossaryBlock();
  // A function as the replacement, so a "$" in the glossary is not read as a pattern.
  const sharedParts = SHARED_PROMPT_PATHS.map((path) => readFileSync(path, 'utf8').trim().replace('{{glossary}}', () => glossary));
  const sourcePart = readFileSync(sourcePromptPath, 'utf8').trim();
  return `${sharedParts.join('\n\n')}\n\n${sourcePart}\n`;
}
