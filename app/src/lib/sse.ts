// Reads a text/event-stream response body (what /api/ask streams answers over) as parsed events.
// Comments (": ping") and events without data are skipped; data is JSON.

export type SseEvent = { event: string; data: unknown };

/** Parses one event block (the text between blank lines), or null when it carries no data. */
export function parseEvent(block: string): SseEvent | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (!data.length) return null;
  try {
    return { event, data: JSON.parse(data.join('\n')) as unknown };
  } catch {
    return null;
  }
}

/** Yields each event of a response body as it arrives. */
export async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let end: RegExpExecArray | null;
      while ((end = /\r?\n\r?\n/.exec(buf))) {
        const ev = parseEvent(buf.slice(0, end.index));
        buf = buf.slice(end.index + end[0].length);
        if (ev) yield ev;
      }
    }
    const last = parseEvent(buf + decoder.decode());
    if (last) yield last;
  } finally {
    reader.releaseLock();
  }
}
