import { Hono } from 'hono';
import { deleteGrant, listGrants } from '../db/queries.js';

export const approvalsRouter = new Hono();

/**
 * Grant management only.
 *
 * Answering an approval no longer lives here — every pause is answered through
 * `POST /api/v1/prompts/:id/respond` (see `prompts.ts`). Grants stayed behind
 * because they are a *standing* permission keyed by (agent, tool), not a
 * per-pause record: they outlive the turn that created them.
 */

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
