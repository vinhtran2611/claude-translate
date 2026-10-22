// rewrite: translate, rewrite a sentence, paragraph or essay, or correct a text with planted mistakes.
import { countWords, rewriteVerb } from '../../text.ts';
import { h } from '../dom.ts';
import { answerBox, tagList } from './parts.ts';
import type { Template } from './types.ts';

export const rewrite: Template<'rewrite'> = {
  submitLabel: 'Submit',
  empty: ({ content }) => ({ text: content.prefill === true ? content.text : '' }),
  isBlank: (exercise, answer) => answer.text.trim() === '' || answer.text === rewrite.empty(exercise).text,
  isReady: (_exercise, answer) => answer.text.trim() !== '',

  problem({ exercise: { content, tags } }) {
    const noun = content.length === 'essay' ? 'whole essay' : content.length;
    const label = `${content.source_lang === 'vi' ? 'Vietnamese' : 'Original'} ${content.length}`;
    return {
      kind: `${rewriteVerb(content)} a ${noun}`,
      content: [
        h('p', 'instruction', content.instruction),
        h('p', 'label', content.length === 'essay' ? `${label} · ${countWords(content.text)} words` : label),
        Object.assign(h('p', 'read', content.text), { lang: content.source_lang ?? 'en' }),
        ...tagList([...(content.constraints ?? []), ...tags]),
      ],
    };
  },

  answer({ exercise: { content }, answer, editable, change }) {
    return [answerBox(answer.text, editable, content.length === 'essay', (text) => change({ text }))];
  },

  status({ exercise: { content }, answer }) {
    return content.length === 'essay' ? [h('strong', '', `${countWords(answer.text)} words`), ` · original ${countWords(content.text)}`] : [];
  },
};
