// choice: one or several correct options. The AI grades it, with the right answers and the reasons from the file.
import type { ChoiceContent } from '../../api.ts';
import { h } from '../dom.ts';
import { tagList } from './parts.ts';
import type { Template } from './types.ts';

const LETTERS = 'ABCDEF';
const isMulti = (content: ChoiceContent): boolean => content.options.filter((option) => option.correct === true).length > 1;

export const choice: Template<'choice'> = {
  submitLabel: 'Check answer',
  empty: () => ({ chosen: [] }),
  isBlank: (_exercise, answer) => answer.chosen.length === 0,
  isReady: (_exercise, answer) => answer.chosen.length > 0,

  problem({ exercise: { content, tags } }) {
    return {
      kind: 'Multiple choice',
      content: [
        h('p', 'instruction', isMulti(content) ? 'Choose all the correct answers.' : 'Choose the best answer.'),
        ...(content.context === undefined ? [] : [h('p', 'read', content.context)]),
        h('p', 'read', content.question), ...tagList(tags),
      ],
    };
  },

  answer({ exercise: { content }, answer, editable, change }) {
    const multi = isMulti(content);
    const chosen = new Set(answer.chosen);
    const options = content.options.map((option, index) => {
      const input = Object.assign(h('input'), { type: multi ? 'checkbox' : 'radio', name: 'choice', checked: chosen.has(index), disabled: !editable });
      const mark = h('span', 'mark');
      mark.setAttribute('aria-hidden', 'true');
      return Object.assign(h('label', `option${chosen.has(index) ? ' is-selected' : ''}${editable ? '' : ' is-fixed'}`, input, mark,
        h('span', '', h('b', 'option-letter', LETTERS[index]), option.text)), { input });
    });
    const group = h('div', multi ? 'options is-multi' : 'options', ...options);
    group.setAttribute('role', multi ? 'group' : 'radiogroup');
    group.setAttribute('aria-label', 'Options');
    group.addEventListener('change', () => {
      options.forEach((option) => { option.classList.toggle('is-selected', option.input.checked); });
      change({ chosen: options.flatMap((option, index) => (option.input.checked ? [index] : [])) });
    });
    return [group];
  },
};
