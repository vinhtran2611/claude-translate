// flashcard: say the meaning to yourself, look at the answer, rate how well you knew it. Nothing to grade: the rating is the answer.
import type { Rating } from '../../api.ts';
import { RATING_LABELS } from '../../text.ts';
import { renderDocument } from '../../../../shared/web/markdown.ts';
import { button, h } from '../dom.ts';
import type { Template } from './types.ts';

const RATINGS: Rating[] = ['unknown', 'almost', 'known'];

export const flashcard: Template<'flashcard'> = {
  single: true,
  empty: () => ({ rating: 'known' }),
  isBlank: () => true,
  isReady: () => true,

  problem({ exercise: { topic, content }, answer, editable, submit, reveal }) {
    const actions = h('div', 'card-actions');
    const note = h('p', 'card-note');
    const rate = (): void => {
      actions.replaceChildren(...RATINGS.map((rating) => button(rating === 'known' ? 'primary-button' : 'secondary-button', RATING_LABELS[rating], () => submit({ rating }))));
      note.textContent = 'How well did you know it? The answer is below.';
      actions.querySelector('button')?.focus();
      reveal();
    };
    if (!editable) actions.replaceChildren(h('div', 'rated', 'You rated this ', h('strong', '', RATING_LABELS[answer.rating])));
    else {
      actions.append(button('primary-button', 'Show answer', rate));
      note.textContent = 'Say the meaning in your head first.';
    }
    return {
      kind: topic === null ? 'Flashcard' : `Flashcard · ${topic}`,
      content: [h('div', 'card-face',
        h('p', 'card-word', content.front),
        ...(content.hint === undefined ? [] : [h('p', 'card-hint', content.hint)]),
        actions, ...(editable ? [note] : []))],
    };
  },

  evaluation({ exercise: { content } }) {
    const explanation = h('div', 'eval-text doc-content');
    if (content.explanation !== undefined) renderDocument(explanation, content.explanation);
    return {
      title: 'Answer',
      content: [
        h('p', 'answer-text', content.back),
        ...(content.example === undefined ? [] : [h('p', 'label', 'Example'), h('p', 'read', content.example)]),
        ...(content.explanation === undefined ? [] : [h('p', 'label', 'Explanation'), explanation]),
      ],
    };
  },
};
