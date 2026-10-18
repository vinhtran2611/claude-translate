// write: free writing, an IELTS Task 2 essay.
import { countWords } from '../../text.ts';
import { h } from '../dom.ts';
import { formatClock } from '../format.ts';
import { answerBox, tagList } from './parts.ts';
import type { Template } from './types.ts';

const DEFAULT_MIN_WORDS = 250;

export const write: Template<'write'> = {
  submitLabel: 'Submit',
  timed: true,
  empty: () => ({ text: '' }),
  isBlank: (_exercise, answer) => answer.text.trim() === '',
  isReady: (_exercise, answer) => answer.text.trim() !== '',

  problem({ exercise: { content, tags } }) {
    const guide = [`At least ${content.min_words ?? DEFAULT_MIN_WORDS} words`, ...(content.minutes === undefined ? [] : [`About ${content.minutes} minutes`])];
    return { kind: 'Free writing', content: [h('p', 'read', content.prompt), ...tagList([...guide, ...tags])] };
  },

  answer({ answer, editable, change }) {
    return [answerBox(answer.text, editable, true, (text) => change({ text }))];
  },

  // The clock only shows the time you have spent; it never stops you.
  status({ exercise: { content }, answer, editable }, elapsed_ms) {
    const words = countWords(answer.text);
    const target = content.min_words ?? DEFAULT_MIN_WORDS;
    return [h('strong', '', words >= target ? `${words} words` : `${words} of ${target} words`),
      ...(words >= target ? [' · ', h('span', 'is-met', 'Target reached')] : []),
      ...(editable ? [` · ⏱ ${formatClock(elapsed_ms)}`] : [])];
  },
};
