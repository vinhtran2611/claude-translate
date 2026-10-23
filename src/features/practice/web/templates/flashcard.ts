// flashcard: say the meaning to yourself, look at the answer, rate how well you knew it. Nothing to grade: the rating is the answer.
import type { FlashcardRating } from '../../api-types.ts';
import { RATING_LABELS } from '../../text.ts';
import { renderDocument } from '../../../../shared/web/markdown.ts';
import { button, h } from '../dom.ts';
import type { Template } from './types.ts';

const RATINGS: FlashcardRating[] = ['didnt_know', 'almost', 'knew'];

export const flashcard: Template<'flashcard'> = {
  single: true,
  empty: () => ({ type: 'flashcard', rating: 'knew' }),
  isBlank: () => true,
  isReady: () => true,

  problem({ exercise: { topic, content }, answer, editable, submit, reveal }) {
    const actions = h('div', 'card-actions');
    const note = h('p', 'card-note');
    const rate = (): void => {
      const buttons = RATINGS.map((rating) => {
        const className = rating === 'knew' ? 'primary-button' : 'secondary-button';
        return button(className, RATING_LABELS[rating], () => submit({ type: 'flashcard', rating }));
      });
      actions.replaceChildren(...buttons);
      note.textContent = 'How well did you know it? The answer is below.';
      actions.querySelector('button')?.focus();
      reveal();
    };
    if (!editable) actions.replaceChildren(h('div', 'rated', 'You rated this ', h('strong', '', RATING_LABELS[answer.rating])));
    else {
      actions.append(button('primary-button', 'Show answer', rate));
      note.textContent = 'Say the meaning in your head first.';
    }
    const hint = content.hint === null ? [] : [h('p', 'card-hint', content.hint)];
    return {
      kind: topic === null ? 'Flashcard' : `Flashcard · ${topic}`,
      content: [h('div', 'card-face', h('p', 'card-word', content.front), ...hint, actions, ...(editable ? [note] : []))],
    };
  },

  evaluation({ exercise: { content } }) {
    const parts: HTMLElement[] = [h('p', 'answer-text', content.back)];
    if (content.example !== null) parts.push(h('p', 'label', 'Example'), h('p', 'read', content.example));
    if (content.explanationMarkdown !== null) {
      const explanation = h('div', 'eval-text doc-content');
      renderDocument(explanation, content.explanationMarkdown);
      parts.push(h('p', 'label', 'Explanation'), explanation);
    }
    // Centred under the word, like the card's front.
    return { title: 'Answer', content: [h('div', 'card-back', ...parts)] };
  },
};
