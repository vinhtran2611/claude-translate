// Reads the reply of POST /translate: Server-Sent Events, as the server writes them (see StreamEvents in ../api-types.ts).
import type { StreamEvent } from '../api-types.ts';

// One event block: an "event:" line and a "data:" line of JSON.
function parseStreamEvent(rawEvent: string): StreamEvent {
  const eventName = /^event: (.*)$/m.exec(rawEvent)?.[1];
  const dataJson = /^data: (.*)$/m.exec(rawEvent)?.[1];
  if (eventName === undefined || dataJson === undefined) throw new Error(`Malformed server event: ${rawEvent}`);
  return [eventName, JSON.parse(dataJson)] as StreamEvent;
}

// Calls onEvent for each event as it arrives; resolves when the reply ends. An abort rejects the read.
export async function readStreamEvents(body: NonNullable<Response['body']>, onEvent: (streamEvent: StreamEvent) => void): Promise<void> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;
    // A blank line ends each event; the last part may be an event still arriving.
    const rawEvents = buffer.split('\n\n');
    buffer = rawEvents.pop() ?? '';
    for (const rawEvent of rawEvents) onEvent(parseStreamEvent(rawEvent));
  }
}
