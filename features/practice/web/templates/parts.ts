// The pieces the templates draw the same way.
import { h } from '../dom.ts';

// Short chips: the rules to follow, the topic of a lesson. Nothing when there are none.
export function tagList(tags: string[]): HTMLElement[] {
  return tags.length === 0 ? [] : [h('div', 'tags', ...tags.map((tag) => h('span', 'tag', tag)))];
}

// The box an answer is typed in, filling its pane.
export function answerBox(text: string, is_editable: boolean, is_long: boolean, change: (text: string) => void): HTMLTextAreaElement {
  const box = Object.assign(h('textarea', is_long ? 'answer-box is-long' : 'answer-box'), {
    value: text, readOnly: !is_editable, spellcheck: false, autocomplete: 'off', lang: 'en', placeholder: is_editable ? 'Type your answer here…' : '',
  });
  box.setAttribute('aria-label', 'Your answer');
  box.setAttribute('autocorrect', 'off');
  box.setAttribute('autocapitalize', 'off');
  box.addEventListener('input', () => change(box.value));
  return box;
}
