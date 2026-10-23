// Makes a Practice project from a translated post with `claude -p` (docs/practice-from-translation-design.md §4 and §5).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Effort } from '../../../shared/api-types.ts';
import { FEATURES_DIRECTORY } from '../../../shared/server/paths.ts';

const PROMPT_PATH = join(FEATURES_DIRECTORY, 'practice', 'prompts', 'generate.md');
// Build step 1 compared the options on translation 24.
export const GENERATION_SETTINGS: { modelId: string; effort: Effort } = { modelId: 'claude-opus-5-5', effort: 'medium' };

// Read at every generation, so an edit of the prompt applies without a restart.
export function systemPrompt(): string {
  return `${readFileSync(PROMPT_PATH, 'utf8').trim()}\n`;
}
