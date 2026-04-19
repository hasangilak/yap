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
 * Server-Sent Events channel carrying every BusEvent emitted by the
 * runtime for this conversation. On open:
 *
 *   1. Any events already in the DB after `since_event` are flushed
 *      (reconnect replay).
 *   2. A live subscription drains to the wire.
 *
 * A tiny race window exists between replay-finished and subscribe-
 * active; Phase 1 ignores it because events only flow in response to
 * POST /messages calls the client initiates itself. A later phase can
 * tighten this by subscribing first and deduping by event.id.
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
    // Replay anything the caller missed.
    const replayed = await listEventsSince(id, since);
    for (const ev of replayed) {
      await s.write(encodeSSE(ev));
    }

    // Live subscription backed by a simple queue + promise.
    const queue: BusEvent[] = [];
    let wake: (() => void) | null = null;

    const unsubscribe = subscribe(id, (ev) => {
      queue.push(ev);
      if (wake) { wake(); wake = null; }
    });

    s.onAbort(() => {
      unsubscribe();
      if (wake) { wake(); wake = null; }
    });

    const heartbeat = setInterval(() => {
      if (!s.aborted) s.write(SSE_HEARTBEAT).catch(() => {});
    }, HEARTBEAT_MS);

    try {
      while (!s.aborted) {
        const ev = queue.shift();
        if (ev) {
          await s.write(encodeSSE(ev));
          continue;
        }
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    } finally {
      clearInterval(heartbeat);
      unsubscribe();
    }
  });
});
