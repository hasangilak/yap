import type { BusEvent } from './types.js';

/**
 * Serialize a BusEvent as an SSE frame in the chat-box spec envelope
 * (§4 of docs/server-spec.md): named `event:`, a stable `id:` for
 * reconnect replay, and a single-line `data:` JSON payload.
 */
export function encodeSSE(ev: BusEvent): string {
  return `event: ${ev.kind}\nid: ${ev.id}\ndata: ${JSON.stringify(ev)}\n\n`;
}

/**
 * SSE comment heartbeat — keeps intermediaries (proxies, load balancers)
 * from closing idle streams. Safe to send at any time; consumers ignore
 * it.
 */
export const SSE_HEARTBEAT = ': keep-alive\n\n';

export const SSE_CONTENT_TYPE = 'text/event-stream';
