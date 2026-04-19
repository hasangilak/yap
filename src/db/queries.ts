import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { getPrisma } from './index.js';
import type {
  Agent,
  AgentFull,
  AgentVariable,
  AgentVersion,
  ApprovalData,
  BusEvent,
  ClarifyChip,
  ClarifyData,
  ClarifyResponse,
  Conversation,
  Decision,
  MessageNode,
  MessageTree,
  PermissionDefault,
  Role,
  StatusState,
  ToolCallData,
} from '../schemas/index.js';

// -- display formatters -------------------------------------------------------

function formatDisplayTime(when: Date, now: Date = new Date()): string {
  const same = when.getFullYear() === now.getFullYear()
    && when.getMonth() === now.getMonth()
    && when.getDate() === now.getDate();
  const hh = String(when.getHours()).padStart(2, '0');
  const mm = String(when.getMinutes()).padStart(2, '0');
  if (same) return `${hh}:${mm}`;
  const diffDays = Math.floor((+now - +when) / 86400000);
  if (diffDays < 7) {
    const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][when.getDay()];
    return `${dow} ${hh}:${mm}`;
  }
  return when.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function bucketByDate(when: Date, now: Date = new Date()): string {
  const diff = +now - +when;
  const day = 86400000;
  if (diff < day) return 'Today';
  if (diff < 7 * day) return 'This week';
  return 'Earlier';
}

// -- row → wire ---------------------------------------------------------------

type NodeRow = {
  id: string;
  conversationId: string;
  parentId: string | null;
  role: string;
  branch: string;
  content: string;
  reasoning: Prisma.JsonValue | null;
  toolCall: Prisma.JsonValue | null;
  clarify: Prisma.JsonValue | null;
  approval: Prisma.JsonValue | null;
  streaming: boolean;
  status: string | null;
  edited: boolean;
  editedFromId: string | null;
  createdAt: Date;
};

function nodeRowToWire(row: NodeRow): MessageNode {
  const node: MessageNode = {
    id: row.id,
    parent: row.parentId,
    role: row.role as Role,
    time: formatDisplayTime(row.createdAt),
    branch: row.branch,
    content: row.content,
  };
  if (Array.isArray(row.reasoning) && row.reasoning.length > 0) {
    node.reasoning = row.reasoning as string[];
  }
  if (row.toolCall && typeof row.toolCall === 'object' && !Array.isArray(row.toolCall)) {
    node.toolCall = row.toolCall as unknown as ToolCallData;
  }
  if (row.clarify && typeof row.clarify === 'object' && !Array.isArray(row.clarify)) {
    node.clarify = row.clarify as unknown as ClarifyData;
  }
  if (row.approval && typeof row.approval === 'object' && !Array.isArray(row.approval)) {
    node.approval = row.approval as unknown as ApprovalData;
  }
  if (row.streaming) node.streaming = true;
  if (row.status) node.status = row.status as StatusState;
  if (row.edited) node.edited = true;
  return node;
}

type ConvRow = {
  id: string;
  title: string;
  snippet: string;
  agentId: string;
  tag: string | null;
  pinned: boolean;
  createdAt: Date;
  updatedAt: Date;
  rootNodeId: string | null;
  activeLeafId: string | null;
  tokenBudget: number;
  tokensUsed: number;
};

function convRowToWire(row: ConvRow, agentName: string): Conversation {
  return {
    id: row.id,
    title: row.title,
    snippet: row.snippet,
    agent: agentName,
    tag: row.tag ?? '',
    ...(row.pinned ? { pinned: true } : {}),
    updated: formatDisplayTime(row.updatedAt),
    folder: row.pinned ? 'Pinned' : bucketByDate(row.updatedAt),
  };
}

// -- conversations ------------------------------------------------------------

export interface InsertConversationInput {
  id: string;
  title: string;
  snippet?: string;
  agent_id: string;
  tag?: string | null;
  pinned?: boolean;
  created_at?: Date;
  updated_at?: Date;
  root_node_id?: string | null;
  active_leaf_id?: string | null;
  token_budget?: number;
  tokens_used?: number;
}

