import { Hono } from 'hono';
import {
  deleteGrant,
  getApproval,
  insertGrant,
  listGrants,
  recordApprovalDecision,
} from '../db/queries.js';
import { publish } from '../events/bus.js';
import { newEventId } from '../events/types.js';
import { getPendingInterrupts } from '../runtime/graph/index.js';
import { resumeTurn } from '../runtime/run.js';
import { ApprovalDecisionRequestSchema } from '../schemas/index.js';
import { detachAndPublish } from './drain.js';

export const approvalsRouter = new Hono();

/**
 * POST /api/v1/approvals/:id/decide
 *
 * Records the decision, then resumes the paused turn.
 *
 * The decision is persisted **before** the graph is resumed, so an answer is
 * never lost to a failure in between. Resuming is a checkpointer operation
 * rather than a promise handoff, which is what makes this work long after the
 * original request returned, from any request, and across a restart — the case
 * that used to strand a turn permanently.
 *
 * `approval.decided` is emitted by the graph's `resolvePrompt` node so it stays
 * ordered with the rest of the turn. If there is nothing to resume (no pending
 * interrupt for this thread — e.g. a turn whose checkpoint predates this
 * feature), the event is published here instead so the timeline still records
 * the decision.
 *
 * 'always' writes the grant here as well as in the graph; the upsert makes the
 * double-write a no-op.
 */
approvalsRouter.post('/:id/decide', async (c) => {
  const id = c.req.param('id');
  const body = ApprovalDecisionRequestSchema.parse(await c.req.json());

  const ap = await getApproval(id);
  if (!ap) return c.json({ error: 'not found' }, 404);
  if (ap.decision) {
    return c.json({ error: 'already decided', decision: ap.decision }, 409);
  }

  const rememberKey = body.decision === 'always'
    ? `tool:${ap.tool}:conversation:${ap.conversationId}`
    : null;

  await recordApprovalDecision(id, body.decision, rememberKey);

  if (body.decision === 'always') {
    const { getConversationRaw } = await import('../db/queries.js');
    const conv = await getConversationRaw(ap.conversationId);
    if (conv) await insertGrant(conv.agentId, ap.tool);
  }

  // The assistant node id is the graph thread id, so the paused turn is one
  // lookup away from the row we already have.
  const pending = await getPendingInterrupts(ap.nodeId);
  if (pending.length === 0) {
    await publish({
      kind: 'approval.decided',
      id: newEventId(),
      at: Date.now(),
      conversation_id: ap.conversationId,
      node_id: ap.nodeId,
      approval_id: id,
      decision: body.decision,
    });
    return c.json({ ok: true, decision: body.decision, resumed: false });
  }

  detachAndPublish(
    resumeTurn({
      conversationId: ap.conversationId,
      asstNodeId: ap.nodeId,
      resume: body.decision,
    }),
    'approval-resume',
  );

  return c.json({ ok: true, decision: body.decision, resumed: true });
});

/**
 * GET /api/v1/approvals/grants
 *
 * Lists active "allow always" grants; powers the settings UI where a
 * user can review what's been remembered and revoke any of it.
 */
approvalsRouter.get('/grants', async (c) => {
  const rows = await listGrants();
  return c.json(
    rows.map((g) => ({
      key: `tool:${g.toolId}:agent:${g.agentId}`,
      agent_id: g.agentId,
      tool_id: g.toolId,
      created_at: g.createdAt.toISOString(),
    })),
  );
});

/**
 * DELETE /api/v1/approvals/grants/:key
 *
 * Revokes a grant. `key` has the shape `tool:<tool>:agent:<agent>` so
 * it's both a URL-safe identifier and self-describing in settings
 * responses.
 */
approvalsRouter.delete('/grants/:key', async (c) => {
  const key = c.req.param('key');
  const match = key.match(/^tool:([^:]+):agent:(.+)$/);
  if (!match) return c.json({ error: 'malformed key' }, 400);
  const [, toolId, agentId] = match;
  const deleted = await deleteGrant(agentId!, toolId!);
  if (!deleted) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true });
});
