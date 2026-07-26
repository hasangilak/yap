import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import { newEventId, type BusEvent } from '../../events/types.js';

/**
 * Stamp the wire envelope. Identical to the old `run.ts` helper: events carry
 * their own `id`/`at` before they ever reach `publish()`, because
 * `?since_event=<id>` replay and the SSE `id:` field both depend on the id
 * being assigned at creation, not at publish time.
 */
export function envelope(conversation_id: string): {
  id: string;
  at: number;
  conversation_id: string;
} {
  return { id: newEventId(), at: Date.now(), conversation_id };
}

export type Emit = (ev: BusEvent) => void;

/**
 * Push a `BusEvent` onto the graph's `custom` stream channel, where the
 * façade picks it up and hands it to `publish()`.
 *
 * `config.writer` is undefined unless `streamMode` includes `'custom'`, so a
 * caller that forgets it silently drops every event. `graph.ts` always passes
 * it, and `assertCustomStream` below fails loudly if that ever regresses.
 */
export function makeEmit(config: LangGraphRunnableConfig): Emit {
  return (ev: BusEvent) => {
    config.writer?.(ev);
  };
}

export function assertCustomStream(config: LangGraphRunnableConfig): void {
  if (config.writer === undefined) {
    throw new Error(
      'graph invoked without streamMode "custom" — every BusEvent would be dropped',
    );
  }
}
