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
import { resolveApproval } from '../runtime/approvals.js';
import { ApprovalDecisionRequestSchema } from '../schemas/index.js';

export const approvalsRouter = new Hono();

/**
 * POST /api/v1/approvals/:id/decide
 *
 * Records the user's decision and, if there's still a runtime waiting
 * for it in this process, wakes that runtime so the turn can continue.
 * An `approval.decided` event is always published — whether or not the
 * runtime was live — so the stream + the timeline see the decision.
 *
 * 'always' adds the grant here defensively; the runtime also writes
 * the grant on its path. Double-write is a no-op thanks to upsert.
 */
approvalsRouter.post('/:id/decide', async (c) => {
  const id = c.req.param('id');
  const body = ApprovalDecisionRequestSchema.parse(await c.req.json());

  const ap = await getApproval(id);
  if (!ap) return c.json({ error: 'not found' }, 404);
  if (ap.decision) {
    return c.json({ error: 'already decided', decision: ap.decision }, 409);
  }

  // Look up the agentId through the conversation so we can key a grant
  // if the decision is 'always'.
  const rememberKey = body.decision === 'always'
    ? `tool:${ap.tool}:conversation:${ap.conversationId}`
    : null;

  await recordApprovalDecision(id, body.decision, rememberKey);

  // Publish the decided event before resolving so any SSE subscriber
  // sees it; the runtime will emit its own approval.decided too, but
  // that path only runs if the runtime was waiting. This one guarantees
  // the timeline captures the decision even if the runtime died.
  await publish({
    kind: 'approval.decided',
    id: newEventId(),
    at: Date.now(),
    conversation_id: ap.conversationId,
    node_id: ap.nodeId,
    approval_id: id,
    decision: body.decision,
  });

  // Grant on 'always' — belt-and-braces; runtime will also write this.
  if (body.decision === 'always') {
    // We don't have agent_id directly on the approval row; derive via
    // conversation. (A later pass can denormalize agentId onto
    // approvals if this lookup becomes a hot path.)
    const { getConversationRaw } = await import('../db/queries.js');
    const conv = await getConversationRaw(ap.conversationId);
    if (conv) await insertGrant(conv.agentId, ap.tool);
  }

  const wokeRuntime = resolveApproval(id, body.decision);

  return c.json({ ok: true, decision: body.decision, runtime_awake: wokeRuntime });
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
