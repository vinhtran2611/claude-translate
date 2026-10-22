// What every exercise type provides. The shell (../exercise.ts) owns the layout and the phases (answering, grading, graded,
// failed); a template draws what is inside the panes, and a flashcard its Answer. The AI's feedback is the shell's.
import type { AnswerByType, ExerciseBody, ExerciseType } from '../../api-types.ts';

// What the shell tells a template when it draws a panel.
export interface View<Type extends ExerciseType> {
  exercise: ExerciseBody<Type>;
  // The answer being written, or the one that was submitted.
  answer: AnswerByType[Type];
  // False once submitted, and when an old attempt is reopened.
  editable: boolean;
  // The answer changed (editable only).
  change(answer: AnswerByType[Type]): void;
  // Submit this answer now: for a type that is answered by one click (a flashcard's rating).
  submit(answer: AnswerByType[Type]): void;
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
  empty(exercise: ExerciseBody<Type>): AnswerByType[Type];
  // Nothing beyond `empty`: not worth keeping as a draft.
  isBlank(exercise: ExerciseBody<Type>, answer: AnswerByType[Type]): boolean;
  isReady(exercise: ExerciseBody<Type>, answer: AnswerByType[Type]): boolean;
  problem(view: View<Type>): ProblemPane;
  // The inside of the answer pane; the shell adds its header and its footer.
  answer?(view: View<Type>): HTMLElement[];
  // The line beside the buttons: a word count, a clock.
  status?(view: View<Type>, elapsed_ms: number): (Node | string)[];
  // The Evaluation card's title and inside, for a type the AI does not grade (a flashcard's Answer). Without it the AI's feedback is shown.
  evaluation?(view: View<Type>): { title: string; content: HTMLElement[] };
}
