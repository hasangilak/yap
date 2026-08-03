import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, expectOk, jsonReq } from '../helpers/app.js';
import { disconnectDb, truncateAll } from '../helpers/db.js';
import {
  getConversationRaw,
  insertAgent,
  insertConversation,
  insertNode,
  updateConversationPointers,
} from '../../src/db/queries.js';
import { getPrisma } from '../../src/db/index.js';

const app = buildTestApp({
  skipAuth: true,
  skipRateLimit: true,
  skipIdempotency: true,
});

beforeEach(async () => {
  await truncateAll();
  await insertAgent({
    id: 'a-1',
    name: 'Tester',
    initial: 'T',
    description: '',
    model: 'qwen2.5:14b',
  });
  await insertConversation({ id: 'c-1', title: 'Tree', agent_id: 'a-1' });
  await insertNode({
    id: 'n-root',
    conversation_id: 'c-1',
    parent_id: null,
    role: 'user',
    content: 'root',
  });
  await insertNode({
    id: 'n-asst',
    conversation_id: 'c-1',
    parent_id: 'n-root',
    role: 'asst',
    content: 'answer',
  });
  await insertNode({
    id: 'n-user-2',
    conversation_id: 'c-1',
    parent_id: 'n-asst',
    role: 'user',
    content: 'follow-up',
  });
  await insertNode({
    id: 'n-asst-2',
    conversation_id: 'c-1',
    parent_id: 'n-user-2',
    role: 'asst',
    content: 'second answer',
  });
  await updateConversationPointers('c-1', {
    root_node_id: 'n-root',
    active_leaf_id: 'n-asst-2',
  });
});

afterAll(async () => {
  await disconnectDb();
});

describe('tree branch selection', () => {
  it('moves the active leaf to an assistant without creating a placeholder', async () => {
    const before = await getPrisma().node.count({ where: { conversationId: 'c-1' } });
    const selected = (await expectOk(
      await jsonReq(app, 'POST', '/api/v1/nodes/n-asst/branch'),
    )) as { id: string; role: string };

    expect(selected).toMatchObject({ id: 'n-asst', role: 'asst' });
    expect(await getPrisma().node.count({ where: { conversationId: 'c-1' } })).toBe(before);
    expect((await getConversationRaw('c-1'))?.activeLeafId).toBe('n-asst');
  });

  it('rejects branching from a user node', async () => {
    const response = await jsonReq(app, 'POST', '/api/v1/nodes/n-root/branch');
    expect(response.status).toBe(400);
  });
});

describe('subtree pruning', () => {
  it('derives a surviving fallback when the active leaf is removed', async () => {
    const result = (await expectOk(
      await jsonReq(app, 'DELETE', '/api/v1/nodes/n-user-2?subtree=true'),
    )) as { removed: number; active_leaf_id: string | null };

    expect(result).toMatchObject({ removed: 2, active_leaf_id: 'n-asst' });
    expect((await getConversationRaw('c-1'))?.activeLeafId).toBe('n-asst');
    expect(await getPrisma().node.findUnique({ where: { id: 'n-user-2' } })).toBeNull();
    expect(await getPrisma().node.findUnique({ where: { id: 'n-asst' } })).not.toBeNull();
  });

  it('clears both pointers when the root is pruned', async () => {
    const result = (await expectOk(
      await jsonReq(app, 'DELETE', '/api/v1/nodes/n-root?subtree=true'),
    )) as { removed: number; active_leaf_id: null; root_node_id: null };

    expect(result).toMatchObject({
      removed: 4,
      active_leaf_id: null,
      root_node_id: null,
    });
    const conversation = await getConversationRaw('c-1');
    expect(conversation?.activeLeafId).toBeNull();
    expect(conversation?.rootNodeId).toBeNull();
  });

  it('rejects an explicit fallback inside the removed subtree', async () => {
    const response = await jsonReq(
      app,
      'DELETE',
      '/api/v1/nodes/n-user-2?subtree=true&fallback_leaf=n-asst-2',
    );
    expect(response.status).toBe(400);
  });
});
