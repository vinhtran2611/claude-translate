// Links: the one URL policy.

export interface LinkTarget {
  href: string;
  isExternal: boolean;
}

const CLICKABLE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
// Element ids the renderer writes are prefixed, so a heading called "alert" can never collide with the app's own ids.
export const ANCHOR_ID_PREFIX = 'md-';

// destination as written -> { href, isExternal } or null (render the label as plain text, destination in a tooltip).
//   "#x"          -> "#md-x" when this document has that heading or footnote. anchorIds null (a streaming cell) skips
//                    the check, since the heading may not have arrived yet.
//   http(s), mailto -> opened in a new tab.
//   anything else -> not clickable: javascript:, data:, file:, and relative paths, which would resolve against the
//                    local server and 404.
export function linkTargetOf(destination: string | null, anchorIds: Set<string> | null): LinkTarget | null {
  if (destination === null) return null;
  const trimmed = destination.trim();
  if (trimmed.startsWith('#') && trimmed.length > 1) {
    let fragment = trimmed.slice(1);
    try {
      fragment = decodeURIComponent(fragment);
    } catch {
      // A broken %-escape: the fragment is used as written.
    }
    const id = `${ANCHOR_ID_PREFIX}${fragment.toLowerCase()}`;
    if (anchorIds !== null && !anchorIds.has(id)) return null;
    return { href: `#${id}`, isExternal: false };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (!CLICKABLE_PROTOCOLS.has(url.protocol)) return null;
  return { href: url.href, isExternal: true };
}
