import { Hono } from 'hono';
import {
  cancelOpenPromptsForNode,
  findActiveAssistantNode,
  getConversationRaw,
  requestCancel,
  updateConversationPointers,
  updateNode,
} from '../db/queries.js';
import { publish } from '../events/bus.js';
import { newEventId } from '../events/types.js';
import { getPendingInterrupts } from '../runtime/graph/index.js';
import { abortActiveRound } from '../runtime/graph/steering.js';

export const cancelRouter = new Hono();

/**
 * POST /api/v1/conversations/:id/cancel
 *
 * Stop the running turn and wait for the user's next message. This is the stop
 * button, and it is **not** `interject`: interject aborts the model call and
 * keeps going with new guidance, cancel aborts and ends the turn.
 *
 * Order matters. The flag is persisted first, because it is what every other
 * path keys off:
 *
 *  - `callModel` reads it after each round and `afterCallModel` routes to
 *    `finalize`, outranking even a tool call the model just proposed.
 *  - `POST /prompts/:id/respond` refuses to resume a cancelled turn, so a
 *    decision arriving after the stop cannot restart it.
 *  - Boot recovery replays unfinished turns, so an in-memory flag would let a
 *    restart resurrect a turn the user had already stopped.
 *
 * Two shapes of running turn, and they need different handling:
 *
 *  1. **Generating.** Aborting the model call is enough — the graph wakes,
 *     sees the flag, and finalizes through the normal path so partial output,
 *     the node row and `node.finalized` all stay consistent.
 *  2. **Parked on a prompt.** No round is in flight and none will start on its
 *     own, because the graph is sitting at an `interrupt()` waiting for a human
 *     who is never going to answer. Nothing would ever finalize it, so this
 *     handler finalizes the node itself. The checkpoint is left abandoned,
 *     which is harmless: `cancel_requested` makes any later response a 409.
 */
cancelRouter.post('/conversations/:id/cancel', async (c) => {
  const conversationId = c.req.param('id');
  const conv = await getConversationRaw(conversationId);
  if (!conv) return c.json({ error: 'not found' }, 404);

  const active = await findActiveAssistantNode(conversationId);
  if (!active) {
    return c.json({ error: 'no turn in flight for this conversation' }, 409);
  }

  await requestCancel(active.id);
  await cancelOpenPromptsForNode(active.id);

  // Ask the checkpoint, not the in-memory controller map, whether a round is
  // live. A thread sitting at an `interrupt()` has no round by definition, so
  // this keeps `aborted` truthful even if a controller lingers — and a stale
  // controller previously made this report `aborted: true` for a parked turn,
  // skipping the finalize below and stranding the node as `streaming`.
  const parked = (await getPendingInterrupts(active.id)).length > 0;
  const aborted = parked ? false : abortActiveRound(active.id);

  // Announce the cancel **before** any finalize. In the generating case the
  // graph emits `node.finalized` later, so `turn.cancelled` naturally arrives
  // first; publishing it first here too means a client can always label the
  // finalization it is about to receive as "stopped" rather than "complete",
  // without special-casing which path it came through.
  await publish({
    kind: 'turn.cancelled',
    id: newEventId(),
    at: Date.now(),
    conversation_id: conversationId,
    node_id: active.id,
    aborted,
    finalized: parked,
  });

  if (parked) {
    const finalized = await updateNode(active.id, {
      streaming: false,
      status: null,
    });
    await updateConversationPointers(conversationId, {
      active_leaf_id: active.id,
      updated_at: new Date(),
    });
    if (finalized) {
      await publish({
        kind: 'node.finalized',
        id: newEventId(),
        at: Date.now(),
        conversation_id: conversationId,
        node_id: active.id,
        node: finalized,
      });
    }
    await publish({
      kind: 'active_leaf.changed',
      id: newEventId(),
      at: Date.now(),
      conversation_id: conversationId,
      active_leaf_id: active.id,
    });
  }

  return c.json({ ok: true, node_id: active.id, aborted, finalized: parked });
});
