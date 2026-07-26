import { Hono } from 'hono';
import {
  getConversationRaw,
  getPrompt,
  insertGrant,
  listPrompts,
  recordPromptResponse,
  type PromptRow,
} from '../db/queries.js';
import { publish } from '../events/bus.js';
import { newEventId } from '../events/types.js';
import { getPendingInterrupts } from '../runtime/graph/index.js';
import { resumeTurn } from '../runtime/run.js';
import {
  ApprovalRespondBodySchema,
  ClarifyRespondBodySchema,
  type PromptResponse,
} from '../schemas/index.js';
import { detachAndPublish } from './drain.js';

export const promptsRouter = new Hono();

function serialize(row: PromptRow) {
  return {
    id: row.id,
    conversation_id: row.conversationId,
    node_id: row.nodeId,
    kind: row.kind,
    tool: row.tool,
    request: row.payload,
    response: row.response,
    responded_at: row.respondedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  };
}

/**
 * POST /api/v1/prompts/:id/respond
 *
 * The single answer endpoint for every kind of pause, replacing
 * `POST /approvals/:id/decide` and `POST /clarify/:id/answer`.
 *
 * The body is validated against the schema for the *stored* kind, so the client
 * never restates it and a clarify answer sent to an approval prompt is a 400
 * rather than a wrong-shaped resume value handed to the graph.
 *
 * Ordering is load-bearing: the response is persisted **before** the graph is
 * resumed, so an answer is never lost to a failure in between. The write is
 * also a compare-and-set (`response IS NULL`), which is what makes two
 * simultaneous responses resolve to one resume and one 409 instead of both
 * passing a read-then-write check and resuming the turn twice.
 *
 * `prompt.responded` is emitted by the graph's `resolvePrompt` node so it stays
 * ordered with the rest of the turn. It is published here only when there is
 * nothing to resume.
 */
promptsRouter.post('/:id/respond', async (c) => {
  const id = c.req.param('id');
  const row = await getPrompt(id);
  if (!row) return c.json({ error: 'not found' }, 404);

  // `safeParse`, not `parse`: a body that doesn't match the stored kind is a
  // client error and must be a 400. Elsewhere in the API a bare `.parse()`
  // throws and Hono turns it into a 500 — do not copy that pattern here.
  const raw: unknown = await c.req.json().catch(() => null);

  let response: PromptResponse;
  if (row.kind === 'approval') {
    const parsed = ApprovalRespondBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid body for an approval prompt',
          expected: { decision: 'allow | always | deny', edited_args: 'object?' },
          issues: parsed.error.issues,
        },
        400,
      );
    }
    response = {
      prompt_kind: 'approval',
      decision: parsed.data.decision,
      // A denial has nothing to edit; drop the args rather than storing a
      // record that implies the call ran with them.
      ...(parsed.data.decision !== 'deny' && parsed.data.edited_args
        ? { edited_args: parsed.data.edited_args }
        : {}),
    };
  } else {
    const parsed = ClarifyRespondBodySchema.safeParse(raw ?? {});
    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid body for a clarify prompt',
          expected: { selected_chip_ids: 'string[]?', text: 'string?' },
          issues: parsed.error.issues,
        },
        400,
      );
    }
    response = { prompt_kind: 'clarify', answer: parsed.data };
  }

  // Compare-and-set: only the first responder claims the prompt.
  const claimed = await recordPromptResponse(id, response);
  if (!claimed) {
    const current = await getPrompt(id);
    return c.json(
      { error: 'already responded', response: current?.response ?? null },
      409,
    );
  }

  if (response.prompt_kind === 'approval' && response.decision === 'always') {
    const conv = await getConversationRaw(row.conversationId);
    if (conv) await insertGrant(conv.agentId, row.tool);
  }

  // The thread id is stored on the row, so the paused turn is one lookup away.
  const pending = await getPendingInterrupts(row.threadId);
  if (pending.length === 0) {
    await publish({
      kind: 'prompt.responded',
      id: newEventId(),
      at: Date.now(),
      conversation_id: row.conversationId,
      node_id: row.nodeId,
      prompt_id: id,
      tool: row.tool,
      response,
    });
    return c.json({ ok: true, prompt_id: id, kind: row.kind, resumed: false });
  }

  detachAndPublish(
    resumeTurn({
      conversationId: row.conversationId,
      asstNodeId: row.threadId,
      resume: response,
    }),
    'prompt-resume',
  );

  return c.json({ ok: true, prompt_id: id, kind: row.kind, resumed: true });
});

/**
 * GET /api/v1/prompts/:id
 *
 * Lets a client that reloaded mid-pause find out whether a prompt is still
 * open before rendering live buttons for it. Without this the only way to know
 * was to replay the event log, because a node row carries the *request* but
 * never the response.
 */
promptsRouter.get('/:id', async (c) => {
  const row = await getPrompt(c.req.param('id'));
  if (!row) return c.json({ error: 'not found' }, 404);
  return c.json(serialize(row));
});

export const conversationPromptsRouter = new Hono();

/**
 * GET /api/v1/conversations/:id/prompts?pending=true
 *
 * What this conversation is waiting on, newest first. This is the reconnect
 * path: a client can rebuild every open prompt from one request instead of
 * replaying the event stream, and it stays correct when several prompts are
 * open at once.
 */
conversationPromptsRouter.get('/conversations/:id/prompts', async (c) => {
  const pendingOnly = c.req.query('pending') === 'true';
  const rows = await listPrompts(c.req.param('id'), pendingOnly);
  return c.json(rows.map(serialize));
});
