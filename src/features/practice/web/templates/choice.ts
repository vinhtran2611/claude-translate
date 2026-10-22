// choice: one or several correct options. The AI grades it, with the right answers and the explanations from the file.
import type { ChoiceContent } from '../../api-types.ts';
import { h } from '../dom.ts';
import { tagList } from './parts.ts';
import type { Template } from './types.ts';

const LETTERS = 'ABCDEF';
const isMulti = (content: ChoiceContent): boolean => content.options.filter((option) => option.isCorrect).length > 1;

function instructionOf(content: ChoiceContent): string {
  if (content.instruction !== null) return content.instruction;
  if (isMulti(content)) return 'Choose all the correct answers.';
  return 'Choose the best answer.';
}

export const choice: Template<'choice'> = {
  submitLabel: 'Check answer',
  empty: () => ({ type: 'choice', chosenOptionIndexes: [] }),
  isBlank: (_exercise, answer) => answer.chosenOptionIndexes.length === 0,
  isReady: (_exercise, answer) => answer.chosenOptionIndexes.length > 0,

  problem({ exercise: { content, tags } }) {
    const context = content.context === null ? [] : [h('p', 'read', content.context)];
    return {
      kind: 'Multiple choice',
      content: [h('p', 'instruction', instructionOf(content)), ...context, h('p', 'read', content.question), ...tagList(tags)],
    };
  },

  answer({ exercise: { content }, answer, editable, change }) {
    const multi = isMulti(content);
    const chosen = new Set(answer.chosenOptionIndexes);
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
      const picked = options.flatMap((option, index) => (option.input.checked ? [index] : []));
      change({ type: 'choice', chosenOptionIndexes: picked });
    });
    return [group];
  },
};