export async function insertConversation(c: InsertConversationInput): Promise<void> {
  const prisma = getPrisma();
  await prisma.conversation.upsert({
    where: { id: c.id },
    update: {},
    create: {
      id: c.id,
      title: c.title,
      snippet: c.snippet ?? '',
      agentId: c.agent_id,
      tag: c.tag ?? null,
      pinned: c.pinned ?? false,
      ...(c.created_at ? { createdAt: c.created_at } : {}),
      ...(c.updated_at ? { updatedAt: c.updated_at } : {}),
      rootNodeId: c.root_node_id ?? null,
      activeLeafId: c.active_leaf_id ?? null,
      tokenBudget: c.token_budget ?? 200000,
      tokensUsed: c.tokens_used ?? 0,
    },
  });
}

export async function updateConversationPointers(
  id: string,
  patch: Partial<{
    root_node_id: string | null;
    active_leaf_id: string | null;
    snippet: string;
    updated_at: Date;
  }>,
): Promise<void> {
  await getPrisma().conversation.update({
    where: { id },
    data: {
      ...(patch.root_node_id !== undefined ? { rootNodeId: patch.root_node_id } : {}),
      ...(patch.active_leaf_id !== undefined ? { activeLeafId: patch.active_leaf_id } : {}),
      ...(patch.snippet !== undefined ? { snippet: patch.snippet } : {}),
      ...(patch.updated_at !== undefined ? { updatedAt: patch.updated_at } : {}),
    },
  });
}

export async function listConversations(): Promise<Conversation[]> {
  const rows = await getPrisma().conversation.findMany({
    orderBy: [{ pinned: 'desc' }, { updatedAt: 'desc' }],
  });
  const agentIds = [...new Set(rows.map((r) => r.agentId))];
  const agents = await getPrisma().agent.findMany({
    where: { id: { in: agentIds } },
    select: { id: true, name: true },
  });
  const agentName = new Map(agents.map((a) => [a.id, a.name]));
  return rows.map((r) => convRowToWire(r, agentName.get(r.agentId) ?? r.agentId));
}

export async function getConversation(id: string): Promise<Conversation | null> {
  const row = await getPrisma().conversation.findUnique({ where: { id } });
  if (!row) return null;
  const agent = await getPrisma().agent.findUnique({
    where: { id: row.agentId },
    select: { name: true },
  });
  return convRowToWire(row, agent?.name ?? row.agentId);
}

export async function getConversationRaw(id: string): Promise<ConvRow | null> {
  return getPrisma().conversation.findUnique({ where: { id } });
}

export async function getConversationTree(id: string): Promise<MessageTree | null> {
  const conv = await getPrisma().conversation.findUnique({
    where: { id },
    select: { rootNodeId: true, activeLeafId: true },
  });
  if (!conv || !conv.rootNodeId || !conv.activeLeafId) return null;
  const rows = await getPrisma().node.findMany({
    where: { conversationId: id },
    orderBy: { createdAt: 'asc' },
  });
  const nodes: Record<string, MessageNode> = {};
  for (const r of rows) nodes[r.id] = nodeRowToWire(r);
  return { rootId: conv.rootNodeId, activeLeaf: conv.activeLeafId, nodes };
}

// -- nodes --------------------------------------------------------------------

export interface InsertNodeInput {
  id: string;
  conversation_id: string;
  parent_id: string | null;
  role: Role;
  branch?: string;
  content?: string;
  reasoning?: string[];
  tool_call?: ToolCallData;
  clarify?: ClarifyData;
  approval?: ApprovalData;
  streaming?: boolean;
  status?: StatusState;
  edited?: boolean;
  edited_from_id?: string | null;
  created_at?: Date;
}

export async function insertNode(n: InsertNodeInput): Promise<MessageNode> {
  const row = await getPrisma().node.upsert({
    where: { id: n.id },
    update: {},
    create: {
      id: n.id,
      conversationId: n.conversation_id,
      parentId: n.parent_id,
      role: n.role,
      branch: n.branch ?? 'main',
      content: n.content ?? '',
      reasoning: n.reasoning ?? undefined,
      toolCall: n.tool_call as unknown as Prisma.InputJsonValue | undefined,
      clarify: n.clarify as unknown as Prisma.InputJsonValue | undefined,
      approval: n.approval as unknown as Prisma.InputJsonValue | undefined,
      streaming: n.streaming ?? false,
      status: n.status ?? null,
      edited: n.edited ?? false,
      editedFromId: n.edited_from_id ?? null,
      ...(n.created_at ? { createdAt: n.created_at } : {}),
    },
  });
  return nodeRowToWire(row);
}

