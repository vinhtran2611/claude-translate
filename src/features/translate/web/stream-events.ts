// Reads the reply of POST /translate: Server-Sent Events, as the server writes them (see StreamEvents in ../api-types.ts).
import type { StreamEvent } from '../api-types.ts';

// One event block: an "event:" line and a "data:" line of JSON.
function parseStreamEvent(raw_event: string): StreamEvent {
  const event_name = /^event: (.*)$/m.exec(raw_event)?.[1];
  const data_json = /^data: (.*)$/m.exec(raw_event)?.[1];
  if (event_name === undefined || data_json === undefined) throw new Error(`Malformed server event: ${raw_event}`);
  return [event_name, JSON.parse(data_json)] as StreamEvent;
}

// Calls onEvent for each event as it arrives; resolves when the reply ends. An abort rejects the read.
export async function readStreamEvents(body: NonNullable<Response['body']>, onEvent: (stream_event: StreamEvent) => void): Promise<void> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;
    // A blank line ends each event; the last part may be an event still arriving.
    const raw_events = buffer.split('\n\n');
    buffer = raw_events.pop() ?? '';
    for (const raw_event of raw_events) onEvent(parseStreamEvent(raw_event));
  }
}
