// Server-Sent Events framing for POST /api/chat: one `event:`/`data:` pair
// per ChatEvent. The client parses these to render tool progress, answer
// chunks, and citation cards as they arrive.

import type { ChatEvent } from "./run-conversation";

const encoder = new TextEncoder();

export function encodeSseEvent(event: ChatEvent): Uint8Array {
  return encoder.encode(
    `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
  );
}

/** Parses one raw SSE frame back into a ChatEvent (client + tests). */
export function parseSseEvent(frame: string): ChatEvent | null {
  let type: string | undefined;
  let data: string | undefined;
  for (const line of frame.split("\n")) {
    if (line.startsWith("event: ")) type = line.slice(7);
    if (line.startsWith("data: ")) data = line.slice(6);
  }
  if (!type || !data) return null;
  return JSON.parse(data) as ChatEvent;
}
