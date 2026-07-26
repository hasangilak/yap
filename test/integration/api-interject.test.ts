import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, expectOk, jsonReq } from '../helpers/app.js';
import { disconnectDb, truncateAll } from '../helpers/db.js';
import {
  consumeInterjections,
  insertAgent,
  insertConversation,
  insertNode,
  peekInterjections,
  updateNode,
} from '../../src/db/queries.js';
import { getPrisma } from '../../src/db/index.js';

/**
 * `POST /api/v1/conversations/:id/interject` — mid-turn steering.
 *
 * The endpoint has two halves with very different durability guarantees, and
 * these tests pin the durable one. The text must reach Postgres before the
 * response is sent, because the 200 tells the user we accepted it; aborting the
 * in-flight model call is best-effort on top of that. There is no model call in
 * these tests, so `aborted` is always false — which is the point: the
 * interjection must still be recorded and queued.
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

/** An assistant node mid-turn: `streaming: true` is what marks it live. */
async function seedLiveTurn(id = 'n-live') {
  await insertNode({
    id,
    conversation_id: 'c-1',
    parent_id: null,
    role: 'asst',
    content: '',
    streaming: true,
    status: 'streaming',
  });
  return id;
}

beforeEach(setup);
afterAll(async () => {
  await disconnectDb();
});

describe('POST /conversations/:id/interject', () => {
  it('persists the text against the live turn and reports nothing was aborted', async () => {
    const nodeId = await seedLiveTurn();
    const body = (await expectOk(
      await jsonReq(app, 'POST', '/api/v1/conversations/c-1/interject', {
        text: 'actually, use TypeScript',
      }),
    )) as { ok: boolean; node_id: string; aborted: boolean; interjection_id: string };

    expect(body).toMatchObject({ ok: true, node_id: nodeId, aborted: false });
    const pending = await peekInterjections(nodeId);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.text).toBe('actually, use TypeScript');
  });

  it('emits interjection.received so the client gets a transcript record', async () => {
    const nodeId = await seedLiveTurn();
    await expectOk(
      await jsonReq(app, 'POST', '/api/v1/conversations/c-1/interject', {
        text: 'stop and summarise',
      }),
    );
    const ev = await getPrisma().event.findFirst({
      where: { conversationId: 'c-1', kind: 'interjection.received' },
    });
    expect(ev).not.toBeNull();
    expect(ev!.payload).toMatchObject({
      kind: 'interjection.received',
      node_id: nodeId,
      text: 'stop and summarise',
      aborted: false,
    });
  });

  /**
   * Queueing text against a turn that has finished would strand it forever —
   * nothing will ever read it — so this is a 409 rather than a silent success.
   */
  it('409s when no turn is in flight', async () => {
    await insertNode({
      id: 'n-done',
      conversation_id: 'c-1',
      parent_id: null,
      role: 'asst',
      content: 'all done',
      streaming: false,
    });
    const res = await jsonReq(app, 'POST', '/api/v1/conversations/c-1/interject', {
      text: 'too late',
    });
    expect(res.status).toBe(409);
    expect(await peekInterjections('n-done')).toHaveLength(0);
  });

  it('409s once the turn finalizes, having accepted it while live', async () => {
    const nodeId = await seedLiveTurn();
    await expectOk(
      await jsonReq(app, 'POST', '/api/v1/conversations/c-1/interject', {
        text: 'while live',
      }),
    );
    await updateNode(nodeId, { streaming: false, status: null });
    const res = await jsonReq(app, 'POST', '/api/v1/conversations/c-1/interject', {
      text: 'after finalize',
    });
    expect(res.status).toBe(409);
    // The one accepted while live is still queued and untouched.
    expect(await peekInterjections(nodeId)).toHaveLength(1);
  });

  it('400s an empty or whitespace-only interjection', async () => {
    await seedLiveTurn();
    for (const text of ['', '   ']) {
      const res = await jsonReq(app, 'POST', '/api/v1/conversations/c-1/interject', {
        text,
      });
      expect(res.status, `text=${JSON.stringify(text)}`).toBe(400);
    }
    const res = await jsonReq(app, 'POST', '/api/v1/conversations/c-1/interject', {});
    expect(res.status).toBe(400);
  });

  it('404s an unknown conversation', async () => {
    const res = await jsonReq(app, 'POST', '/api/v1/conversations/nope/interject', {
      text: 'hello',
    });
    expect(res.status).toBe(404);
  });

  it('queues several interjections in order', async () => {
    const nodeId = await seedLiveTurn();
    for (const text of ['first', 'second', 'third']) {
      await expectOk(
        await jsonReq(app, 'POST', '/api/v1/conversations/c-1/interject', { text }),
      );
    }
    expect((await peekInterjections(nodeId)).map((r) => r.text)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });
});

describe('interjection consumption', () => {
  /**
   * peek/consume is split so delivery is at-least-once. `callModel` peeks
   * before the round and consumes only after it finishes streaming, so a crash
   * mid-round leaves the text pending rather than swallowing it.
   */
  it('peek does not consume — only consumeInterjections does', async () => {
    const nodeId = await seedLiveTurn();
    await expectOk(
      await jsonReq(app, 'POST', '/api/v1/conversations/c-1/interject', {
        text: 'steer me',
      }),
    );

    // Two peeks in a row both see it: a crash between peek and consume replays.
    expect(await peekInterjections(nodeId)).toHaveLength(1);
    const rows = await peekInterjections(nodeId);
    expect(rows).toHaveLength(1);

    await consumeInterjections(rows.map((r) => r.id));
    expect(await peekInterjections(nodeId)).toHaveLength(0);
  });

  /** Consuming by explicit id leaves anything that arrived mid-round pending. */
  it('consuming a round\'s ids does not swallow one that arrived meanwhile', async () => {
    const nodeId = await seedLiveTurn();
    await expectOk(
      await jsonReq(app, 'POST', '/api/v1/conversations/c-1/interject', {
        text: 'before the round',
      }),
    );
    const roundRows = await peekInterjections(nodeId);

    // Arrives while the round is still streaming.
    await expectOk(
      await jsonReq(app, 'POST', '/api/v1/conversations/c-1/interject', {
        text: 'during the round',
      }),
    );

    await consumeInterjections(roundRows.map((r) => r.id));
    expect((await peekInterjections(nodeId)).map((r) => r.text)).toEqual([
      'during the round',
    ]);
  });

  it('consumeInterjections tolerates an empty list', async () => {
    await expect(consumeInterjections([])).resolves.toBeUndefined();
  });
});