export async function getNode(id: string): Promise<MessageNode | null> {
  const row = await getPrisma().node.findUnique({ where: { id } });
  return row ? nodeRowToWire(row) : null;
}

export interface UpdateNodeInput {
  content?: string;
  reasoning?: string[];
  tool_call?: ToolCallData | null;
  streaming?: boolean;
  status?: StatusState | null;
}

export async function updateNode(id: string, patch: UpdateNodeInput): Promise<MessageNode | null> {
  const data: Prisma.NodeUpdateInput = {};
  if (patch.content !== undefined) data.content = patch.content;
  if (patch.reasoning !== undefined) {
    data.reasoning = patch.reasoning.length ? patch.reasoning : Prisma.JsonNull;
  }
  if (patch.tool_call !== undefined) {
    data.toolCall = patch.tool_call == null
      ? Prisma.JsonNull
      : (patch.tool_call as unknown as Prisma.InputJsonValue);
  }
  if (patch.streaming !== undefined) data.streaming = patch.streaming;
  if (patch.status !== undefined) data.status = patch.status;
  if (Object.keys(data).length === 0) return getNode(id);
  const row = await getPrisma().node.update({ where: { id }, data });
  return nodeRowToWire(row);
}

export async function walkChain(conversationId: string, leafId: string): Promise<MessageNode[]> {
  const prisma = getPrisma();
  const chain: MessageNode[] = [];
  let cursor: string | null = leafId;
  while (cursor) {
    const row: NodeRow | null = await prisma.node.findFirst({
      where: { id: cursor, conversationId },
    });
    if (!row) break;
    chain.unshift(nodeRowToWire(row));
    cursor = row.parentId;
  }
  return chain;
}

// -- agents -------------------------------------------------------------------

export interface InsertAgentInput {
  id: string;
  name: string;
  initial: string;
  description: string;
  model: string;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  system_prompt?: string;
  tool_ids?: string[];
  variables?: AgentVariable[];
  permission_default?: PermissionDefault;
}

export async function insertAgent(a: InsertAgentInput): Promise<void> {
  await getPrisma().agent.upsert({
    where: { id: a.id },
    update: {},
    create: {
      id: a.id,
      name: a.name,
      initial: a.initial,
      description: a.description,
      model: a.model,
      temperature: a.temperature ?? 0.5,
      topP: a.top_p ?? 1.0,
      maxTokens: a.max_tokens ?? 4096,
      systemPrompt: a.system_prompt ?? '',
      toolIds: a.tool_ids ?? [],
      variables: a.variables ?? [],
      permissionDefault: a.permission_default ?? 'ask_every_time',
    },
  });
}

// -- agent CRUD + versions (Phase 4) -------------------------------------

function newAgentId(): string {
  return `a-${randomUUID().slice(0, 8)}`;
}

function newVersionId(): string {
  return `av-${randomUUID().slice(0, 8)}`;
}

function rowToAgentFull(row: {
  id: string;
  name: string;
  initial: string;
  description: string;
  model: string;
  temperature: number;
  topP: number;
  maxTokens: number;
  systemPrompt: string;
  toolIds: unknown;
  variables: unknown;
  permissionDefault: string;
  currentVersionId: string | null;
}): AgentFull {
  return {
    id: row.id,
    name: row.name,
    initial: row.initial,
    desc: row.description,
    model: row.model,
    temperature: row.temperature,
    top_p: row.topP,
    max_tokens: row.maxTokens,
    system_prompt: row.systemPrompt,
    variables: Array.isArray(row.variables) ? (row.variables as AgentVariable[]) : [],
    tool_ids: Array.isArray(row.toolIds) ? (row.toolIds as string[]) : [],
    permission_default: (row.permissionDefault as PermissionDefault) ?? 'ask_every_time',
    current_version_id: row.currentVersionId,
  };
}

function snapshotOf(full: AgentFull): Omit<AgentFull, 'id' | 'current_version_id'> {
  const { id: _id, current_version_id: _cv, ...rest } = full;
  return rest;
}

