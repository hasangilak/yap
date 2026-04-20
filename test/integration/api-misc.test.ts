import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, expectOk, jsonReq } from '../helpers/app.js';
import { disconnectDb, truncateAll } from '../helpers/db.js';
import {
  insertAgent,
  insertConversation,
  insertEvent,
  insertNode,
  updateConversationPointers,
} from '../../src/db/queries.js';

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
    role: 'user',
    content: 'Hello world about idempotency',
  });
  await insertNode({
    id: 'n-2',
    conversation_id: 'c-1',
    parent_id: 'n-1',
    role: 'asst',
    content: 'Idempotency keys help you retry safely.',
  });
  await updateConversationPointers('c-1', {
    root_node_id: 'n-1',
    active_leaf_id: 'n-2',
  });
}

beforeEach(setup);
afterAll(async () => {
  await disconnectDb();
});

describe('tools + tags', () => {
  it('GET /tools returns the 7 client-shaped tool defs', async () => {
    const rows = (await expectOk(
      await jsonReq(app, 'GET', '/api/v1/tools'),
    )) as Array<{ id: string }>;
    expect(rows).toHaveLength(7);
  });

  it('tag CRUD + attach + detach cycle', async () => {
    const t = (await expectOk(
      await jsonReq(app, 'POST', '/api/v1/tags', { name: 'urgent', color: '#f00' }),
    )) as { id: string };
    await expectOk(
      await jsonReq(app, 'POST', '/api/v1/conversations/c-1/tags', { tag_id: t.id }),
    );
    const dup = await jsonReq(app, 'POST', '/api/v1/tags', { name: 'urgent' });
    expect(dup.status).toBe(409);
    await expectOk(
      await jsonReq(app, 'DELETE', `/api/v1/conversations/c-1/tags/${t.id}`),
    );
    // Detach again → 404
    const gone = await jsonReq(app, 'DELETE', `/api/v1/conversations/c-1/tags/${t.id}`);
    expect(gone.status).toBe(404);
  });
});

describe('notes + pinned snippets', () => {
  it('GET/PUT /conversations/:id/notes', async () => {
    const empty = (await expectOk(
      await jsonReq(app, 'GET', '/api/v1/conversations/c-1/notes'),
    )) as { body: string };
    expect(empty.body).toBe('');
    const after = (await expectOk(
      await jsonReq(app, 'PUT', '/api/v1/conversations/c-1/notes', { body: 'note' }),
    )) as { body: string };
    expect(after.body).toBe('note');
    const read = (await expectOk(
      await jsonReq(app, 'GET', '/api/v1/conversations/c-1/notes'),
    )) as { body: string };
    expect(read.body).toBe('note');
  });

  it('pinned snippets create + list + delete', async () => {
    const pin = (await expectOk(
      await jsonReq(app, 'POST', '/api/v1/conversations/c-1/pinned-snippets', {
        source_node_id: 'n-2',
        label: 'idem',
        excerpt: 'Idempotency keys',
      }),
    )) as { id: string };
    const list = (await expectOk(
      await jsonReq(app, 'GET', '/api/v1/conversations/c-1/pinned-snippets'),
    )) as unknown[];
    expect(list).toHaveLength(1);
    await expectOk(await jsonReq(app, 'DELETE', `/api/v1/pinned-snippets/${pin.id}`));
    const gone = await jsonReq(app, 'DELETE', `/api/v1/pinned-snippets/${pin.id}`);
    expect(gone.status).toBe(404);
  });
});

describe('timeline', () => {
  it('synthesizes TimelineEvent rows from raw events', async () => {
    await insertEvent({
      kind: 'node.created',
      id: 'ev-1',
      at: 100,
      conversation_id: 'c-1',
      node: {
        id: 'n-user',
        parent: null,
        role: 'user',
        time: '08:00',
        branch: 'main',
        content: 'What is idempotency?',
      },
    });
    await insertEvent({
      kind: 'toolcall.ended',
      id: 'ev-2',
      at: 200,
      conversation_id: 'c-1',
      node_id: 'n-asst',
      status: 'ok',
      elapsed_ms: 120,
      result: 'done',
    });
    const rows = (await expectOk(
      await jsonReq(app, 'GET', '/api/v1/conversations/c-1/timeline'),
    )) as Array<{ kind: string; label: string }>;
    expect(rows.some((r) => r.kind === 'user')).toBe(true);
    expect(rows.some((r) => r.kind === 'tool')).toBe(true);
  });
});

describe('search', () => {
  it('returns [] when query too short', async () => {
    const r = (await expectOk(
      await jsonReq(app, 'GET', '/api/v1/search?q=a'),
    )) as { hits: unknown[] };
    expect(r.hits).toEqual([]);
  });

  it('matches messages and highlights the needle', async () => {
    const r = (await expectOk(
      await jsonReq(app, 'GET', '/api/v1/search?q=idempotency&scope=messages'),
    )) as { hits: Array<{ snippet: string; highlight: string }> };
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits[0]!.highlight).toMatch(/\*\*idempotency\*\*|\*\*Idempotency\*\*/i);
  });

  it('scope=agents finds agent name/description matches', async () => {
    await jsonReq(app, 'POST', '/api/v1/agents', {
      name: 'Searchable',
      desc: 'the haystack agent',
      system_prompt: 'findme',
    });
    const r = (await expectOk(
      await jsonReq(app, 'GET', '/api/v1/search?q=findme&scope=agents'),
    )) as { hits: unknown[] };
    expect(r.hits.length).toBeGreaterThan(0);
  });
});

describe('export + share', () => {
  it('export md returns attachment with h2 per turn', async () => {
    const res = await app.fetch(
      new Request('http://x/api/v1/conversations/c-1/export?format=md'),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/text\/markdown/);
    expect(res.headers.get('Content-Disposition')).toMatch(/attachment/);
    const body = await res.text();
    expect(body).toMatch(/^# /m);
    expect(body).toMatch(/## /m);
  });

  it('export json returns {conversation, tree, artifacts}', async () => {
    const res = await app.fetch(
      new Request('http://x/api/v1/conversations/c-1/export?format=json'),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversation: unknown; tree: unknown };
    expect(body.conversation).toBeDefined();
    expect(body.tree).toBeDefined();
  });

  it('share mint → public read → revoke', async () => {
    const minted = (await expectOk(
      await jsonReq(app, 'POST', '/api/v1/conversations/c-1/share', {}),
    )) as { share_token: string };
    const pub = (await expectOk(
      await jsonReq(app, 'GET', `/api/v1/shared/${minted.share_token}`),
    )) as { title: string; chain: unknown[] };
    expect(pub.title).toBe('Conv');
    expect(Array.isArray(pub.chain)).toBe(true);
    await expectOk(await jsonReq(app, 'DELETE', '/api/v1/conversations/c-1/share'));
    const after = await jsonReq(app, 'GET', `/api/v1/shared/${minted.share_token}`);
    expect(after.status).toBe(404);
  });
});

describe('dev/seed', () => {
  it('POST /dev/seed loads fixtures', async () => {
    // truncate first so the beforeEach c-1 data is gone, then seed.
    await truncateAll();
    const r = (await expectOk(
      await jsonReq(app, 'POST', '/api/v1/dev/seed', {}),
    )) as { ok: boolean; conversations: number; agents: number; nodes: number };
    expect(r.ok).toBe(true);
    expect(r.conversations).toBe(9);
    expect(r.agents).toBe(7);
    expect(r.nodes).toBe(9);
  });
});
