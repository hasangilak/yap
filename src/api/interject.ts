import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import {
  findActiveAssistantNode,
  getConversationRaw,
  insertInterjection,
} from '../db/queries.js';
import { publish } from '../events/bus.js';
import { newEventId } from '../events/types.js';
import { abortActiveRound } from '../runtime/graph/steering.js';
import { InterjectRequestSchema } from '../schemas/index.js';

export const interjectRouter = new Hono();

/**
 * POST /api/v1/conversations/:id/interject
 *
 * Steer a turn that is already running, without cancelling it.
 *
 * Two things happen, in this order:
 *
 *  1. **Persist the text.** This is the durable half. Once the row exists the
 *     user has been told we accepted their input, so it must survive a restart —
 *     `callModel` reads unconsumed rows at the start of every round.
 *  2. **Abort the in-flight model call.** This is the ephemeral half, and it is
 *     only an optimisation: it stops the model mid-sentence so the steering
 *     takes effect now instead of after the current round. The abort is caught
 *     inside `streamModelRound`, so partial output is kept and the graph still
 *     checkpoints cleanly.
 *
 * `aborted: false` is a normal outcome, not an error — the turn was paused on a
 * prompt, between rounds, or is running in another process. The text is queued
 * either way. Only step 1 is load-bearing.
 *
 * Note the abort signal is **ours**, never the HTTP request's: wiring it to the
 * request would let a client disconnect kill a turn meant to outlive it.
 */
interjectRouter.post('/conversations/:id/interject', async (c) => {
  const conversationId = c.req.param('id');
  const conv = await getConversationRaw(conversationId);
  if (!conv) return c.json({ error: 'not found' }, 404);

  const raw: unknown = await c.req.json().catch(() => null);
  const parsed = InterjectRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json(
      {
        error: 'invalid body',
        expected: { text: 'non-empty string' },
        issues: parsed.error.issues,
      },
      400,
    );
  }

  // Interjecting only means something while a turn is live. Queueing text
  // against a finished turn would strand it forever, so say so instead.
  const active = await findActiveAssistantNode(conversationId);
  if (!active) {
    return c.json({ error: 'no turn in flight for this conversation' }, 409);
  }

  const id = `ij-${randomUUID().slice(0, 8)}`;
  await insertInterjection({
    id,
    conversation_id: conversationId,
    node_id: active.id,
    text: parsed.data.text,
  });

  const aborted = abortActiveRound(active.id);

  await publish({
    kind: 'interjection.received',
    id: newEventId(),
    at: Date.now(),
    conversation_id: conversationId,
    node_id: active.id,
    interjection_id: id,
    text: parsed.data.text,
    aborted,
  });

  return c.json({ ok: true, interjection_id: id, node_id: active.id, aborted });
});