export interface CreateAgentInput {
  name: string;
  initial?: string;
  desc?: string;
  model?: string;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  system_prompt?: string;
  variables?: AgentVariable[];
  tool_ids?: string[];
  permission_default?: PermissionDefault;
  message?: string;
}

/**
 * Create a new agent and its initial v1 AgentVersion in one transaction.
 * Returns the full editable shape with `current_version_id` populated.
 */
export async function createAgent(input: CreateAgentInput): Promise<AgentFull> {
  const prisma = getPrisma();
  const id = newAgentId();
  const versionId = newVersionId();
  const initial = (input.initial ?? input.name[0] ?? '?').toUpperCase();

  const fullAfter: AgentFull = {
    id,
    name: input.name,
    initial,
    desc: input.desc ?? '',
    model: input.model ?? 'qwen2.5:14b',
    temperature: input.temperature ?? 0.5,
    top_p: input.top_p ?? 1.0,
    max_tokens: input.max_tokens ?? 4096,
    system_prompt: input.system_prompt ?? '',
    variables: input.variables ?? [],
    tool_ids: input.tool_ids ?? [],
    permission_default: input.permission_default ?? 'ask_every_time',
    current_version_id: versionId,
  };

  await prisma.$transaction([
    prisma.agent.create({
      data: {
        id: fullAfter.id,
        name: fullAfter.name,
        initial: fullAfter.initial,
        description: fullAfter.desc,
        model: fullAfter.model,
        temperature: fullAfter.temperature,
        topP: fullAfter.top_p,
        maxTokens: fullAfter.max_tokens,
        systemPrompt: fullAfter.system_prompt,
        toolIds: fullAfter.tool_ids,
        variables: fullAfter.variables as unknown as Prisma.InputJsonValue,
        permissionDefault: fullAfter.permission_default,
        currentVersionId: versionId,
      },
    }),
    prisma.agentVersion.create({
      data: {
        id: versionId,
        agentId: id,
        version: 1,
        message: input.message ?? 'Initial version',
        snapshot: snapshotOf(fullAfter) as unknown as Prisma.InputJsonValue,
        parentVersionId: null,
      },
    }),
  ]);

  return fullAfter;
}

export async function getAgentFull(id: string): Promise<AgentFull | null> {
  const row = await getPrisma().agent.findFirst({
    where: { id, deletedAt: null },
  });
  return row ? rowToAgentFull(row) : null;
}

export interface PatchAgentInput {
  name?: string;
  initial?: string;
  desc?: string;
  model?: string;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  system_prompt?: string;
  variables?: AgentVariable[];
  tool_ids?: string[];
  permission_default?: PermissionDefault;
  message?: string;
}

/**
 * Apply a patch to an agent and record a new AgentVersion. The returned
 * `full` is post-patch; `version` is the row that was just written.
 * Throws if the agent is missing or soft-deleted.
 */
