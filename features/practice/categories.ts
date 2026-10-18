// The one list of error categories (docs/practice-proposal.md §5.3): used by the exercise check, the grading prompt,
// the feedback check and the page's labels. Served to the page at /practice/categories.ts. Adding a category is safe;
// renaming one is not (stored feedback names it).

export const ERROR_CATEGORIES = {
  article: { label: 'Article', meaning: 'a / an / the missing, extra or wrong' },
  singular_plural: { label: 'Singular / plural', meaning: 'noun number, countable vs uncountable' },
  subject_verb_agreement: { label: 'Subject–verb agreement', meaning: 'verb does not match its subject' },
  verb_tense: { label: 'Verb tense', meaning: 'wrong tense, or a tense shift' },
  verb_form: { label: 'Verb form', meaning: 'wrong form or pattern after a verb or modal; passive form' },
  word_form: { label: 'Word form', meaning: 'wrong part of speech' },
  word_choice: { label: 'Word choice', meaning: 'wrong word for the meaning' },
  collocation: { label: 'Collocation', meaning: 'words that do not go together' },
  preposition: { label: 'Preposition', meaning: 'wrong, missing or extra preposition' },
  pronoun: { label: 'Pronoun', meaning: 'wrong pronoun, or unclear reference' },
  sentence_structure: { label: 'Sentence structure', meaning: 'fragment, missing subject or verb, word order' },
  run_on: { label: 'Run-on sentence', meaning: 'two sentences joined by a comma or nothing' },
  punctuation: { label: 'Punctuation', meaning: 'other commas, full stops, apostrophes, capitals' },
  spelling: { label: 'Spelling', meaning: 'misspelled word' },
  linking: { label: 'Linking word', meaning: 'wrong or overused linking word' },
  register: { label: 'Register', meaning: 'too informal for IELTS' },
  meaning: { label: 'Meaning', meaning: 'translation adds, drops or changes meaning (translation types only)' },
  other: { label: 'Other', meaning: 'anything else' },
} as const;

export type ErrorCategory = keyof typeof ERROR_CATEGORIES;

export function isErrorCategory(value: unknown): value is ErrorCategory {
  return typeof value === 'string' && Object.hasOwn(ERROR_CATEGORIES, value);
}

export function categoryLabelOf(category: string): string {
  return isErrorCategory(category) ? ERROR_CATEGORIES[category].label : category;
}
