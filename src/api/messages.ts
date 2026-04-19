import { Hono } from 'hono';
import { getConversationRaw } from '../db/queries.js';
import { publish } from '../events/bus.js';
import { runAgent } from '../runtime/run.js';
import { PostMessageRequestSchema } from '../schemas/index.js';

export const messagesRouter = new Hono();

/**
 * POST /api/v1/conversations/:id/messages
 *
 * Appends a user message and kicks off the assistant turn. Returns the
 * newly-created user node synchronously as soon as the runtime has
 * written it; the rest of the generation continues in the background,
 * with every BusEvent persisted and published to the in-process bus so
 * any open SSE subscriber for this conversation receives the stream.
 */
messagesRouter.post('/conversations/:id/messages', async (c) => {
  const id = c.req.param('id');
  const conv = await getConversationRaw(id);
  if (!conv) return c.json({ error: 'not found' }, 404);

  const body = PostMessageRequestSchema.parse(await c.req.json());
  // If the caller omits parent, append to the current active leaf; if
  // the conversation is empty, parent remains null and becomes the
  // root.
  const parent = body.parent !== undefined ? body.parent : conv.activeLeafId ?? null;

  const generator = runAgent({
    conversationId: id,
    parent,
    content: body.content,
  });

  // Pull events synchronously until we've seen the user's node.created
  // so we can return it to the caller. Everything after continues in
  // the background, emitting to the bus.
  let userNode: unknown = null;
  while (true) {
    const next = await generator.next();
    if (next.done) break;
    const ev = next.value;
    await publish(ev);
    if (ev.kind === 'node.created' && ev.node.role === 'user') {
      userNode = ev.node;
      break;
    }
  }

  // Detach: drain the rest in the background. Errors are surfaced via
  // the event stream (runtime yields `error` events) so logging here
  // is a last-resort net.
  (async () => {
    try {
      for await (const ev of generator) {
        await publish(ev);
      }
    } catch (err) {
      console.error('[runtime] unhandled:', err);
    }
  })();

  return c.json(userNode, 201);
});
