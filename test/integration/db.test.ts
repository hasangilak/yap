import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createAgent,
  deleteSubtree,
  getAgent,
  getAgentFull,
  getAgentVersion,
  getArtifact,
  getClarify,
  getConversation,
  getConversationRaw,
  getConversationTree,
  hasGrant,
  insertApproval,
  insertArtifactCall as _typeCheck, // force type import (no-op)
} from '../../src/db/queries.js';
import {
  firstAgentId,
  getNode,
  insertAgent,
  insertClarify,
  insertConversation,
  insertEvent,
  insertGrant,
  insertNode,
  listAgentVersions,
  listAgents,
  listArtifactVersions,
  listArtifactsByConversation,
  listConversations,
  listDescendantIds,
  listEventsSince,
  listGrants,
  nextBranchName,
  patchAgent,
  recordArtifactWrite,
  recordClarifyResponse,
  rippleCounts,
  updateConversationPointers,
  updateNode,
  walkChain,
} from '../../src/db/queries.js';
import { disconnectDb, truncateAll } from '../helpers/db.js';

// Some imports above are re-exported from queries; the "_typeCheck"
// alias keeps the file compiling if those names ever drift. Zero
// runtime effect.
void _typeCheck;

async function seedOneAgent(id = 'a-seed'): Promise<string> {
  await insertAgent({
    id,
    name: 'Tester',
    initial: 'T',
    description: 'unit-test agent',
    model: 'qwen2.5:14b',
  });
  return id;
}

async function seedOneConv(
  id = 'c-seed',
  agentId = 'a-seed',
): Promise<string> {
  await insertConversation({
    id,
    title: 'Seed',
    agent_id: agentId,
  });
  return id;
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await disconnectDb();
});

// ----------------------------------------------------------------------------
// Conversations + nodes
// ----------------------------------------------------------------------------

describe('db — conversations + nodes', () => {
  it('insertConversation + getConversation round-trip via agent-name join', async () => {
    await seedOneAgent();
    await seedOneConv();
    const wire = await getConversation('c-seed');
    expect(wire).toMatchObject({
      id: 'c-seed',
      title: 'Seed',
      agent: 'Tester',
    });
  });

  it('listConversations sorts pinned desc then updated_at desc', async () => {
    await seedOneAgent();
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      await insertConversation({
        id: `c-${i}`,
        title: `T${i}`,
        agent_id: 'a-seed',
        pinned: i === 1,
        created_at: new Date(now - i * 1000),
        updated_at: new Date(now - i * 1000),
      });
    }
    const rows = await listConversations();
    expect(rows[0]!.id).toBe('c-1'); // pinned first
    expect(rows[1]!.id).toBe('c-0'); // newest non-pinned
    expect(rows[2]!.id).toBe('c-2'); // oldest
  });

  it('insertNode + getNode round-trip includes embedded JSON blobs', async () => {
    await seedOneAgent();
    await seedOneConv();
    await insertNode({
      id: 'n-0',
      conversation_id: 'c-seed',
      parent_id: null,
      role: 'user',
      content: 'hi',
    });
    const node = await insertNode({
      id: 'n-1',
      conversation_id: 'c-seed',
      parent_id: 'n-0',
      role: 'asst',
      content: 'hello',
      reasoning: ['step a', 'step b'],
      tool_call: {
        name: 'write_file',
        args: { path: 'a.txt' },
        status: 'ok',
        elapsed: '0.1s',
      },
    });
    expect(node.reasoning).toEqual(['step a', 'step b']);
    expect(node.toolCall?.status).toBe('ok');
    const fetched = await getNode('n-1');
    expect(fetched?.toolCall?.args).toEqual({ path: 'a.txt' });
  });

  it('walkChain traverses parent links back to root in order', async () => {
    await seedOneAgent();
    await seedOneConv();
    await insertNode({ id: 'n-root', conversation_id: 'c-seed', parent_id: null, role: 'user', content: 'r' });
    await insertNode({ id: 'n-mid', conversation_id: 'c-seed', parent_id: 'n-root', role: 'asst', content: 'm' });
    await insertNode({ id: 'n-leaf', conversation_id: 'c-seed', parent_id: 'n-mid', role: 'user', content: 'l' });
    const chain = await walkChain('c-seed', 'n-leaf');
    expect(chain.map((n) => n.id)).toEqual(['n-root', 'n-mid', 'n-leaf']);
  });

  it('updateNode changes content, status, tool_call', async () => {
    await seedOneAgent();
    await seedOneConv();
    await insertNode({
      id: 'n-u',
      conversation_id: 'c-seed',
      parent_id: null,
      role: 'asst',
      content: '',
      streaming: true,
      status: 'thinking',
    });
    const updated = await updateNode('n-u', {
      content: 'new content',
      streaming: false,
      status: null,
    });
    expect(updated?.content).toBe('new content');
    expect(updated?.streaming).toBeUndefined();
  });

  it('getConversationTree returns rootId + activeLeaf + flat Record', async () => {
    await seedOneAgent();
    await seedOneConv();
    await insertNode({ id: 'n-a', conversation_id: 'c-seed', parent_id: null, role: 'user', content: 'a' });
    await insertNode({ id: 'n-b', conversation_id: 'c-seed', parent_id: 'n-a', role: 'asst', content: 'b' });
    await updateConversationPointers('c-seed', {
      root_node_id: 'n-a',
      active_leaf_id: 'n-b',
    });
    const tree = await getConversationTree('c-seed');
    expect(tree?.rootId).toBe('n-a');
    expect(tree?.activeLeaf).toBe('n-b');
    expect(Object.keys(tree!.nodes).sort()).toEqual(['n-a', 'n-b']);
  });
});

