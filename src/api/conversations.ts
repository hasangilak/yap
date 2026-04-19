import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import {
  firstAgentId,
  getConversation,
  getConversationTree,
  insertConversation,
  listConversations,
} from '../db/queries.js';
import { CreateConversationRequestSchema } from '../schemas/index.js';

export const conversationsRouter = new Hono();

conversationsRouter.get('/', async (c) => {
  const rows = await listConversations();
  return c.json(rows);
});

conversationsRouter.post('/', async (c) => {
  const body = CreateConversationRequestSchema.parse(await c.req.json());
  const agentId = body.agent ?? (await firstAgentId());
  if (!agentId) {
    return c.json({ error: 'no agents exist; seed the DB first' }, 400);
  }
  const id = `c-${randomUUID().slice(0, 8)}`;
  await insertConversation({
    id,
    title: body.title ?? 'New conversation',
    agent_id: agentId,
  });
  const conv = await getConversation(id);
  return c.json(conv, 201);
});

conversationsRouter.get('/:id', async (c) => {
  const id = c.req.param('id');
  const conv = await getConversation(id);
  if (!conv) return c.json({ error: 'not found' }, 404);
  const tree = await getConversationTree(id);
  return c.json({ conversation: conv, tree });
});

conversationsRouter.get('/:id/tree', async (c) => {
  const tree = await getConversationTree(c.req.param('id'));
  if (!tree) return c.json({ error: 'not found' }, 404);
  return c.json(tree);
});
