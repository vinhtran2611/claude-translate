// essay: free writing, an IELTS Task 2 essay.
import { countWords } from '../../text.ts';
import { h } from '../dom.ts';
import { formatClock } from '../format.ts';
import { answerBox, tagList } from './parts.ts';
import type { Template } from './types.ts';

export const essay: Template<'essay'> = {
  submitLabel: 'Submit',
  timed: true,
  empty: () => ({ type: 'essay', text: '' }),
  isBlank: (_exercise, answer) => answer.text.trim() === '',
  isReady: (_exercise, answer) => answer.text.trim() !== '',

  problem({ exercise: { content, tags } }) {
    const guide = [`At least ${content.minWords} words`];
    if (content.suggestedMinutes !== null) guide.push(`About ${content.suggestedMinutes} minutes`);
    return { kind: 'Essay', content: [h('p', 'read', content.instruction), ...tagList([...guide, ...content.constraints, ...tags])] };
  },

  answer({ answer, editable, change }) {
    return [answerBox(answer.text, editable, true, (text) => change({ type: 'essay', text }))];
  },

  // The clock only shows the time you have spent; it never stops you.
  status({ exercise: { content }, answer, editable }, elapsedMs) {
    const words = countWords(answer.text);
    const target = content.minWords;
    const isMet = words >= target;
    const parts: (Node | string)[] = [h('strong', '', isMet ? `${words} words` : `${words} of ${target} words`)];
    if (isMet) parts.push(' · ', h('span', 'is-met', 'Target reached'));
    if (editable) parts.push(` · ⏱ ${formatClock(elapsedMs)}`);
    return parts;
  },
};
