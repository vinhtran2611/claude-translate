// The one list of error categories (docs/practice-proposal.md §5.3): used by the exercise validator, and later by the
// grading prompt, the feedback validator and the page's labels. Adding a category is safe; renaming one is not.

export const ERROR_CATEGORIES = {
  article: 'a / an / the missing, extra or wrong',
  singular_plural: 'noun number, countable vs uncountable',
  subject_verb_agreement: 'verb does not match its subject',
  verb_tense: 'wrong tense, or a tense shift',
  verb_form: 'wrong form or pattern after a verb or modal; passive form',
  word_form: 'wrong part of speech',
  word_choice: 'wrong word for the meaning',
  collocation: 'words that do not go together',
  preposition: 'wrong, missing or extra preposition',
  pronoun: 'wrong pronoun, or unclear reference',
  sentence_structure: 'fragment, missing subject or verb, word order',
  run_on: 'two sentences joined by a comma or nothing',
  punctuation: 'other commas, full stops, apostrophes, capitals',
  spelling: 'misspelled word',
  linking: 'wrong or overused linking word',
  register: 'too informal for IELTS',
  meaning: 'translation adds, drops or changes meaning (translation types only)',
  other: 'anything else',
} as const;

export type ErrorCategory = keyof typeof ERROR_CATEGORIES;

export function isErrorCategory(value: unknown): value is ErrorCategory {
  return typeof value === 'string' && Object.hasOwn(ERROR_CATEGORIES, value);
}
