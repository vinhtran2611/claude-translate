// gap_fill: type the missing words into the text. The AI grades it, with the accepted answers and the explanations from the file.
import { h } from '../dom.ts';
import { tagList } from './parts.ts';
import type { Template } from './types.ts';

export const fill: Template<'gap_fill'> = {
  single: true,
  submitLabel: 'Check answers',
  empty: ({ content }) => ({ type: 'gap_fill', gapAnswers: content.gaps.map(() => '') }),
  isBlank: (_exercise, answer) => answer.gapAnswers.every((gap) => gap.trim() === ''),
  isReady: (_exercise, answer) => answer.gapAnswers.some((gap) => gap.trim() !== ''),

  problem({ exercise: { content, tags }, answer, editable, change }) {
    const typed = content.gaps.map((_gap, index) => answer.gapAnswers[index] ?? '');
    const inputs = content.gaps.map((_gap, index) => {
      const input = Object.assign(h('input', 'gap'), { value: typed[index], readOnly: !editable, spellcheck: false, autocomplete: 'off' });
      input.setAttribute('aria-label', `Gap ${index + 1}`);
      input.addEventListener('input', () => {
        typed[index] = input.value;
        change({ type: 'gap_fill', gapAnswers: [...typed] });
      });
      return input;
    });
    const text = h('p', 'fill-text');
    content.textWithGaps.split(/\{\{\d+\}\}/).forEach((part, index) => {
      text.append(part);
      if (index >= inputs.length) return;
      text.append(inputs[index]);
      const hint = content.gaps[index].hint;
      if (hint !== null) text.append(h('span', 'gap-hint', `(${hint})`));
    });
    const instruction = content.instruction ?? 'Type the missing words.';
    return { kind: 'Gap fill', content: [h('p', 'instruction', instruction), text, ...tagList(tags)] };
  },
};
