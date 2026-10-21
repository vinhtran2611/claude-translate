// fill: type the missing words into the text. The AI grades it, with the accepted answers and the reasons from the file.
import { h } from '../dom.ts';
import { tagList } from './parts.ts';
import type { Template } from './types.ts';

export const fill: Template<'fill'> = {
  single: true,
  submitLabel: 'Check answers',
  empty: ({ content }) => ({ gaps: content.gaps.map(() => '') }),
  isBlank: (_exercise, answer) => answer.gaps.every((gap) => gap.trim() === ''),
  isReady: (_exercise, answer) => answer.gaps.some((gap) => gap.trim() !== ''),

  problem({ exercise: { content, tags }, answer, editable, change }) {
    const typed = content.gaps.map((_gap, index) => answer.gaps[index] ?? '');
    const inputs = content.gaps.map((_gap, index) => {
      const input = Object.assign(h('input', 'gap'), { value: typed[index], readOnly: !editable, spellcheck: false, autocomplete: 'off' });
      input.setAttribute('aria-label', `Gap ${index + 1}`);
      input.addEventListener('input', () => {
        typed[index] = input.value;
        change({ gaps: [...typed] });
      });
      return input;
    });
    const text = h('p', 'fill-text');
    content.text.split(/\{\{\d+\}\}/).forEach((part, index) => {
      text.append(part);
      if (index >= inputs.length) return;
      text.append(inputs[index]);
      const hint = content.gaps[index].hint;
      if (hint !== undefined) text.append(h('span', 'gap-hint', `(${hint})`));
    });
    return { kind: 'Fill in the blanks', content: [h('p', 'instruction', content.instruction ?? 'Type the missing words.'), text, ...tagList(tags)] };
  },
};
