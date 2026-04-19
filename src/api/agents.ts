import { Hono } from 'hono';
import {
  createAgent,
  getAgent,
  getAgentFull,
  getAgentVersion,
  listAgentVersions,
  listAgents,
  patchAgent,
  softDeleteAgent,
} from '../db/queries.js';
import type { AgentVersion } from '../schemas/index.js';
import {
  CreateAgentRequestSchema,
  PatchAgentRequestSchema,
} from '../schemas/index.js';
import { agentStubsRouter, fromTemplateRouter } from './agent-templates.js';

export const agentsRouter = new Hono();

// Mounted on the agents router so /api/v1/agents/from-template/:tpl is
// reachable without introducing a top-level route.
agentsRouter.route('/from-template', fromTemplateRouter);
agentsRouter.route('/', agentStubsRouter);

agentsRouter.get('/', async (c) => {
  return c.json(await listAgents());
});

agentsRouter.post('/', async (c) => {
  const body = CreateAgentRequestSchema.parse(await c.req.json());
  const full = await createAgent(body);
  return c.json(full, 201);
});

agentsRouter.get('/:id', async (c) => {
  const agent = await getAgent(c.req.param('id'));
  if (!agent) return c.json({ error: 'not found' }, 404);
  return c.json(agent);
});

agentsRouter.get('/:id/full', async (c) => {
  const full = await getAgentFull(c.req.param('id'));
  if (!full) return c.json({ error: 'not found' }, 404);
  return c.json(full);
});

agentsRouter.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const body = PatchAgentRequestSchema.parse(await c.req.json());
  try {
    const { full, version } = await patchAgent(id, body);
    return c.json({ agent: full, version });
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      return c.json({ error: 'not found' }, 404);
    }
    throw err;
  }
});

agentsRouter.delete('/:id', async (c) => {
  const ok = await softDeleteAgent(c.req.param('id'));
  if (!ok) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true });
});

// -- versions --------------------------------------------------------------

agentsRouter.get('/:id/versions', async (c) => {
  const rows = await listAgentVersions(c.req.param('id'));
  return c.json(rows);
});

agentsRouter.get('/:id/versions/:v', async (c) => {
  const v = Number(c.req.param('v'));
  if (!Number.isInteger(v) || v < 1) {
    return c.json({ error: 'version must be a positive integer' }, 400);
  }
  const row = await getAgentVersion(c.req.param('id'), v);
  if (!row) return c.json({ error: 'not found' }, 404);
  return c.json(row);
});

/**
 * POST /api/v1/agents/:id/versions/:v/restore
 *
 * Makes version :v the current state by writing a NEW version whose
 * snapshot equals the target's. We never mutate an existing
 * AgentVersion, so restore is always an append that leaves an audit
 * trail.
 */
agentsRouter.post('/:id/versions/:v/restore', async (c) => {
  const id = c.req.param('id');
  const v = Number(c.req.param('v'));
  if (!Number.isInteger(v) || v < 1) {
    return c.json({ error: 'version must be a positive integer' }, 400);
  }

  const target = await getAgentVersion(id, v);
  if (!target) return c.json({ error: 'version not found' }, 404);

  // Apply the snapshot as a PATCH — the helper handles transaction +
  // version-number allocation + parent_version_id wiring.
  const snap = target.snapshot;
  try {
    const { full, version } = await patchAgent(id, {
      name: snap.name,
      initial: snap.initial,
      desc: snap.desc,
      model: snap.model,
      temperature: snap.temperature,
      top_p: snap.top_p,
      max_tokens: snap.max_tokens,
      system_prompt: snap.system_prompt,
      variables: snap.variables,
      tool_ids: snap.tool_ids,
      permission_default: snap.permission_default,
      message: `Restore of v${v}`,
    });
    return c.json({ agent: full, version });
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      return c.json({ error: 'agent not found' }, 404);
    }
    throw err;
  }
});

/**
 * GET /api/v1/agents/:id/versions/:v/diff?against=:w
 *
 * Returns both snapshots plus the list of top-level fields that
 * changed. The client renders the visual diff (system_prompt is the
 * interesting one); keeping the server side shallow keeps the
 * endpoint cheap and framework-agnostic.
 */
agentsRouter.get('/:id/versions/:v/diff', async (c) => {
  const id = c.req.param('id');
  const v = Number(c.req.param('v'));
  const w = Number(c.req.query('against'));
  if (!Number.isInteger(v) || !Number.isInteger(w)) {
    return c.json({ error: 'v and against must be integers' }, 400);
  }
  const [a, b] = await Promise.all([
    getAgentVersion(id, v),
    getAgentVersion(id, w),
  ]);
  if (!a || !b) return c.json({ error: 'version(s) not found' }, 404);
  const changed = diffSnapshots(a.snapshot, b.snapshot);
  return c.json({
    a: { version: a.version, snapshot: a.snapshot },
    b: { version: b.version, snapshot: b.snapshot },
    changed_fields: changed,
  });
});

function diffSnapshots(
  a: AgentVersion['snapshot'],
  b: AgentVersion['snapshot'],
): string[] {
  const changed: string[] = [];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<string>;
  for (const k of keys) {
    const va = (a as unknown as Record<string, unknown>)[k];
    const vb = (b as unknown as Record<string, unknown>)[k];
    if (JSON.stringify(va) !== JSON.stringify(vb)) changed.push(k);
  }
  return changed.sort();
}
