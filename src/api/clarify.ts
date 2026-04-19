import { Hono } from 'hono';
import { getClarify } from '../db/queries.js';
import { publish } from '../events/bus.js';
import { newEventId } from '../events/types.js';
import { resolveClarify } from '../runtime/clarifications.js';
import { ClarifyAnswerRequestSchema } from '../schemas/index.js';

export const clarifyRouter = new Hono();

/**
 * POST /api/v1/clarify/:id/answer
 *
 * Records the structured answer and wakes the paused runtime so the
 * turn can continue. Publishes a clarify.answered event either way —
 * even if the runtime isn't alive to observe, the stream + timeline
 * pick up the decision.
 */
clarifyRouter.post('/:id/answer', async (c) => {
  const id = c.req.param('id');
  const body = ClarifyAnswerRequestSchema.parse(await c.req.json());

  const row = await getClarify(id);
  if (!row) return c.json({ error: 'not found' }, 404);
  if (row.response) {
    return c.json({ error: 'already answered' }, 409);
  }

  // Publish the event first so it lands on the wire for any open
  // stream; the runtime's own emission (if alive) is redundant but
  // that's OK — events are idempotent-keyed by id.
  await publish({
    kind: 'clarify.answered',
    id: newEventId(),
    at: Date.now(),
    conversation_id: row.conversationId,
    node_id: row.nodeId,
    clarify_id: id,
    response: body,
  });

  const awake = resolveClarify(id, body);

  return c.json({ ok: true, runtime_awake: awake });
});
