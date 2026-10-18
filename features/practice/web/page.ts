// What a view gets from the router: where to draw, and the signal that ends when the person goes elsewhere.
export interface Page {
  main: HTMLElement;
  // Aborted on the next navigation. Every request and timer of a view uses it, so a late answer is never drawn.
  signal: AbortSignal;
  setTitle(view: string): void;
}

// Resolves after ms; rejects when the signal aborts.
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = (): void => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
