import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, expectOk, jsonReq } from '../helpers/app.js';
import { disconnectDb, truncateAll } from '../helpers/db.js';
import {
  insertAgent,
  insertConversation,
  insertNode,
  updateConversationPointers,
} from '../../src/db/queries.js';

const app = buildTestApp({ skipAuth: true, skipRateLimit: true, skipIdempotency: true });

async function seed() {
  await insertAgent({
    id: 'a-1',
    name: 'Tester',
    initial: 'T',
    description: '',
    model: 'qwen2.5:14b',
  });
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await disconnectDb();
});

describe('GET /api/v1/conversations', () => {
  it('returns [] on empty DB', async () => {
    const body = (await expectOk(await jsonReq(app, 'GET', '/api/v1/conversations'))) as unknown[];
    expect(body).toEqual([]);
  });

  it('lists conversations pinned-first, updated-desc', async () => {
    await seed();
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      await insertConversation({
        id: `c-${i}`,
        title: `T${i}`,
        agent_id: 'a-1',
        pinned: i === 2,
        created_at: new Date(now - i * 1000),
        updated_at: new Date(now - i * 1000),
      });
    }
    const rows = (await expectOk(
      await jsonReq(app, 'GET', '/api/v1/conversations'),
    )) as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(['c-2', 'c-0', 'c-1']);
  });
});

describe('POST /api/v1/conversations', () => {
  it('400 when no agents seeded and no agent specified', async () => {
    const res = await jsonReq(app, 'POST', '/api/v1/conversations', { title: 'x' });
    expect(res.status).toBe(400);
  });

  it('creates a conversation tied to the first agent when agent is omitted', async () => {
    await seed();
    const body = (await expectOk(
      await jsonReq(app, 'POST', '/api/v1/conversations', { title: 'x' }),
    )) as { id: string; agent: string };
    expect(body.id).toMatch(/^c-/);
    expect(body.agent).toBe('Tester');
  });

  it('accepts agent by display name and resolves to agent_id', async () => {
    await seed();
    const body = (await expectOk(
      await jsonReq(app, 'POST', '/api/v1/conversations', { title: 'x', agent: 'Tester' }),
    )) as { id: string };
    expect(body.id).toMatch(/^c-/);
  });

  it('404-ish (400) when agent display name is unknown', async () => {
    await seed();
    const res = await jsonReq(app, 'POST', '/api/v1/conversations', {
      title: 'x',
      agent: 'Ghost',
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/v1/conversations/:id + /tree', () => {
  it('404 on unknown id', async () => {
    const res = await jsonReq(app, 'GET', '/api/v1/conversations/c-ghost');
    expect(res.status).toBe(404);
  });

  it('returns { conversation, tree } for a populated conversation', async () => {
    await seed();
    await insertConversation({ id: 'c-t', title: 'Tree', agent_id: 'a-1' });
    await insertNode({
      id: 'n-a',
      conversation_id: 'c-t',
      parent_id: null,
      role: 'user',
      content: 'a',
    });
    await insertNode({
      id: 'n-b',
      conversation_id: 'c-t',
      parent_id: 'n-a',
      role: 'asst',
      content: 'b',
    });
    await updateConversationPointers('c-t', {
      root_node_id: 'n-a',
      active_leaf_id: 'n-b',
    });
    const body = (await expectOk(
      await jsonReq(app, 'GET', '/api/v1/conversations/c-t'),
    )) as {
      conversation: { id: string };
      tree: { rootId: string; activeLeaf: string; nodes: Record<string, unknown> };
    };
    expect(body.conversation.id).toBe('c-t');
    expect(body.tree.rootId).toBe('n-a');
    expect(body.tree.activeLeaf).toBe('n-b');
    expect(Object.keys(body.tree.nodes)).toContain('n-a');
    expect(Object.keys(body.tree.nodes)).toContain('n-b');
  });

  it('/tree alias returns just the tree', async () => {
    await seed();
    await insertConversation({ id: 'c-t2', title: 'Tree2', agent_id: 'a-1' });
    await insertNode({
      id: 'n-root',
      conversation_id: 'c-t2',
      parent_id: null,
      role: 'user',
      content: '',
    });
    await updateConversationPointers('c-t2', {
      root_node_id: 'n-root',
      active_leaf_id: 'n-root',
    });
    const tree = (await expectOk(
      await jsonReq(app, 'GET', '/api/v1/conversations/c-t2/tree'),
    )) as { rootId: string };
    expect(tree.rootId).toBe('n-root');
  });
});
