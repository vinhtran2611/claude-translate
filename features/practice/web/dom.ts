// Building DOM without innerHTML: every text from the file, the database or the grader goes in as a text node.
import { createElement } from '../../../shared/web/ui.ts';

export function h<Tag extends keyof HTMLElementTagNameMap>(tag: Tag, class_name = '', ...children: (Node | string)[]): HTMLElementTagNameMap[Tag] {
  const element = createElement(tag, class_name);
  element.append(...children);
  return element;
}

export function link(href: string, class_name: string, ...children: (Node | string)[]): HTMLAnchorElement {
  return Object.assign(h('a', class_name, ...children), { href });
}

export function button(class_name: string, label: string, onClick: () => void): HTMLButtonElement {
  const element = Object.assign(h('button', class_name, label), { type: 'button' as const });
  element.addEventListener('click', onClick);
  return element;
}
