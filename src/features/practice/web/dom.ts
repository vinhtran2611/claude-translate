// Building DOM without innerHTML: every text from the file, the database or the grader goes in as a text node.
import { createElement } from '../../../shared/web/ui.ts';

export function h<Tag extends keyof HTMLElementTagNameMap>(tag: Tag, className = '', ...children: (Node | string)[]): HTMLElementTagNameMap[Tag] {
  const element = createElement(tag, className);
  element.append(...children);
  return element;
}

export function link(href: string, className: string, ...children: (Node | string)[]): HTMLAnchorElement {
  return Object.assign(h('a', className, ...children), { href });
}

export function button(className: string, label: string, onClick: () => void): HTMLButtonElement {
  const element = Object.assign(h('button', className, label), { type: 'button' as const });
  element.addEventListener('click', onClick);
  return element;
}
