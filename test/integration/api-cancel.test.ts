import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, expectOk, jsonReq } from '../helpers/app.js';
import { disconnectDb, truncateAll } from '../helpers/db.js';
import {
  insertAgent,
  insertConversation,
  insertNode,
  insertPrompt,
  isCancelRequested,
  listPrompts,
  getPrompt,
} from '../../src/db/queries.js';
import { getPrisma } from '../../src/db/index.js';

/**
 * `POST /api/v1/conversations/:id/cancel` — the stop button.
 *
 * Distinct from `interject`: cancel aborts the model call and **ends** the turn,
 * interject aborts and continues with new guidance. These tests pin the durable
 * consequences, since that is what stops a cancelled turn coming back to life —
 * via boot recovery, or via a prompt response that arrives after the stop.
 */

const app = buildTestApp({ skipAuth: true, skipRateLimit: true, skipIdempotency: true });

async function setup() {
  await truncateAll();
  await insertAgent({
    id: 'a-1',
    name: 'T',
    initial: 'T',
    description: '',
    model: 'qwen2.5:14b',
  });
  await insertConversation({ id: 'c-1', title: 'Conv', agent_id: 'a-1' });
}

async function seedLiveTurn(id = 'n-live') {
  await insertNode({
    id,
    conversation_id: 'c-1',
    parent_id: null,
    role: 'asst',
    content: 'partial output so far',
    streaming: true,
    status: 'streaming',
  });
  return id;
}

beforeEach(setup);
afterAll(async () => {
  await disconnectDb();
});

describe('POST /conversations/:id/cancel', () => {
  it('records the cancel durably against the live turn', async () => {
    const nodeId = await seedLiveTurn();
    const body = (await expectOk(
      await jsonReq(app, 'POST', '/api/v1/conversations/c-1/cancel'),
    )) as { ok: boolean; node_id: string; aborted: boolean };

    expect(body).toMatchObject({ ok: true, node_id: nodeId });
    expect(await isCancelRequested(nodeId)).toBe(true);
  });

  it('emits turn.cancelled so a client can render "stopped" not "complete"', async () => {
    const nodeId = await seedLiveTurn();
    await expectOk(await jsonReq(app, 'POST', '/api/v1/conversations/c-1/cancel'));
    const ev = await getPrisma().event.findFirst({
      where: { conversationId: 'c-1', kind: 'turn.cancelled' },
    });
    expect(ev).not.toBeNull();
    expect(ev!.payload).toMatchObject({ kind: 'turn.cancelled', node_id: nodeId });
  });

  /**
   * No model call is in flight in these tests, and no checkpoint exists, so the
   * turn is neither abortable nor parked. The cancel still has to be recorded —
   * the graph honours the flag whenever it next reaches a routing decision.
   */
  it('reports aborted:false when this process owns no in-flight round', async () => {
    await seedLiveTurn();
    const body = (await expectOk(
      await jsonReq(app, 'POST', '/api/v1/conversations/c-1/cancel'),
    )) as { aborted: boolean };
    expect(body.aborted).toBe(false);
  });

  it('409s when there is no turn to cancel', async () => {
    await insertNode({
      id: 'n-done',
      conversation_id: 'c-1',
      parent_id: null,
      role: 'asst',
      content: 'finished',
      streaming: false,
    });
    const res = await jsonReq(app, 'POST', '/api/v1/conversations/c-1/cancel');
    expect(res.status).toBe(409);
  });

  it('404s an unknown conversation', async () => {
    const res = await jsonReq(app, 'POST', '/api/v1/conversations/nope/cancel');
    expect(res.status).toBe(404);
  });

  it('is idempotent — cancelling twice stays cancelled', async () => {
    const nodeId = await seedLiveTurn();
    await expectOk(await jsonReq(app, 'POST', '/api/v1/conversations/c-1/cancel'));
    // Still streaming here (no graph to finalize it), so a second call is allowed
    // and must not undo anything.
    await expectOk(await jsonReq(app, 'POST', '/api/v1/conversations/c-1/cancel'));
    expect(await isCancelRequested(nodeId)).toBe(true);
  });
});

describe('cancel vs. a late prompt response', () => {
  /**
   * The race that makes the flag worth persisting: the user stops the turn while
   * an approval card is still on screen, then clicks Allow. Without the guard
   * the response would resume a turn the user had already ended.
   */
  it('cancels the prompt durably and refuses a late response', async () => {
    const nodeId = await seedLiveTurn();
    await insertPrompt({
      id: 'pr-1',
      conversation_id: 'c-1',
      node_id: nodeId,
      thread_id: nodeId,
      kind: 'approval',
      tool: 'write_file',
      payload: {
        prompt_kind: 'approval',
        approval: { tool: 'write_file', title: 't', body: 'b' },
      },
    });

    await expectOk(await jsonReq(app, 'POST', '/api/v1/conversations/c-1/cancel'));

    const prompt = await getPrompt('pr-1');
    expect(prompt?.cancelledAt).toBeInstanceOf(Date);
    expect(await listPrompts('c-1', true)).toEqual([]);

    const response = await jsonReq(app, 'POST', '/api/v1/prompts/pr-1/respond', {
      decision: 'allow',
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'prompt cancelled' });
  });
});