export async function patchAgent(
  id: string,
  patch: PatchAgentInput,
): Promise<{ full: AgentFull; version: AgentVersion }> {
  const prisma = getPrisma();
  return prisma.$transaction(async (tx) => {
    const row = await tx.agent.findFirst({ where: { id, deletedAt: null } });
    if (!row) throw new Error(`agent ${id} not found`);
    const current = rowToAgentFull(row);
    const patched: AgentFull = {
      ...current,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.initial !== undefined ? { initial: patch.initial } : {}),
      ...(patch.desc !== undefined ? { desc: patch.desc } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.temperature !== undefined ? { temperature: patch.temperature } : {}),
      ...(patch.top_p !== undefined ? { top_p: patch.top_p } : {}),
      ...(patch.max_tokens !== undefined ? { max_tokens: patch.max_tokens } : {}),
      ...(patch.system_prompt !== undefined ? { system_prompt: patch.system_prompt } : {}),
      ...(patch.variables !== undefined ? { variables: patch.variables } : {}),
      ...(patch.tool_ids !== undefined ? { tool_ids: patch.tool_ids } : {}),
      ...(patch.permission_default !== undefined
        ? { permission_default: patch.permission_default }
        : {}),
    };

    const prevMax = await tx.agentVersion.findFirst({
      where: { agentId: id },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const nextVersion = (prevMax?.version ?? 0) + 1;
    const versionId = newVersionId();

    const created = await tx.agentVersion.create({
      data: {
        id: versionId,
        agentId: id,
        version: nextVersion,
        message: patch.message ?? '',
        snapshot: snapshotOf(patched) as unknown as Prisma.InputJsonValue,
        parentVersionId: row.currentVersionId,
      },
    });

    const updated = await tx.agent.update({
      where: { id },
      data: {
        name: patched.name,
        initial: patched.initial,
        description: patched.desc,
        model: patched.model,
        temperature: patched.temperature,
        topP: patched.top_p,
        maxTokens: patched.max_tokens,
        systemPrompt: patched.system_prompt,
        toolIds: patched.tool_ids,
        variables: patched.variables as unknown as Prisma.InputJsonValue,
        permissionDefault: patched.permission_default,
        currentVersionId: versionId,
      },
    });

    return {
      full: rowToAgentFull(updated),
      version: {
        id: created.id,
        agent_id: created.agentId,
        version: created.version,
        message: created.message,
        snapshot: created.snapshot as unknown as AgentVersion['snapshot'],
        eval_score: created.evalScore,
        parent_version_id: created.parentVersionId,
        created_at: created.createdAt.toISOString(),
      },
    };
  });
}

export async function softDeleteAgent(id: string): Promise<boolean> {
  try {
    await getPrisma().agent.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    return true;
  } catch {
    return false;
  }
}

export async function listAgentVersions(agentId: string): Promise<AgentVersion[]> {
  const rows = await getPrisma().agentVersion.findMany({
    where: { agentId },
    orderBy: { version: 'desc' },
  });
  return rows.map((r) => ({
    id: r.id,
    agent_id: r.agentId,
    version: r.version,
    message: r.message,
    snapshot: r.snapshot as unknown as AgentVersion['snapshot'],
    eval_score: r.evalScore,
    parent_version_id: r.parentVersionId,
    created_at: r.createdAt.toISOString(),
  }));
}

export async function getAgentVersion(
  agentId: string,
  version: number,
): Promise<AgentVersion | null> {
  const row = await getPrisma().agentVersion.findUnique({
    where: { agentId_version: { agentId, version } },
  });
  if (!row) return null;
  return {
    id: row.id,
    agent_id: row.agentId,
    version: row.version,
    message: row.message,
    snapshot: row.snapshot as unknown as AgentVersion['snapshot'],
    eval_score: row.evalScore,
    parent_version_id: row.parentVersionId,
    created_at: row.createdAt.toISOString(),
  };
}

type AgentRow = {
  id: string;
  name: string;
  initial: string;
  description: string;
  model: string;
  temperature: number;
  topP: number;
  maxTokens: number;
  systemPrompt: string;
  toolIds: Prisma.JsonValue;
};

function agentRowToWire(row: AgentRow): Agent {
  return {
    id: row.id,
    name: row.name,
    initial: row.initial,
    desc: row.description,
    model: row.model,
    tools: Array.isArray(row.toolIds) ? row.toolIds.length : 0,
    temp: row.temperature,
  };
}

export async function listAgents(): Promise<Agent[]> {
  const rows = await getPrisma().agent.findMany({
    where: { deletedAt: null },
    orderBy: { id: 'asc' },
  });
  return rows.map(agentRowToWire);
}

export async function getAgent(id: string): Promise<Agent | null> {
  const row = await getPrisma().agent.findFirst({ where: { id, deletedAt: null } });
  return row ? agentRowToWire(row) : null;
}

export async function getAgentRaw(id: string): Promise<AgentRow | null> {
  return getPrisma().agent.findUnique({ where: { id } });
}

export async function firstAgentId(): Promise<string | null> {
  const row = await getPrisma().agent.findFirst({
    orderBy: { id: 'asc' },
    select: { id: true },
  });
  return row?.id ?? null;
}

// -- events -------------------------------------------------------------------

export async function insertEvent(ev: BusEvent): Promise<void> {
  const nodeId = (ev as unknown as { node_id?: string }).node_id ?? null;
  await getPrisma().event.create({
    data: {
      id: ev.id,
      conversationId: ev.conversation_id,
      nodeId,
      kind: ev.kind,
      payload: ev as unknown as Prisma.InputJsonValue,
      at: new Date(ev.at),
    },
  });
}

// -- clarifications (Phase 5a) -------------------------------------------------

export interface InsertClarifyInput {
  id: string;
  conversation_id: string;
  node_id: string;
  question: string;
  chips: ClarifyChip[];
  input_hint: string;
}

export async function insertClarify(input: InsertClarifyInput): Promise<void> {
  await getPrisma().clarify.create({
    data: {
      id: input.id,
      conversationId: input.conversation_id,
      nodeId: input.node_id,
      question: input.question,
      chips: input.chips as unknown as Prisma.InputJsonValue,
      inputHint: input.input_hint,
    },
  });
}

export interface ClarifyRow {
  id: string;
  conversationId: string;
  nodeId: string;
  question: string;
  chips: ClarifyChip[];
  inputHint: string;
  response: ClarifyResponse | null;
  respondedAt: Date | null;
  createdAt: Date;
}

export async function getClarify(id: string): Promise<ClarifyRow | null> {
  const row = await getPrisma().clarify.findUnique({ where: { id } });
  if (!row) return null;
  return {
    id: row.id,
    conversationId: row.conversationId,
    nodeId: row.nodeId,
    question: row.question,
    chips: (row.chips ?? []) as unknown as ClarifyChip[],
    inputHint: row.inputHint,
    response: (row.response ?? null) as unknown as ClarifyResponse | null,
    respondedAt: row.respondedAt,
    createdAt: row.createdAt,
  };
}

export async function recordClarifyResponse(
  id: string,
  response: ClarifyResponse,
): Promise<void> {
  await getPrisma().clarify.update({
    where: { id },
    data: {
      response: response as unknown as Prisma.InputJsonValue,
      respondedAt: new Date(),
    },
  });
}

// -- tree operations (Phase 3) -------------------------------------------------

/**
 * Pick the next available `alt-N` branch label for this conversation.
 * Branches are never renamed, so the server just scans the highest
 * existing `alt-N` and increments. Returns "alt-1" if the conversation
 * has never branched.
 */
export async function nextBranchName(conversationId: string): Promise<string> {
  const rows = await getPrisma().node.findMany({
    where: { conversationId, branch: { startsWith: 'alt-' } },
    select: { branch: true },
  });
  let max = 0;
  for (const r of rows) {
    const m = r.branch.match(/^alt-(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `alt-${max + 1}`;
}

/**
 * All node ids in the subtree rooted at `nodeId`, excluding the root
 * itself. Walks the tree programmatically (no recursive CTE) because
 * Phase 1 trees are small and Prisma's raw SQL escape hatch isn't
 * worth the portability cost here.
 */
export async function listDescendantIds(
  conversationId: string,
  nodeId: string,
): Promise<string[]> {
  const prisma = getPrisma();
  const all = await prisma.node.findMany({
    where: { conversationId },
    select: { id: true, parentId: true },
  });
  const children = new Map<string, string[]>();
  for (const n of all) {
    if (!n.parentId) continue;
    const list = children.get(n.parentId) ?? [];
    list.push(n.id);
    children.set(n.parentId, list);
  }
  const out: string[] = [];
  const stack: string[] = [nodeId];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const kids = children.get(cur) ?? [];
    for (const k of kids) {
      out.push(k);
      stack.push(k);
    }
  }
  return out;
}

/**
 * Delete a node and its entire subtree. Returns the count of rows
 * removed (root included). Does not touch the conversation's
 * root_node_id / active_leaf_id — the caller is responsible for fixing
 * those pointers if they land inside the deleted set.
 */
export async function deleteSubtree(
  conversationId: string,
  rootId: string,
): Promise<number> {
  const descendants = await listDescendantIds(conversationId, rootId);
  const ids = [rootId, ...descendants];
  const { count } = await getPrisma().node.deleteMany({
    where: { id: { in: ids } },
  });
  return count;
}

/**
 * Metadata for ripple-preview: which descendants have tool calls or
 * approvals attached, and how many total nodes would be replayed.
 */
export async function rippleCounts(
  conversationId: string,
  nodeId: string,
): Promise<{ descendant_count: number; tool_calls_to_replay: number; approvals_required: number }> {
  const ids = await listDescendantIds(conversationId, nodeId);
  if (ids.length === 0) {
    return { descendant_count: 0, tool_calls_to_replay: 0, approvals_required: 0 };
  }
  const rows = await getPrisma().node.findMany({
    where: { id: { in: ids } },
    select: { toolCall: true, approval: true },
  });
  let tools = 0;
  let approvals = 0;
  for (const r of rows) {
    if (r.toolCall) tools++;
    if (r.approval) approvals++;
  }
  return { descendant_count: ids.length, tool_calls_to_replay: tools, approvals_required: approvals };
}

// -- approvals (Phase 2) -------------------------------------------------------

export interface InsertApprovalInput {
  id: string;
  conversation_id: string;
  node_id: string;
  tool: string;
  title: string;
  body: string;
  preview?: string;
}

export async function insertApproval(a: InsertApprovalInput): Promise<void> {
  await getPrisma().approval.create({
    data: {
      id: a.id,
      conversationId: a.conversation_id,
      nodeId: a.node_id,
      tool: a.tool,
      title: a.title,
      body: a.body,
      preview: a.preview ?? null,
    },
  });
}

export interface ApprovalRow {
  id: string;
  conversationId: string;
  nodeId: string;
  tool: string;
  title: string;
  body: string;
  preview: string | null;
  decision: string | null;
  decidedAt: Date | null;
  rememberKey: string | null;
  createdAt: Date;
}

export async function getApproval(id: string): Promise<ApprovalRow | null> {
  return getPrisma().approval.findUnique({ where: { id } });
}

export async function recordApprovalDecision(
  id: string,
  decision: Decision,
  rememberKey: string | null,
): Promise<ApprovalRow | null> {
  return getPrisma().approval.update({
    where: { id },
    data: {
      decision,
      decidedAt: new Date(),
      rememberKey,
    },
  });
}

// -- approval grants (Phase 2) -------------------------------------------------

const LOCAL_USER = 'local';

export async function hasGrant(agentId: string, toolId: string): Promise<boolean> {
  const row = await getPrisma().approvalGrant.findUnique({
    where: { userId_agentId_toolId: { userId: LOCAL_USER, agentId, toolId } },
  });
  return row !== null;
}

export async function insertGrant(agentId: string, toolId: string): Promise<void> {
  await getPrisma().approvalGrant.upsert({
    where: { userId_agentId_toolId: { userId: LOCAL_USER, agentId, toolId } },
    update: {},
    create: { userId: LOCAL_USER, agentId, toolId },
  });
}

export interface GrantRow {
  userId: string;
  agentId: string;
  toolId: string;
  createdAt: Date;
}

export async function listGrants(): Promise<GrantRow[]> {
  return getPrisma().approvalGrant.findMany({ orderBy: [{ agentId: 'asc' }, { toolId: 'asc' }] });
}

export async function deleteGrant(agentId: string, toolId: string): Promise<boolean> {
  try {
    await getPrisma().approvalGrant.delete({
      where: { userId_agentId_toolId: { userId: LOCAL_USER, agentId, toolId } },
    });
    return true;
  } catch {
    return false;
  }
}

/** Agent's permission default, falling back to 'ask_every_time' when missing. */
export async function getAgentPermission(agentId: string): Promise<PermissionDefault> {
  const row = await getPrisma().agent.findUnique({
    where: { id: agentId },
    select: { permissionDefault: true },
  });
  const v = row?.permissionDefault ?? 'ask_every_time';
  return (v === 'auto_allow_read' || v === 'auto_allow_all' ? v : 'ask_every_time') as PermissionDefault;
}

export async function listEventsSince(
  conversationId: string,
  sinceEventId: string | null,
): Promise<BusEvent[]> {
  const prisma = getPrisma();
  let sinceSeq: bigint = 0n;
  if (sinceEventId) {
    const row = await prisma.event.findUnique({
      where: { id: sinceEventId },
      select: { seq: true },
    });
    if (row) sinceSeq = row.seq;
  }
  const rows = await prisma.event.findMany({
    where: { conversationId, seq: { gt: sinceSeq } },
    orderBy: { seq: 'asc' },
  });
  return rows.map((r) => r.payload as unknown as BusEvent);
}
