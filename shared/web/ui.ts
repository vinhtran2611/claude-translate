// Small page helpers shared by every feature's page. Served at /shared/web/ui.ts with its types stripped.

// The element the page must have; throws at load when the markup and the code disagree.
export function requiredElement<Type extends Element>(selector: string, type: new () => Type, root: ParentNode = document): Type {
  const found = root.querySelector(selector);
  if (!(found instanceof type)) throw new Error(`the page has no ${type.name} matching ${selector}`);
  return found;
}

// Body: what the endpoint answers; null for a 204. Throws with the response text on any other non-2xx status.
export async function fetchJson<Body>(url: string, options: RequestInit = {}): Promise<Body> {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  return (response.status === 204 ? null : await response.json()) as Body;
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

// An element with a class and, optionally, its text: the building block for lists drawn in code.
export function createElement<Tag extends keyof HTMLElementTagNameMap>(tag: Tag, class_name = '', text = ''): HTMLElementTagNameMap[Tag] {
  const element = document.createElement(tag);
  if (class_name !== '') element.className = class_name;
  if (text !== '') element.textContent = text;
  return element;
}

// The section a timestamp falls in, counted from local midnight: Today, Yesterday, Previous 7 days, Previous 30 days,
// then the month ("September", or "April 2025" in another year). The same rule as translate's history sidebar.
export function dateGroupOf(timestamp: string, now = new Date()): string {
  const date = new Date(timestamp);
  const today_start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days_before_today = Math.ceil((today_start.getTime() - date.getTime()) / 86400000);
  if (date >= today_start) return 'Today';
  if (days_before_today <= 1) return 'Yesterday';
  if (days_before_today <= 7) return 'Previous 7 days';
  if (days_before_today <= 30) return 'Previous 30 days';
  const month_format: Intl.DateTimeFormatOptions = { month: 'long', ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) };
  return date.toLocaleDateString('en-US', month_format);
}
