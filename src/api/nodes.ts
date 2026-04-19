import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { getPrisma } from '../db/index.js';
import {
  insertNode,
  nextBranchName,
  updateConversationPointers,
} from '../db/queries.js';
import { publish } from '../events/bus.js';
import { newEventId } from '../events/types.js';
import { runAssistantTurn } from '../runtime/run.js';

export const nodesRouter = new Hono();

const EditBodySchema = z.object({
  content: z.string().min(1),
  ripple: z.boolean().optional(),
});

function envelope(conversation_id: string) {
  return { id: newEventId(), at: Date.now(), conversation_id };
}

function newNodeId(): string {
  return `n-${randomUUID().slice(0, 8)}`;
}

/**
 * POST /api/v1/nodes/:id/edit
 *
 * Spec §3.2. Editing a user message NEVER mutates it — instead the
 * edit creates a sibling with a fresh `alt-N` branch, `edited: true`
 * and `edited_from_id` pointing back at the original. If `ripple` is
 * true the server also fires one assistant reply under the new user
 * node; deeper chain replay (regenerating every descendant along the
 * new branch) is a Phase 3.5 follow-up.
 */
nodesRouter.post('/:id/edit', async (c) => {
  const id = c.req.param('id');
  const body = EditBodySchema.parse(await c.req.json());

  const orig = await getPrisma().node.findUnique({ where: { id } });
  if (!orig) return c.json({ error: 'not found' }, 404);
  if (orig.role !== 'user') {
    return c.json({ error: 'only user nodes can be edited' }, 400);
  }

  const conversationId = orig.conversationId;
  const branch = await nextBranchName(conversationId);
  const newId = newNodeId();

  const newNode = await insertNode({
    id: newId,
    conversation_id: conversationId,
    parent_id: orig.parentId,
    role: 'user',
    branch,
    content: body.content,
    edited: true,
    edited_from_id: id,
  });

  await publish({
    kind: 'node.created',
    ...envelope(conversationId),
    node: newNode,
  });
  await updateConversationPointers(conversationId, {
    active_leaf_id: newId,
    snippet: body.content.slice(0, 80),
    updated_at: new Date(),
  });
  await publish({
    kind: 'active_leaf.changed',
    ...envelope(conversationId),
    active_leaf_id: newId,
  });

  if (body.ripple) {
    // Background: stream the assistant reply under the new user node.
    (async () => {
      try {
        for await (const ev of runAssistantTurn({
          conversationId,
          parentUserNodeId: newId,
          branch,
        })) {
          await publish(ev);
        }
      } catch (err) {
        console.error('[edit ripple]', err);
      }
    })();
  }

  return c.json(newNode, 201);
});

/**
 * POST /api/v1/nodes/:id/regenerate
 *
 * Spec §3.4. Given an assistant node, create a fresh asst reply under
 * the same parent user node on a new `alt-N` branch. Returns the
 * placeholder asst node synchronously (with streaming=true) so the
 * caller can show it in the tree immediately; further events flow
 * through the SSE stream.
 */
nodesRouter.post('/:id/regenerate', async (c) => {
  const id = c.req.param('id');
  const orig = await getPrisma().node.findUnique({ where: { id } });
  if (!orig) return c.json({ error: 'not found' }, 404);
  if (orig.role !== 'asst') {
    return c.json({ error: 'only assistant nodes can be regenerated' }, 400);
  }
  if (!orig.parentId) {
    return c.json({ error: 'cannot regenerate the root node' }, 400);
  }

  const conversationId = orig.conversationId;
  const branch = await nextBranchName(conversationId);

  const generator = runAssistantTurn({
    conversationId,
    parentUserNodeId: orig.parentId,
    branch,
  });

  // Pump until the placeholder asst node is visible, then return it
  // and background the rest of the generation.
  let asstNode: unknown = null;
  while (true) {
    const next = await generator.next();
    if (next.done) break;
    const ev = next.value;
    await publish(ev);
    if (ev.kind === 'node.created' && ev.node.role === 'asst') {
      asstNode = ev.node;
      break;
    }
  }

  (async () => {
    try {
      for await (const ev of generator) await publish(ev);
    } catch (err) {
      console.error('[regenerate]', err);
    }
  })();

  return c.json(asstNode, 201);
});
