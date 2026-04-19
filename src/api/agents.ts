import { Hono } from 'hono';
import { getAgent, listAgents } from '../db/queries.js';

export const agentsRouter = new Hono();

agentsRouter.get('/', async (c) => {
  return c.json(await listAgents());
});

agentsRouter.get('/:id', async (c) => {
  const agent = await getAgent(c.req.param('id'));
  if (!agent) return c.json({ error: 'not found' }, 404);
  return c.json(agent);
});
