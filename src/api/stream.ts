import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { getConversationRaw, listEventsSince } from '../db/queries.js';
import { subscribe } from '../events/bus.js';
import {
  encodeSSE,
  SSE_CONTENT_TYPE,
  SSE_HEARTBEAT,
} from '../events/encoder.js';
import type { BusEvent } from '../events/types.js';

export const streamRouter = new Hono();

const HEARTBEAT_MS = 15_000;

/**
 * GET /api/v1/conversations/:id/stream[?since_event=<id>]
 *
 * Subscribe-first, replay-after, dedupe-by-id — the race window that
 * existed through Phase 1 is closed here:
 *
 *   1. Subscribe to the bus into a buffer BEFORE querying the DB.
 *   2. Replay persisted events since `since_event` (or from the start)
 *      to the wire, recording every id we emitted.
 *   3. Flush the buffer, dropping any event whose id was already seen
 *      during replay.
 *   4. Switch to a live pump.
 *
 * Any event produced between replay-end and subscribe-active in the
 * old design would have been lost; subscribe-first makes that window
 * empty. A 15s heartbeat keeps intermediaries from idling the stream
 * shut; abort cleans up subscription + heartbeat together.
 */
streamRouter.get('/conversations/:id/stream', async (c) => {
  const id = c.req.param('id');
  const conv = await getConversationRaw(id);
  if (!conv) return c.json({ error: 'not found' }, 404);

  const since = c.req.query('since_event') ?? null;

  c.header('Content-Type', SSE_CONTENT_TYPE);
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'keep-alive');
  c.header('X-Accel-Buffering', 'no');

  return stream(c, async (s) => {
    // 1. Subscribe first — accumulate live events into a buffer while
    //    we run the historical replay query.
    const preReplayBuffer: BusEvent[] = [];
    const liveQueue: BusEvent[] = [];
    let handoff = false;
    let wake: (() => void) | null = null;

    const unsubscribe = subscribe(id, (ev) => {
      if (handoff) {
        liveQueue.push(ev);
        if (wake) { wake(); wake = null; }
      } else {
        preReplayBuffer.push(ev);
      }
    });

    s.onAbort(() => {
      unsubscribe();
      if (wake) { wake(); wake = null; }
    });

    const heartbeat = setInterval(() => {
      if (!s.aborted) s.write(SSE_HEARTBEAT).catch(() => {});
    }, HEARTBEAT_MS);

    try {
      // 2. Flush historical events since the client's cursor.
      const replayed = await listEventsSince(id, since);
      const seen = new Set<string>();
      for (const ev of replayed) {
        seen.add(ev.id);
        await s.write(encodeSSE(ev));
      }

      // 3. Flush anything that arrived while we were replaying,
      //    dropping events whose ids were already covered by the
      //    replay.
      for (const ev of preReplayBuffer) {
        if (seen.has(ev.id)) continue;
        seen.add(ev.id);
        await s.write(encodeSSE(ev));
      }
      handoff = true;

      // 4. Live pump.
      while (!s.aborted) {
        const ev = liveQueue.shift();
        if (ev) {
          if (!seen.has(ev.id)) {
            seen.add(ev.id);
            await s.write(encodeSSE(ev));
          }
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      clearInterval(heartbeat);
      unsubscribe();
    }
  });
});