// ----------------------------------------------------------------------------
// Branch naming + subtree
// ----------------------------------------------------------------------------

describe('db — branching', () => {
  beforeEach(async () => {
    await seedOneAgent();
    await seedOneConv();
  });

  it('nextBranchName returns alt-1 for a fresh conversation', async () => {
    expect(await nextBranchName('c-seed')).toBe('alt-1');
  });

  it('nextBranchName increments past the highest existing alt-N', async () => {
    await insertNode({
      id: 'n-x',
      conversation_id: 'c-seed',
      parent_id: null,
      role: 'user',
      content: '',
      branch: 'alt-3',
    });
    expect(await nextBranchName('c-seed')).toBe('alt-4');
  });

  it('listDescendantIds returns the subtree excluding the root', async () => {
    await insertNode({ id: 'n-r', conversation_id: 'c-seed', parent_id: null, role: 'user', content: '' });
    await insertNode({ id: 'n-r-1', conversation_id: 'c-seed', parent_id: 'n-r', role: 'asst', content: '' });
    await insertNode({ id: 'n-r-2', conversation_id: 'c-seed', parent_id: 'n-r-1', role: 'user', content: '' });
    await insertNode({ id: 'n-side', conversation_id: 'c-seed', parent_id: null, role: 'user', content: '' });
    const ids = (await listDescendantIds('c-seed', 'n-r')).sort();
    expect(ids).toEqual(['n-r-1', 'n-r-2']);
  });

  it('deleteSubtree removes root + all descendants', async () => {
    await insertNode({ id: 'n-r', conversation_id: 'c-seed', parent_id: null, role: 'user', content: '' });
    await insertNode({ id: 'n-r-1', conversation_id: 'c-seed', parent_id: 'n-r', role: 'asst', content: '' });
    const removed = await deleteSubtree('c-seed', 'n-r');
    expect(removed).toBe(2);
    expect(await getNode('n-r')).toBeNull();
    expect(await getNode('n-r-1')).toBeNull();
  });

  it('rippleCounts totals descendants, tool_calls and approvals', async () => {
    await insertNode({ id: 'n-root', conversation_id: 'c-seed', parent_id: null, role: 'user', content: '' });
    await insertNode({
      id: 'n-a',
      conversation_id: 'c-seed',
      parent_id: 'n-root',
      role: 'asst',
      content: '',
      tool_call: { name: 'read_file', args: {}, status: 'ok' },
    });
    await insertNode({
      id: 'n-b',
      conversation_id: 'c-seed',
      parent_id: 'n-a',
      role: 'asst',
      content: '',
      approval: { tool: 'write_file', title: '', body: '' },
    });
    const c = await rippleCounts('c-seed', 'n-root');
    expect(c.descendant_count).toBe(2);
    expect(c.tool_calls_to_replay).toBe(1);
    expect(c.approvals_required).toBe(1);
  });
});

