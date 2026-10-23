// rewrite, translation and correction: one text is given, one text is written back. A correction's answer box starts with
// the text and its planted mistakes.
import type { Language } from '../../../../shared/api-types.ts';
import type { ContentOf } from '../../api-types.ts';
import { countWords, LENGTH_NAMES } from '../../text.ts';
import { h } from '../dom.ts';
import { answerBox, tagList } from './parts.ts';
import type { Template } from './types.ts';

type TextType = 'rewrite' | 'translation' | 'correction';

const LANGUAGE_NAMES: Record<Language, string> = { en: 'English', vi: 'Vietnamese' };
const VERBS: Record<TextType, string> = { rewrite: 'Rewrite', translation: 'Translate', correction: 'Correct' };
const NOUNS = { sentence: 'a sentence', paragraph: 'a paragraph', multi_paragraph: 'a longer text' };

// "Vietnamese sentence", "Original paragraph": the label above the given text.
function sourceLabelOf(content: ContentOf<TextType>): string {
  const length = LENGTH_NAMES[content.length];
  if (content.type === 'translation') return `${LANGUAGE_NAMES[content.sourceLanguage]} ${length}`;
  return `Original ${length}`;
}

function languageOf(content: ContentOf<TextType>): Language {
  if (content.type === 'translation') return content.sourceLanguage;
  return 'en';
}

export const rewrite: Template<TextType> = {
  submitLabel: 'Submit',
  empty: ({ content }) => {
    if (content.type === 'correction') return { type: content.type, text: content.sourceText };
    return { type: content.type, text: '' };
  },
  isBlank: (exercise, answer) => answer.text.trim() === '' || answer.text === rewrite.empty(exercise).text,
  isReady: (_exercise, answer) => answer.text.trim() !== '',

  problem({ exercise: { content, tags } }) {
    const isLong = content.length === 'multi_paragraph';
    let label = sourceLabelOf(content);
    if (isLong) label = `${label} · ${countWords(content.sourceText)} words`;
    return {
      kind: `${VERBS[content.type]} ${NOUNS[content.length]}`,
      content: [
        h('p', 'instruction', content.instruction),
        h('p', 'label', label),
        Object.assign(h('p', 'read', content.sourceText), { lang: languageOf(content) }),
        ...tagList([...content.constraints, ...tags]),
      ],
    };
  },

  answer({ exercise: { content }, answer, editable, change }) {
    const isLong = content.length === 'multi_paragraph';
    return [answerBox(answer.text, editable, isLong, (text) => change({ type: content.type, text }))];
  },

  status({ exercise: { content }, answer }) {
    if (content.length !== 'multi_paragraph') return [];
    return [h('strong', '', `${countWords(answer.text)} words`), ` · original ${countWords(content.sourceText)}`];
  },
};
