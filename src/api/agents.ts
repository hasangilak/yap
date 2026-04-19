import { Hono } from 'hono';
import {
  createAgent,
  getAgent,
  getAgentFull,
  listAgents,
  patchAgent,
  softDeleteAgent,
} from '../db/queries.js';
import {
  CreateAgentRequestSchema,
  PatchAgentRequestSchema,
} from '../schemas/index.js';

export const agentsRouter = new Hono();

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