// ----------------------------------------------------------------------------
// Agents + versions
// ----------------------------------------------------------------------------

describe('db — agents + versions', () => {
  it('createAgent writes v1 in one transaction', async () => {
    const full = await createAgent({
      name: 'CreatedHere',
      desc: 'tests',
      model: 'qwen2.5:14b',
    });
    expect(full.current_version_id).toBeTruthy();
    const v = await listAgentVersions(full.id);
    expect(v).toHaveLength(1);
    expect(v[0]!.version).toBe(1);
  });

  it('patchAgent appends a new version with correct monotonic number', async () => {
    const a = await createAgent({ name: 'Bump' });
    const { version: v2 } = await patchAgent(a.id, { temperature: 0.9, message: 'hotter' });
    const { version: v3 } = await patchAgent(a.id, { name: 'Bumped', message: 'rename' });
    expect(v2.version).toBe(2);
    expect(v3.version).toBe(3);
    expect(v2.message).toBe('hotter');
    const after = await getAgentFull(a.id);
    expect(after?.current_version_id).toBe(v3.id);
    expect(after?.name).toBe('Bumped');
  });

  it('getAgentVersion returns the stored snapshot', async () => {
    const a = await createAgent({ name: 'Stored', system_prompt: 'p1' });
    await patchAgent(a.id, { system_prompt: 'p2' });
    const v1 = await getAgentVersion(a.id, 1);
    expect(v1?.snapshot.system_prompt).toBe('p1');
    const v2 = await getAgentVersion(a.id, 2);
    expect(v2?.snapshot.system_prompt).toBe('p2');
  });

  it('listAgents / getAgent omit soft-deleted rows', async () => {
    await seedOneAgent('a-live');
    await seedOneAgent('a-soft');
    await (await import('../../src/db/queries.js')).softDeleteAgent('a-soft');
    const list = await listAgents();
    expect(list.map((a) => a.id)).toContain('a-live');
    expect(list.map((a) => a.id)).not.toContain('a-soft');
    expect(await getAgent('a-soft')).toBeNull();
  });

  it('firstAgentId picks the alphabetically-first id', async () => {
    await seedOneAgent('a-z');
    await seedOneAgent('a-a');
    expect(await firstAgentId()).toBe('a-a');
  });
});

// ----------------------------------------------------------------------------
// Approvals + grants
// ----------------------------------------------------------------------------

describe('db — approvals + grants', () => {
  beforeEach(async () => {
    await seedOneAgent();
    await seedOneConv();
    await insertNode({ id: 'n-x', conversation_id: 'c-seed', parent_id: null, role: 'asst', content: '' });
  });

  it('insertApproval + recordApprovalDecision update the row', async () => {
    const { recordApprovalDecision, getApproval } = await import('../../src/db/queries.js');
    await insertApproval({
      id: 'ap-1',
      conversation_id: 'c-seed',
      node_id: 'n-x',
      tool: 'write_file',
      title: 't',
      body: 'b',
    });
    await recordApprovalDecision('ap-1', 'allow', null);
    const row = await getApproval('ap-1');
    expect(row?.decision).toBe('allow');
    expect(row?.decidedAt).toBeInstanceOf(Date);
  });

  it('hasGrant / insertGrant / listGrants / deleteGrant cycle', async () => {
    const { deleteGrant } = await import('../../src/db/queries.js');
    expect(await hasGrant('a-seed', 'write_file')).toBe(false);
    await insertGrant('a-seed', 'write_file');
    expect(await hasGrant('a-seed', 'write_file')).toBe(true);
    const grants = await listGrants();
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ agentId: 'a-seed', toolId: 'write_file' });
    await deleteGrant('a-seed', 'write_file');
    expect(await hasGrant('a-seed', 'write_file')).toBe(false);
  });
});

