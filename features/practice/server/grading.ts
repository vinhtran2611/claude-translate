// Grades one saved attempt with `claude -p` (docs/practice-proposal.md §5): builds the prompt, runs the shared runner,
// checks the JSON reply and stores the outcome. Grading runs on the server, so closing the page does not stop it.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Effort } from '../../../shared/api.ts';
import { modelLabelOf, runClaude } from '../../../shared/server/claude-runner.ts';
import { formatCount, formatSeconds, log } from '../../../shared/server/log.ts';
import type { AttemptAnswer, Exercise, ExerciseType } from '../api.ts';
import { ERROR_CATEGORIES } from '../categories.ts';
import { checkFeedback, deriveFields, extractJson } from './feedback-validate.ts';
import type { GradingOutcome, PracticeStore } from './practice-store.ts';

const PROMPTS_DIRECTORY = join(dirname(dirname(fileURLToPath(import.meta.url))), 'prompts');

// The types this version grades, with the model and effort for each. The model and effort are stored on every attempt.
// Like translate, a model that sends no first token hands over to the next one down.
const GRADING_SETTINGS: Partial<Record<ExerciseType, { model_id: string; effort: Effort; output_format: string }>> = {
  sentence_translation: { model_id: 'claude-sonnet-5-5', effort: 'low', output_format: 'output-translation.md' },
  paragraph_translation: { model_id: 'claude-sonnet-5-5', effort: 'low', output_format: 'output-translation.md' },
  // Medium: bands need the whole essay weighed, which low effort rushes.
  essay_translation: { model_id: 'claude-sonnet-5-5', effort: 'medium', output_format: 'output-essay_translation.md' },
  free_writing: { model_id: 'claude-sonnet-5-5', effort: 'medium', output_format: 'output-free_writing.md' },
};

// Arbitrary: generous for the shortest answers, the longest an essay can be.
export const MAX_ANSWER_CHARS: Record<ExerciseType, number> = {
  sentence_translation: 1_000, paragraph_translation: 5_000, essay_translation: 20_000, free_writing: 20_000, error_correction: 20_000,
};

let grading_request_count = 0;

export function isGradable(type: ExerciseType): boolean {
  return GRADING_SETTINGS[type] !== undefined;
}

export function gradingSettingsOf(type: ExerciseType): { model_id: string; effort: Effort } {
  const settings = GRADING_SETTINGS[type];
  if (settings === undefined) throw new Error(`${type} cannot be graded yet`);
  return { model_id: settings.model_id, effort: settings.effort };
}

// Read at every grading, so a prompt edit applies without a restart.
export function gradingSystemPromptOf(type: ExerciseType): string {
  const { output_format } = GRADING_SETTINGS[type] as { output_format: string };
  const category_lines = Object.entries(ERROR_CATEGORIES).map(([name, { meaning }]) => `- ${name}: ${meaning}`).join('\n');
  const parts = ['grade-core.md', `grade-${type}.md`, output_format].map((name) =>
    readFileSync(join(PROMPTS_DIRECTORY, name), 'utf8').trim().replace('{{categories}}', () => category_lines));
  return `${parts.join('\n\n')}\n`;
}

// The exercise without its id (the grader does not need it). Reference answers stay: they help the grader. A free
// writing sample essay does not: it would pull the bands towards it.
export function gradingUserMessageOf(exercise: Exercise, answer: AttemptAnswer, word_count: number): string {
  const { id: _id, ...exercise_fields } = exercise;
  if (exercise_fields.type === 'free_writing') delete exercise_fields.sample_essay_en;
  const head = `Grade this answer. Exercise type: ${exercise.type}.\n\n<exercise>\n${JSON.stringify(exercise_fields, null, 2)}\n</exercise>\n\n`;
  if (exercise.type === 'essay_translation') {
    return `${head}<answer_prompt>\n${answer.prompt_text ?? ''}\n</answer_prompt>\n\n<answer_essay word_count="${word_count}">\n${answer.text}\n</answer_essay>`;
  }
  return `${head}<answer word_count="${word_count}">\n${answer.text}\n</answer>`;
}

// Starts grading attempt_id, which must be in status 'grading'; the outcome is written to the store when it ends.
export function gradeAttempt(store: PracticeStore, attempt_id: number, exercise: Exercise, answer: AttemptAnswer, word_count: number): void {
  const request_number = ++grading_request_count;
  const settings = gradingSettingsOf(exercise.type);
  const started_at = Date.now();
  let output_tokens: number | null = null;
  // A throw here would escape a stream handler and stop the server; a failed save must only be logged.
  const saveOutcome = (outcome: GradingOutcome): void => {
    try {
      store.finishGrading(attempt_id, outcome);
    } catch (save_error) {
      log('error', request_number, 'practice', `saving attempt ${attempt_id} failed: ${(save_error as Error).message}`);
    }
  };
  log('info', request_number, 'grade', `${exercise.type} ${exercise.id}  ${formatCount(word_count)} words  ${modelLabelOf(settings.model_id)} ${settings.effort}  attempt ${attempt_id}`);
  const run = runClaude({
    request_number,
    settings: { ...settings, system_prompt: gradingSystemPromptOf(exercise.type) },
    user_message: gradingUserMessageOf(exercise, answer, word_count),
    handlers: {
      onResultMessage: (result_output_tokens) => { output_tokens = result_output_tokens; },
      onDone: (reply_text) => {
        const grading_ms = Date.now() - started_at;
        const served_model_id = run.served_model_id();
        const parsed = extractJson(reply_text);
        const checked = parsed === null ? { feedback: null, problems: ['the reply has no JSON object'] } : checkFeedback(parsed, exercise.type);
        if (checked.feedback === null) {
          log('error', request_number, 'error', `${modelLabelOf(served_model_id)}  ${formatSeconds(grading_ms)}  invalid_feedback: ${checked.problems.slice(0, 3).join('; ')}  attempt ${attempt_id}`);
          saveOutcome({
            status: 'failed', error_kind: 'invalid_feedback', error_message: `The grader's reply was not in the expected format: ${checked.problems[0]}.`,
            raw_output: reply_text, served_model_id, grading_ms, output_tokens,
          });
          return;
        }
        const derived = deriveFields(checked.feedback);
        saveOutcome({
          status: 'graded', feedback: checked.feedback, ...derived, raw_output: reply_text, served_model_id, grading_ms, output_tokens,
        });
        log('info', request_number, 'graded',
          `${modelLabelOf(served_model_id).padEnd(10)}  ${settings.effort.padEnd(6)}  ${formatSeconds(grading_ms).padStart(6)}  ` +
            `${derived.error_count} ${derived.error_count === 1 ? 'error' : 'errors'}${derived.overall_band === null ? '' : `  band ${derived.overall_band.toFixed(1)}`}  ` +
            `${formatCount(output_tokens ?? 0)} tokens  attempt ${attempt_id}`);
      },
      onError: (error, failure_text, failure_detail_lines) => {
        const grading_ms = Date.now() - started_at;
        log('error', request_number, 'error', `${modelLabelOf(run.served_model_id())}  ${formatSeconds(grading_ms)}  ${error.error_kind}: ${failure_text}  attempt ${attempt_id}`, failure_detail_lines);
        saveOutcome({
          status: 'failed', error_kind: error.error_kind, error_message: error.message, raw_output: '',
          served_model_id: run.served_model_id(), grading_ms, output_tokens,
        });
      },
    },
  });
}
