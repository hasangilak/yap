import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, expectOk, jsonReq } from '../helpers/app.js';
import { disconnectDb, truncateAll } from '../helpers/db.js';
import {
  getPrompt,
  insertAgent,
  insertConversation,
  insertNode,
  insertPrompt,
  listGrants,
} from '../../src/db/queries.js';

/**
 * `POST /api/v1/prompts/:id/respond` — the single answer endpoint that replaced
 * `POST /approvals/:id/decide` and `POST /clarify/:id/answer`.
 *
 * These tests deliberately use prompts with **no graph checkpoint** behind
 * them, which exercises the `resumed: false` branch. That is not a degenerate
 * case: it is what a client sees when it answers a prompt whose turn is no
 * longer resumable, and the answer must still be recorded rather than lost.
 * The resume-and-continue path is covered against a real checkpointer in
 * `runtime.test.ts`.
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
  await insertNode({
    id: 'n-1',
    conversation_id: 'c-1',
    parent_id: null,
    role: 'asst',
    content: '',
  });
}

async function seedApproval(id = 'pr-1') {
  await insertPrompt({
    id,
    conversation_id: 'c-1',
    node_id: 'n-1',
    thread_id: 'n-1',
    kind: 'approval',
    tool: 'write_file',
    payload: {
      prompt_kind: 'approval',
      approval: { tool: 'write_file', title: 'Run write_file', body: 'b' },
    },
  });
}

async function seedClarify(id = 'pr-c') {
  await insertPrompt({
    id,
    conversation_id: 'c-1',
    node_id: 'n-1',
    thread_id: 'n-1',
    kind: 'clarify',
    tool: 'ask_clarification',
    payload: {
      prompt_kind: 'clarify',
      clarify: {
        question: 'Which format?',
        chips: [{ id: 'c-0', label: 'JSON' }],
        input: '',
      },
    },
  });
}

beforeEach(setup);
afterAll(async () => {
  await disconnectDb();
});

describe('POST /prompts/:id/respond', () => {
  it('records an approval decision and reports nothing to resume', async () => {
    await seedApproval();
    const body = (await expectOk(
      await jsonReq(app, 'POST', '/api/v1/prompts/pr-1/respond', {
        decision: 'allow',
      }),
    )) as { ok: boolean; kind: string; resumed: boolean };

    expect(body).toMatchObject({ ok: true, kind: 'approval', resumed: false });
    const row = await getPrompt('pr-1');
    expect(row?.response).toEqual({ prompt_kind: 'approval', decision: 'allow' });
    expect(row?.respondedAt).toBeInstanceOf(Date);
  });

  it('stores edited_args on approve', async () => {
    await seedApproval();
    await expectOk(
      await jsonReq(app, 'POST', '/api/v1/prompts/pr-1/respond', {
        decision: 'allow',
        edited_args: { path: 'edited.txt', content: 'hi' },
      }),
    );
    expect((await getPrompt('pr-1'))?.response).toMatchObject({
      edited_args: { path: 'edited.txt', content: 'hi' },
    });
  });

  /** A denial has nothing to edit, so args must not ride along. */
  it('drops edited_args when the decision is deny', async () => {
    await seedApproval();
    await expectOk(
      await jsonReq(app, 'POST', '/api/v1/prompts/pr-1/respond', {
        decision: 'deny',
        edited_args: { path: 'ignored.txt' },
      }),
    );
    expect((await getPrompt('pr-1'))?.response).toEqual({
      prompt_kind: 'approval',
      decision: 'deny',
    });
  });

  it("'always' writes a standing grant for the agent", async () => {
    await seedApproval();
    await expectOk(
      await jsonReq(app, 'POST', '/api/v1/prompts/pr-1/respond', {
        decision: 'always',
      }),
    );
    const grants = await listGrants();
    expect(grants).toMatchObject([{ agentId: 'a-1', toolId: 'write_file' }]);
  });

  it('accepts a clarify answer and wraps it in the tagged response', async () => {
    await seedClarify();
    const body = (await expectOk(
      await jsonReq(app, 'POST', '/api/v1/prompts/pr-c/respond', {
        selected_chip_ids: ['c-0'],
        text: 'as JSON please',
      }),
    )) as { kind: string };
    expect(body.kind).toBe('clarify');
    expect((await getPrompt('pr-c'))?.response).toEqual({
      prompt_kind: 'clarify',
      answer: { selected_chip_ids: ['c-0'], text: 'as JSON please' },
    });
  });

  it('defaults an empty clarify answer rather than rejecting it', async () => {
    await seedClarify();
    await expectOk(await jsonReq(app, 'POST', '/api/v1/prompts/pr-c/respond', {}));
    expect((await getPrompt('pr-c'))?.response).toEqual({
      prompt_kind: 'clarify',
      answer: { selected_chip_ids: [], text: '' },
    });
  });

  /**
   * The body is validated against the *stored* kind, so a client cannot answer
   * an approval with a clarify payload and have it silently become the resume
   * value handed to the graph.
   */
  it('rejects a body that does not match the prompt kind', async () => {
    await seedApproval();
    const res = await jsonReq(app, 'POST', '/api/v1/prompts/pr-1/respond', {
      selected_chip_ids: ['c-0'],
      text: 'wrong shape',
    });
    expect(res.status).toBe(400);
    expect((await getPrompt('pr-1'))?.response).toBeNull();
  });

  it('409s a second response and leaves the first intact', async () => {
    await seedApproval();
    await expectOk(
      await jsonReq(app, 'POST', '/api/v1/prompts/pr-1/respond', {
        decision: 'allow',
      }),
    );
    const res = await jsonReq(app, 'POST', '/api/v1/prompts/pr-1/respond', {
      decision: 'deny',
    });
    expect(res.status).toBe(409);
    expect((await getPrompt('pr-1'))?.response).toMatchObject({ decision: 'allow' });
  });

  /**
   * Two simultaneous responses. The compare-and-set in `recordPromptResponse`
   * means exactly one wins — a read-then-write check would let both through and
   * resume the turn twice.
   */
  it('serializes concurrent responses to one winner', async () => {
    await seedApproval();
    const [a, b] = await Promise.all([
      jsonReq(app, 'POST', '/api/v1/prompts/pr-1/respond', { decision: 'allow' }),
      jsonReq(app, 'POST', '/api/v1/prompts/pr-1/respond', { decision: 'deny' }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
  });

  it('404s an unknown prompt', async () => {
    const res = await jsonReq(app, 'POST', '/api/v1/prompts/nope/respond', {
      decision: 'allow',
    });
    expect(res.status).toBe(404);
  });
});

describe('GET prompt lookups', () => {
  it('GET /prompts/:id returns the request payload and response state', async () => {
    await seedApproval();
    const body = (await expectOk(
      await jsonReq(app, 'GET', '/api/v1/prompts/pr-1'),
    )) as Record<string, unknown>;
    expect(body).toMatchObject({
      id: 'pr-1',
      kind: 'approval',
      tool: 'write_file',
      node_id: 'n-1',
      response: null,
      responded_at: null,
    });
    expect(body.request).toMatchObject({ prompt_kind: 'approval' });
  });

  /**
   * The reconnect path: a client that reloaded mid-pause can rebuild every open
   * prompt from one request. Before the unified model this was only derivable
   * by replaying the event log, because a node row carries the request but
   * never the response.
   */
  it('GET /conversations/:id/prompts?pending=true lists only open prompts', async () => {
    await seedApproval('pr-1');
    await seedClarify('pr-2');
    await expectOk(
      await jsonReq(app, 'POST', '/api/v1/prompts/pr-1/respond', {
        decision: 'allow',
      }),
    );

    const all = (await expectOk(
      await jsonReq(app, 'GET', '/api/v1/conversations/c-1/prompts'),
    )) as unknown[];
    expect(all).toHaveLength(2);

    const pending = (await expectOk(
      await jsonReq(app, 'GET', '/api/v1/conversations/c-1/prompts?pending=true'),
    )) as Array<{ id: string }>;
    expect(pending.map((p) => p.id)).toEqual(['pr-2']);
  });

  it('404s an unknown prompt', async () => {
    const res = await jsonReq(app, 'GET', '/api/v1/prompts/nope');
    expect(res.status).toBe(404);
  });
});
