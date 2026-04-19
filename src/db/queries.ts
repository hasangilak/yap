import { Prisma } from '@prisma/client';
import { getPrisma } from './index.js';
import type {
  Agent,
  ApprovalData,
  BusEvent,
  ClarifyData,
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
    },
  });
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
  const rows = await getPrisma().agent.findMany({ orderBy: { id: 'asc' } });
  return rows.map(agentRowToWire);
}

export async function getAgent(id: string): Promise<Agent | null> {
  const row = await getPrisma().agent.findUnique({ where: { id } });
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
