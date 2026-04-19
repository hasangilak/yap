import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { getPrisma } from '../db/index.js';
import {
  firstAgentId,
  getConversation,
  getConversationTree,
  insertConversation,
  listArtifactsByConversation,
  listConversations,
} from '../db/queries.js';
import { CreateConversationRequestSchema } from '../schemas/index.js';

export const conversationsRouter = new Hono();

async function resolveAgentId(input: string | undefined): Promise<string | null> {
  if (!input) return firstAgentId();
  // chat-box's Conversation.agent is a display name. Accept either a
  // real id (a-xx) or a display name — look by id first, then by name.
  const byId = await getPrisma().agent.findUnique({ where: { id: input }, select: { id: true } });
  if (byId) return byId.id;
  const byName = await getPrisma().agent.findFirst({ where: { name: input }, select: { id: true } });
  return byName?.id ?? null;
}

conversationsRouter.get('/', async (c) => {
  const rows = await listConversations();
  return c.json(rows);
});

conversationsRouter.post('/', async (c) => {
  const body = CreateConversationRequestSchema.parse(await c.req.json());
  const agentId = await resolveAgentId(body.agent);
  if (!agentId) {
    return c.json({ error: 'no matching agent; seed the DB first' }, 400);
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

conversationsRouter.get('/:id/artifacts', async (c) => {
  const rows = await listArtifactsByConversation(c.req.param('id'));
  return c.json(rows);
});
