// What every exercise type provides. The shell (../exercise.ts) owns the layout and the phases (answering, grading, graded,
// failed); a template draws what is inside the panes, and a flashcard its Answer. The AI's feedback is the shell's.
import type { AnswerOf, ContentOf, ExerciseType } from '../../api-types.ts';

// The exercise a template draws: as it is now, or as an old attempt's snapshot kept it.
export interface ShownExercise<Type extends ExerciseType> {
  topic: string | null;
  tags: string[];
  content: ContentOf<Type>;
}

// What the shell tells a template when it draws a panel.
export interface View<Type extends ExerciseType> {
  exercise: ShownExercise<Type>;
  // The answer being written, or the one that was submitted.
  answer: AnswerOf<Type>;
  // False once submitted, and when an old attempt is reopened.
  editable: boolean;
  // The answer changed (editable only).
  change(answer: AnswerOf<Type>): void;
  // Submit this answer now: for a type that is answered by one click (a flashcard's rating).
  submit(answer: AnswerOf<Type>): void;
  // Open the Evaluation before submitting (a flashcard's Answer).
  reveal(): void;
}

// What a template draws for the Problem: the kind of exercise, named in the header, and what goes in the pane.
export interface ProblemPane {
  kind: string;
  content: HTMLElement[];
}

export interface Template<Type extends ExerciseType> {
  // The problem and the answer share one pane: problem() draws it all.
  single?: true;
  // The label of the button that submits; none when the answer submits itself.
  submitLabel?: string;
  // The status line shows a clock, so it is redrawn every second.
  timed?: true;
  // The answer before anything is typed or picked.
  empty(exercise: ShownExercise<Type>): AnswerOf<Type>;
  // Nothing beyond `empty`: not worth keeping as a draft.
  isBlank(exercise: ShownExercise<Type>, answer: AnswerOf<Type>): boolean;
  isReady(exercise: ShownExercise<Type>, answer: AnswerOf<Type>): boolean;
  problem(view: View<Type>): ProblemPane;
  // The inside of the answer pane; the shell adds its header and its footer.
  answer?(view: View<Type>): HTMLElement[];
  // The line beside the buttons: a word count, a clock.
  status?(view: View<Type>, elapsedMs: number): (Node | string)[];
  // The Evaluation card's title and inside, for a type the AI does not grade (a flashcard's Answer). Without it the AI's feedback is shown.
  evaluation?(view: View<Type>): { title: string; content: HTMLElement[] };
}