// ----------------------------------------------------------------------------
// Clarifications
// ----------------------------------------------------------------------------

describe('db — clarifications', () => {
  beforeEach(async () => {
    await seedOneAgent();
    await seedOneConv();
    await insertNode({ id: 'n-c', conversation_id: 'c-seed', parent_id: null, role: 'asst', content: '' });
  });

  it('insertClarify + recordClarifyResponse round-trip', async () => {
    await insertClarify({
      id: 'cl-1',
      conversation_id: 'c-seed',
      node_id: 'n-c',
      question: 'Which?',
      chips: [{ id: 'c-0', label: 'A' }, { id: 'c-1', label: 'B' }],
      input_hint: 'Type more...',
    });
    await recordClarifyResponse('cl-1', {
      selected_chip_ids: ['c-0'],
      text: 'extra',
    });
    const row = await getClarify('cl-1');
    expect(row?.response).toEqual({
      selected_chip_ids: ['c-0'],
      text: 'extra',
    });
  });
});

// ----------------------------------------------------------------------------
// Artifacts
// ----------------------------------------------------------------------------

describe('db — artifacts', () => {
  beforeEach(async () => {
    await seedOneAgent();
    await seedOneConv();
    await insertNode({ id: 'n-art', conversation_id: 'c-seed', parent_id: null, role: 'asst', content: '' });
  });

  it('recordArtifactWrite creates artifact v1 on first write', async () => {
    const { artifact, version } = await recordArtifactWrite({
      conversation_id: 'c-seed',
      title: 'notes.md',
      content: '# hi',
      author: 'asst',
      produced_by_node_id: 'n-art',
    });
    expect(version.version).toBe(1);
    expect(version.diff_from).toBeNull();
    expect(artifact.mime).toBe('text/markdown');
    expect(artifact.current_version_id).toBe(version.id);
  });

  it('second write appends v2 with diff_from pointing at v1', async () => {
    const first = await recordArtifactWrite({
      conversation_id: 'c-seed',
      title: 'notes.md',
      content: 'a',
      author: 'asst',
      produced_by_node_id: 'n-art',
    });
    const second = await recordArtifactWrite({
      conversation_id: 'c-seed',
      title: 'notes.md',
      content: 'a + b',
      author: 'asst',
      produced_by_node_id: 'n-art',
    });
    expect(second.artifact.id).toBe(first.artifact.id);
    expect(second.version.version).toBe(2);
    expect(second.version.diff_from).toBe(first.version.id);
  });

  it('listArtifactsByConversation + listArtifactVersions + getArtifact', async () => {
    await recordArtifactWrite({
      conversation_id: 'c-seed',
      title: 'a.md',
      content: 'x',
      author: 'asst',
      produced_by_node_id: 'n-art',
    });
    await recordArtifactWrite({
      conversation_id: 'c-seed',
      title: 'b.md',
      content: 'y',
      author: 'asst',
      produced_by_node_id: 'n-art',
    });
    const list = await listArtifactsByConversation('c-seed');
    expect(list).toHaveLength(2);
    const art = await getArtifact(list[0]!.id);
    expect(art).not.toBeNull();
    const versions = await listArtifactVersions(list[0]!.id);
    expect(versions).toHaveLength(1);
  });
});

// ----------------------------------------------------------------------------
// Events
// ----------------------------------------------------------------------------

describe('db — events', () => {
  beforeEach(async () => {
    await seedOneAgent();
    await seedOneConv();
  });

  it('insertEvent + listEventsSince returns monotonic-ordered rows', async () => {
    for (let i = 0; i < 4; i++) {
      await insertEvent({
        kind: 'content.delta',
        id: `ev-${i}`,
        at: Date.now() + i,
        conversation_id: 'c-seed',
        node_id: 'n-x',
        delta: String(i),
      });
    }
    const all = await listEventsSince('c-seed', null);
    expect(all.map((e) => e.id)).toEqual(['ev-0', 'ev-1', 'ev-2', 'ev-3']);
    const since2 = await listEventsSince('c-seed', 'ev-1');
    expect(since2.map((e) => e.id)).toEqual(['ev-2', 'ev-3']);
  });
});
