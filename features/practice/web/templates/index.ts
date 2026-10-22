// The seven exercise types; rewrite, translation and correction share one module. Adding a type means a module here, a
// place in the import check and in the grading prompt.
import type { ExerciseType } from '../../api.ts';
import { choice } from './choice.ts';
import { fill } from './fill.ts';
import { flashcard } from './flashcard.ts';
import { rewrite } from './rewrite.ts';
import type { Template } from './types.ts';
import { essay } from './write.ts';

// One template draws all three text types; it switches on content.type. TypeScript cannot see that a template for the
// three fits each one (a callback in View makes Template invariant), so it is said here once.
const text_template = rewrite as unknown as Template<'rewrite'> & Template<'translation'> & Template<'correction'>;

const TEMPLATES = {
  rewrite: text_template,
  translation: text_template,
  correction: text_template,
  essay,
  choice,
  gap_fill: fill,
  flashcard,
} satisfies { [Type in ExerciseType]: Template<Type> };

// The shell handles every type alike, so it works with the union of them.
export function templateOf(type: ExerciseType): Template<ExerciseType> {
  return TEMPLATES[type] as unknown as Template<ExerciseType>;
}
