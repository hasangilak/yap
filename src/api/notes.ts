import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { getPrisma } from '../db/index.js';
import {
  CreatePinnedSnippetRequestSchema,
  PutNoteRequestSchema,
} from '../schemas/index.js';

export const notesRouter = new Hono();

function newPinId(): string {
  return `ps-${randomUUID().slice(0, 8)}`;
}

// -- thread note (1:1 per conversation) ----------------------------------

notesRouter.get('/conversations/:id/notes', async (c) => {
  const convId = c.req.param('id');
  const row = await getPrisma().threadNote.findUnique({ where: { conversationId: convId } });
  return c.json({
    conversation_id: convId,
    body: row?.body ?? '',
    updated_at: (row?.updatedAt ?? new Date(0)).toISOString(),
  });
});

notesRouter.put('/conversations/:id/notes', async (c) => {
  const convId = c.req.param('id');
  const body = PutNoteRequestSchema.parse(await c.req.json());
  const row = await getPrisma().threadNote.upsert({
    where: { conversationId: convId },
    update: { body: body.body },
    create: { conversationId: convId, body: body.body },
  });
  return c.json({
    conversation_id: convId,
    body: row.body,
    updated_at: row.updatedAt.toISOString(),
  });
});

// -- pinned snippets -----------------------------------------------------

notesRouter.get('/conversations/:id/pinned-snippets', async (c) => {
  const convId = c.req.param('id');
  const rows = await getPrisma().pinnedSnippet.findMany({
    where: { conversationId: convId },
    orderBy: { createdAt: 'desc' },
  });
  return c.json(
    rows.map((r) => ({
      id: r.id,
      conversation_id: r.conversationId,
      source_node_id: r.sourceNodeId,
      label: r.label,
      excerpt: r.excerpt,
      created_at: r.createdAt.toISOString(),
    })),
  );
});

notesRouter.post('/conversations/:id/pinned-snippets', async (c) => {
  const convId = c.req.param('id');
  const body = CreatePinnedSnippetRequestSchema.parse(await c.req.json());
  const row = await getPrisma().pinnedSnippet.create({
    data: {
      id: newPinId(),
      conversationId: convId,
      sourceNodeId: body.source_node_id,
      label: body.label,
      excerpt: body.excerpt,
    },
  });
  return c.json(
    {
      id: row.id,
      conversation_id: row.conversationId,
      source_node_id: row.sourceNodeId,
      label: row.label,
      excerpt: row.excerpt,
      created_at: row.createdAt.toISOString(),
    },
    201,
  );
});

notesRouter.delete('/pinned-snippets/:id', async (c) => {
  try {
    await getPrisma().pinnedSnippet.delete({ where: { id: c.req.param('id') } });
    return c.json({ ok: true });
  } catch {
    return c.json({ error: 'not found' }, 404);
  }
});
