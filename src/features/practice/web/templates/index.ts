// The five exercise types, one module each. Adding a type means a module here, a place in the import check and a grader.
import type { ExerciseType } from '../../api-types.ts';
import { choice } from './choice.ts';
import { fill } from './fill.ts';
import { flashcard } from './flashcard.ts';
import { rewrite } from './rewrite.ts';
import type { Template } from './types.ts';
import { write } from './write.ts';

const TEMPLATES = { rewrite, write, choice, fill, flashcard } satisfies { [Type in ExerciseType]: Template<Type> };

// The shell handles every type alike, so it works with the union of them.
export function templateOf(type: ExerciseType): Template<ExerciseType> {
  return TEMPLATES[type] as unknown as Template<ExerciseType>;
}
