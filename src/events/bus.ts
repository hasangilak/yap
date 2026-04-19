import { EventEmitter } from 'node:events';
import { insertEvent } from '../db/queries.js';
import type { BusEvent } from './types.js';

// One process-wide emitter; subscribers filter by conversation_id via the
// event name. setMaxListeners(0) removes the default 10-listener warning
// since each active SSE connection adds one listener.
const emitter = new EventEmitter();
emitter.setMaxListeners(0);

/**
 * Persist-then-publish: the event is written to the `events` table
 * before any live subscriber sees it, so `?since_event=<id>` replay
 * can recover every event the wire saw.
 */
export async function publish(ev: BusEvent): Promise<void> {
  await insertEvent(ev);
  emitter.emit(ev.conversation_id, ev);
}

/**
 * Subscribe to a single conversation's live event stream. Returns an
 * unsubscribe function. The caller is responsible for replaying
 * persisted events before subscribing if they want no-gap delivery.
 */
export function subscribe(
  conversationId: string,
  handler: (ev: BusEvent) => void,
): () => void {
  emitter.on(conversationId, handler);
  return () => {
    emitter.off(conversationId, handler);
  };
}
