// Small page helpers shared by every feature's page. Served at /shared/web/ui.ts with its types stripped.

// The element the page must have; throws at load when the markup and the code disagree.
export function requiredElement<Type extends Element>(selector: string, type: new () => Type, root: ParentNode = document): Type {
  const found = root.querySelector(selector);
  if (!(found instanceof type)) throw new Error(`the page has no ${type.name} matching ${selector}`);
  return found;
}

// localStorage can throw (private window, blocked storage); a remembered choice is a convenience, never required.
export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not remembered; nothing else depends on it.
  }
}

export function removeStored(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Nothing was stored, or it cannot be changed; nothing else depends on it.
  }
}

// An element with a class and, optionally, its text: the building block for lists drawn in code.
export function createElement<Tag extends keyof HTMLElementTagNameMap>(tag: Tag, class_name = '', text = ''): HTMLElementTagNameMap[Tag] {
  const element = document.createElement(tag);
  if (class_name !== '') element.className = class_name;
  if (text !== '') element.textContent = text;
  return element;
}

// Case- and diacritic-insensitive text for searching: "dich" finds "dịch", "doan" finds "đoạn".
export function foldForSearch(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/gi, 'd').toLowerCase();
}

// The History section a timestamp falls in, counted from local midnight: Today, Yesterday, Previous 7 days, Previous 30 days,
// then the month ("September", or "April 2025" in another year).
export function historyGroupOf(created_at: string, now = new Date()): string {
  const created = new Date(created_at);
  const today_start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days_before_today = Math.ceil((today_start.getTime() - created.getTime()) / 86400000);
  if (created >= today_start) return 'Today';
  if (days_before_today <= 1) return 'Yesterday';
  if (days_before_today <= 7) return 'Previous 7 days';
  if (days_before_today <= 30) return 'Previous 30 days';
  const month_format: Intl.DateTimeFormatOptions = { month: 'long', ...(created.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) };
  return created.toLocaleDateString('en-US', month_format);
}

// The inline icons, the same drawings as Claude Translate's. Trusted constants, so they may be set as markup.
const ICONS = {
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/></svg>',
  sidebar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="15" rx="3"/><path d="M9.5 4.5v15"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 8.5v7M8.5 12h7"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10l5 5 5-5"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 6.5L9 12l5.5 5.5"/></svg>',
  star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2.5l2.2 6.6 6.8 2.4-6.8 2.4L12 20.5l-2.2-6.6-6.8-2.4 6.8-2.4z"/></svg>',
  thinkingChevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 6.5l5.5 5.5-5.5 5.5"/></svg>',
};

export function createIcon(name: keyof typeof ICONS, class_name = ''): SVGSVGElement {
  const template = document.createElement('template');
  template.innerHTML = ICONS[name];
  const icon = template.content.firstElementChild as SVGSVGElement;
  if (class_name !== '') icon.setAttribute('class', class_name);
  icon.setAttribute('aria-hidden', 'true');
  return icon;
}

// Reads a Server-Sent Events response (`event: name` and `data: json`, blocks split by a blank line) and calls onEvent for
// each, until the stream ends. Rejects when the connection breaks or the request is aborted.
export async function readServerEvents(response: Response, onEvent: (name: string, data: unknown) => void): Promise<void> {
  if (!response.ok || response.body === null) throw new Error((await response.text()) || `HTTP ${response.status}`);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() ?? '';
    for (const block of blocks) {
      const name = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (name !== undefined && data !== undefined) onEvent(name, JSON.parse(data));
    }
  }
}
