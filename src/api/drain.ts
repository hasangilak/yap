import { publish } from '../events/bus.js';
import type { BusEvent } from '../events/types.js';

/**
 * Drain a turn generator in the background, publishing every event.
 *
 * Turns outlive the request that started them: a handler returns as soon as it
 * has the node the caller needs, and the rest of the turn continues here. The
 * generator must always be drained to completion — an abandoned LangGraph
 * stream applies backpressure and stalls the run — so errors are swallowed to
 * a log rather than left to reject an unobserved promise. Failures still reach
 * the client, because the graph emits its own terminal `error` event.
 */
export function detachAndPublish(
  gen: AsyncGenerator<BusEvent, void, unknown>,
  label: string,
): void {
  void (async () => {
    try {
      for await (const ev of gen) {
        await publish(ev);
      }
    } catch (err) {
      console.error(`[${label}] unhandled:`, err);
    }
  })();
}
