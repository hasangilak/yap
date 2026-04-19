import { Hono } from 'hono';
import {
  insertAgent,
  insertConversation,
  insertNode,
  updateConversationPointers,
} from '../db/queries.js';
import {
  SAMPLE_AGENTS,
  SAMPLE_CONVERSATIONS,
  SAMPLE_TREE_ACTIVE_LEAF,
  SAMPLE_TREE_CONVERSATION,
  SAMPLE_TREE_NODES,
  SAMPLE_TREE_ROOT,
} from '../seed/samples.js';

export const devRouter = new Hono();

/**
 * POST /api/v1/dev/seed
 *
 * Idempotent loader for the chat-box SAMPLE_* fixtures. Useful to bring
 * a fresh DB up to a recognizable starting state; safe to re-run
 * (every insert is an upsert-no-update). Returns a small summary so a
 * curl test can sanity-check the numbers.
 */
devRouter.post('/seed', async (c) => {
  // 1. Agents (needed before conversations can resolve their FK).
  for (const a of SAMPLE_AGENTS) {
    await insertAgent({
      id: a.id,
      name: a.name,
      initial: a.initial,
      description: a.desc,
      model: a.model,
      temperature: a.temp,
    });
  }

  const agentIdByName = new Map(SAMPLE_AGENTS.map((a) => [a.name, a.id]));

  // 2. Conversations — spaced 30 minutes apart, newest first, so the
  //    list order matches the client's folder buckets.
  const base = Date.now();
  for (let i = 0; i < SAMPLE_CONVERSATIONS.length; i++) {
    const c = SAMPLE_CONVERSATIONS[i]!;
    const agentId = agentIdByName.get(c.agent) ?? 'a-01';
    const updated = new Date(base - i * 30 * 60 * 1000);
    await insertConversation({
      id: c.id,
      title: c.title,
      snippet: c.snippet,
      agent_id: agentId,
      tag: c.tag,
      pinned: c.pinned === true,
      created_at: updated,
      updated_at: updated,
    });
  }

  // 3. Tree nodes for c-01 — stamped sequentially so walk order is
  //    deterministic regardless of the insert order. (Creating in
  //    `parent` order isn't enough because alt-1 branches off n-02.)
  const nodeStart = base - 60 * 60 * 1000;
  for (let i = 0; i < SAMPLE_TREE_NODES.length; i++) {
    const n = SAMPLE_TREE_NODES[i]!;
    const createdAt = new Date(nodeStart + i * 60 * 1000);
    await insertNode({
      id: n.id,
      conversation_id: SAMPLE_TREE_CONVERSATION,
      parent_id: n.parent,
      role: n.role,
      branch: n.branch,
      content: n.content,
      reasoning: n.reasoning,
      tool_call: n.toolCall,
      clarify: n.clarify,
      approval: n.approval,
      streaming: n.streaming === true,
      status: n.status,
      edited: n.edited === true,
      created_at: createdAt,
    });
  }

  await updateConversationPointers(SAMPLE_TREE_CONVERSATION, {
    root_node_id: SAMPLE_TREE_ROOT,
    active_leaf_id: SAMPLE_TREE_ACTIVE_LEAF,
  });

  return c.json({
    ok: true,
    agents: SAMPLE_AGENTS.length,
    conversations: SAMPLE_CONVERSATIONS.length,
    nodes: SAMPLE_TREE_NODES.length,
    populated_conversation: SAMPLE_TREE_CONVERSATION,
  });
});
