// The Practice contract: the data model (docs/data-model-proposal.md §3.4), the import file (format 4,
// docs/practice-import-format.md) and the HTTP API between features/practice/server and features/practice/web.
// Types only, erased before anything runs.
import type {
  Effort, EffortOption, Language, ModelId, ModelOption, ModelRun, RunStatus, TextLength, Timestamp,
} from '../../shared/api.ts';

// ---- The data model ----

// A group of exercises, usually one day of study.
export interface Project {
  id: number;
  // Unique: "m1-day-02".
  key: string;
  // 1 to 80 characters.
  name: string;
  // Up to 500 characters.
  description: string | null;
  // Set: hidden from the default list.
  archivedAt: Timestamp | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// One task in a project. `version` starts at 1 and goes up by 1 when topic, tags or content really change; writing the
// same content again is no change.
export interface Exercise {
  id: number;
  projectId: number;
  // Unique inside its project.
  key: string;
  // 1, 2, 3...
  position: number;
  topic: string | null;
  tags: string[];
  content: ExerciseContent;
  version: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export type ExerciseContent =
  | RewriteContent | TranslationContent | CorrectionContent | EssayContent
  | ChoiceContent | GapFillContent | FlashcardContent;

export type ExerciseType = ExerciseContent['type'];

// Say the same text another way.
export interface RewriteContent {
  type: 'rewrite';
  instruction: string;
  sourceText: string;
  length: TextLength;
  // Up to 3.
  constraints: string[];
  modelAnswer: string | null;
}

export interface TranslationContent {
  type: 'translation';
  instruction: string;
  sourceText: string;
  sourceLanguage: Language;
  targetLanguage: Language;
  length: TextLength;
  // Up to 3.
  constraints: string[];
  modelAnswer: string | null;
}

// The answer box starts with sourceText.
export interface CorrectionContent {
  type: 'correction';
  instruction: string;
  sourceText: string;
  length: TextLength;
  // May be [].
  plantedMistakes: PlantedMistake[];
  // Up to 3.
  constraints: string[];
  modelAnswer: string | null;
}

export interface PlantedMistake {
  wrongText: string;
  correctText: string;
  explanationMarkdown: string | null;
}

// For example IELTS Task 2.
export interface EssayContent {
  type: 'essay';
  instruction: string;
  minWords: number;
  // A guide, never a limit.
  suggestedMinutes: number | null;
  // Up to 3.
  constraints: string[];
  modelAnswer: string | null;
}

export interface ChoiceContent {
  type: 'choice';
  instruction: string | null;
  question: string;
  // A text the question is about.
  context: string | null;
  // 2 to 6.
  options: ChoiceOption[];
}

export interface ChoiceOption {
  text: string;
  isCorrect: boolean;
  explanationMarkdown: string;
}

export interface GapFillContent {
  type: 'gap_fill';
  instruction: string | null;
  // "If more people {{1}} buses..."
  textWithGaps: string;
  gaps: Gap[];
}

export interface Gap {
  acceptedAnswers: string[];
  hint: string | null;
  explanationMarkdown: string | null;
}

export interface FlashcardContent {
  type: 'flashcard';
  front: string;
  back: string;
  hint: string | null;
  // An example sentence.
  example: string | null;
  explanationMarkdown: string | null;
}

// One answer to one exercise. It never changes; delete is its only write. The snapshot is a copy on purpose: an old
// attempt shows the exercise exactly as the learner saw it.
export interface Attempt {
  id: number;
  exerciseId: number;
  exerciseVersion: number;
  exerciseSnapshot: ExerciseSnapshot;
  answer: Answer;
  // From opening the exercise to Submit.
  timeSpentMs: number | null;
  // When it was submitted.
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface ExerciseSnapshot {
  topic: string | null;
  tags: string[];
  content: ExerciseContent;
}

export type Answer = TextAnswer | ChoiceAnswer | GapFillAnswer | FlashcardAnswer;

export interface TextAnswer {
  type: 'rewrite' | 'translation' | 'correction' | 'essay';
  text: string;
}

export interface ChoiceAnswer {
  type: 'choice';
  // Sorted, no repeats.
  chosenOptionIndexes: number[];
}

export interface GapFillAnswer {
  type: 'gap_fill';
  gapAnswers: string[];
}

export type FlashcardRating = 'didnt_know' | 'almost' | 'knew';

export interface FlashcardAnswer {
  type: 'flashcard';
  rating: FlashcardRating;
}

// One AI grading of one attempt.
export interface Grading {
  id: number;
  attemptId: number;
  run: ModelRun;
  // The grader's reply: the output.
  feedbackMarkdown: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// The content and the answer of one type: ContentOf<'choice'> is ChoiceContent, AnswerOf<'essay'> is TextAnswer. Lookups
// in a table, not conditional types, so a template for several types (rewrite.ts) fits each of them.
export interface ContentByType {
  rewrite: RewriteContent;
  translation: TranslationContent;
  correction: CorrectionContent;
  essay: EssayContent;
  choice: ChoiceContent;
  gap_fill: GapFillContent;
  flashcard: FlashcardContent;
}

export interface AnswerByType {
  rewrite: TextAnswer;
  translation: TextAnswer;
  correction: TextAnswer;
  essay: TextAnswer;
  choice: ChoiceAnswer;
  gap_fill: GapFillAnswer;
  flashcard: FlashcardAnswer;
}

export type ContentOf<Type extends ExerciseType> = ContentByType[Type];
export type AnswerOf<Type extends ExerciseType> = AnswerByType[Type];

// The parts of an exercise a file or a PUT sets: the same fields as a snapshot.
export type ExerciseBody = ExerciseSnapshot;

// ---- The import file, format 4: one file is one project, named by its key ----

// An exercise as a checked file holds it: every default filled in.
export interface FileExercise extends ExerciseBody {
  // a-z 0-9 -, unique in the file: it names the exercise inside its project.
  key: string;
}

// A checked import file (format 4, or format 3 converted): texts trimmed, every default filled in.
export interface ProjectFile {
  key: string;
  name: string;
  description: string | null;
  exercises: FileExercise[];
}

// The file export writes. A file may leave optional fields out (the importer fills them in); export writes them all,
// so importing it again changes nothing.
export interface ImportFile {
  format: 4;
  project: { key: string; name: string; description: string | null };
  exercises: FileExercise[];
}

// ---- HTTP (docs/practice-api-design.md §3) ----

// GET /api/practice: what is there and the rules, for an agent with no docs.
export interface ApiIndex {
  api: 'practice';
  version: number;
  docs: string;
  schemas: { exercise: string; import: string };
  types: ExerciseType[];
  // The import formats POST /import reads; export writes the newest.
  importFormats: number[];
  limits: {
    importBodyBytes: number;
    exercisesPerImport: number;
    exerciseBodyBytes: number;
    attemptBodyBytes: number;
    keyPattern: string;
    attemptsPageMax: number;
  };
  // Every endpoint, so an agent finds them all from this one URL. path: {p} a project key, {e} an exercise key, {id} an
  // attempt's number. query: the parameters it takes.
  endpoints: { method: string; path: string; query: string[]; about: string }[];
}

// A list: wrapped, so it can get a field later. nextBefore: the `before` of the next page, when there is one.
export interface List<Item> {
  items: Item[];
  nextBefore?: number;
}

// A project with what is worked out from its exercises and attempts (never stored).
export interface ProjectSummary extends Project {
  // The newest createdAt of its attempts; null until the first one.
  lastActivityAt: Timestamp | null;
  exerciseCount: number;
  doneCount: number;
  typeCounts: Partial<Record<ExerciseType, number>>;
}

// PUT /api/practice/projects/:project. A PUT sends the whole object: a field left out takes its default (null).
export interface ProjectInput {
  name: string;
  description?: string | null;
  // A time archives the project; null shows it again.
  archivedAt?: Timestamp | null;
}

// One exercise with what is worked out about it (never stored).
export interface ExerciseDetail extends Exercise {
  projectKey: string;
  // It has a flashcard attempt, or an attempt with a succeeded grading (of any version).
  isDone: boolean;
  attemptCount: number;
}

// The latest attempt of an exercise, as a list line shows it.
export interface AttemptLine {
  id: number;
  createdAt: Timestamp;
  // The status of its latest grading; null for a flashcard.
  gradingStatus: RunStatus | null;
  // "Graded", "Grading…", "Not graded", or a flashcard's rating ("Almost").
  historyLine: string;
}

// One exercise in a list: what a person or an agent needs to pick it. No content (GET one, or export).
export interface ExerciseItem {
  id: number;
  key: string;
  type: ExerciseType;
  // "Rewrite, sentence", "Multiple choice" (text.ts).
  label: string;
  preview: string;
  topic: string | null;
  tags: string[];
  version: number;
  updatedAt: Timestamp;
  isDone: boolean;
  lastAttempt: AttemptLine | null;
}

// One attempt: all a reopened page needs. The keys say where its exercise is now; the snapshot is how it was then.
export interface AttemptDetail extends Attempt {
  projectKey: string;
  exerciseKey: string;
  // Oldest first; the result shown is the last one. [] for a flashcard.
  gradings: Grading[];
}

// What an AI grading runs with: the model and effort the person picked (the same options as Claude Translate).
export interface GradingSettings {
  modelId: ModelId;
  effort: Effort;
}

// GET /api/practice/grading-options. The models and efforts are listed as GET /translation-options lists them.
export interface GradingOptions {
  models: ModelOption[];
  efforts: EffortOption[];
  defaultModelId: ModelId;
  defaultEffort: Effort;
}

// POST /api/practice/projects/:project/exercises/:exercise/attempts. answer.type must be the exercise's type.
// modelId and effort are the grading's settings (a flashcard ignores them): the defaults apply when one is left out, and a
// value that is not offered is a 400. exerciseVersion: the version the page showed; another one is a 409 exercise_changed.
export interface CreateAttemptRequest extends Partial<GradingSettings> {
  answer: Answer;
  // From opening the exercise to Submit; null when unknown.
  timeSpentMs?: number | null;
  exerciseVersion?: number;
}

// POST /api/practice/attempts/:id/regrade body: the settings of the new grading, as above.
export type RegradeRequest = Partial<GradingSettings>;

// GET /api/practice/attempts/:id/stream: Server-Sent Events (`event: name` + `data: json`), the same wire format as Claude
// Translate's. A grading in progress sends `snapshot` first (what it has produced so far), then the rest as it happens.
// Whatever else the stream says, `done`, `error` and `finished` mean the same: read the attempt for the final state.
export interface GradingStreamEvents {
  snapshot: { thinkingText: string; thinkingMs: number | null; text: string; modelId: ModelId; effort: Effort; elapsedMs: number };
  thinking_delta: { text: string };
  thinking_done: { durationMs: number };
  text_delta: { text: string };
  retry: { attempt: number; maxRetries: number; error: string };
  fallback: { fromModelId: ModelId; toModelId: ModelId };
  done: Record<string, never>;
  error: { message: string };
  // The attempt is not being graded (its grading ended, or it is a flashcard).
  finished: Record<string, never>;
}

export type Change = 'created' | 'updated' | 'unchanged';

// POST /api/practice/import. A dry run says exactly what the real one would do, and writes nothing.
export interface ImportResult {
  dryRun: boolean;
  project: ProjectSummary;
  projectChange: Change;
  // Keys.
  exercises: { created: string[]; updated: string[]; unchanged: string[] };
}
