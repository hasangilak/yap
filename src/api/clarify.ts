import { Hono } from 'hono';
import { getClarify, recordClarifyResponse } from '../db/queries.js';
import { publish } from '../events/bus.js';
import { newEventId } from '../events/types.js';
import { getPendingInterrupts } from '../runtime/graph/index.js';
import { resumeTurn } from '../runtime/run.js';
import { ClarifyAnswerRequestSchema } from '../schemas/index.js';
import { detachAndPublish } from './drain.js';

export const clarifyRouter = new Hono();

/**
 * POST /api/v1/clarify/:id/answer
 *
 * Records the structured answer, then resumes the paused turn.
 *
 * Note the ordering: the answer is written to the `Clarify` row **before** the
 * graph is resumed. Previously this handler persisted nothing — it published
 * the event and woke an in-process promise, leaving `recordClarifyResponse` to
 * the runtime after `awaitAnswer` resolved. If no runtime was listening the
 * answer was silently lost, and the approval path (which did persist first)
 * disagreed with this one. Both now persist first.
 *
 * `clarify.answered` is emitted by the graph's `resolvePrompt` node so it stays
 * ordered with the rest of the turn; it is published here only when there is
 * nothing to resume.
 */
clarifyRouter.post('/:id/answer', async (c) => {
  const id = c.req.param('id');
  const body = ClarifyAnswerRequestSchema.parse(await c.req.json());

  const row = await getClarify(id);
  if (!row) return c.json({ error: 'not found' }, 404);
  if (row.response) {
    return c.json({ error: 'already answered' }, 409);
  }

  await recordClarifyResponse(id, body);

  const pending = await getPendingInterrupts(row.nodeId);
  if (pending.length === 0) {
    await publish({
      kind: 'clarify.answered',
      id: newEventId(),
      at: Date.now(),
      conversation_id: row.conversationId,
      node_id: row.nodeId,
      clarify_id: id,
      response: body,
    });
    return c.json({ ok: true, resumed: false });
  }

  detachAndPublish(
    resumeTurn({
      conversationId: row.conversationId,
      asstNodeId: row.nodeId,
      resume: body,
    }),
    'clarify-resume',
  );

  return c.json({ ok: true, resumed: true });
});
