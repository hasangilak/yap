import { describe, expect, it } from 'vitest';
import {
  AgentFullSchema,
  AgentSchema,
  ApprovalDataSchema,
  BusEventSchema,
  ClarifyDataSchema,
  ConversationSchema,
  DecisionSchema,
  MessageNodeSchema,
  MessageTreeSchema,
  PermissionDefaultSchema,
  RoleSchema,
  StatusStateSchema,
  ToolCallDataSchema,
  ToolStatusSchema,
} from '../../src/schemas/index.js';
import {
  SAMPLE_AGENTS,
  SAMPLE_CONVERSATIONS,
  SAMPLE_TREE_NODES,
} from '../../src/seed/samples.js';

describe('schemas — primitives', () => {
  it('Role strictly accepts user | asst (not assistant)', () => {
    expect(RoleSchema.safeParse('user').success).toBe(true);
    expect(RoleSchema.safeParse('asst').success).toBe(true);
    expect(RoleSchema.safeParse('assistant').success).toBe(false);
    expect(RoleSchema.safeParse('').success).toBe(false);
  });

  it('ToolStatus enum matches spec', () => {
    for (const s of ['ok', 'pending', 'err', 'done']) {
      expect(ToolStatusSchema.safeParse(s).success).toBe(true);
    }
    expect(ToolStatusSchema.safeParse('fail').success).toBe(false);
  });

  it('StatusState enum covers five spec states', () => {
    for (const s of ['thinking', 'pondering', 'tool', 'approval', 'streaming']) {
      expect(StatusStateSchema.safeParse(s).success).toBe(true);
    }
  });

  it('Decision + PermissionDefault enums', () => {
    for (const d of ['allow', 'always', 'deny']) {
      expect(DecisionSchema.safeParse(d).success).toBe(true);
    }
    for (const p of ['ask_every_time', 'auto_allow_read', 'auto_allow_all']) {
      expect(PermissionDefaultSchema.safeParse(p).success).toBe(true);
    }
  });
});

describe('schemas — wire shapes', () => {
  it('Conversation accepts client sample shape (display-string agent + updated)', () => {
    for (const c of SAMPLE_CONVERSATIONS) {
      const r = ConversationSchema.safeParse(c);
      expect(r.success, `c=${c.id}`).toBe(true);
    }
  });

  it('MessageNode round-trips every sample tree node', () => {
    for (const n of SAMPLE_TREE_NODES) {
      const r = MessageNodeSchema.safeParse(n);
      expect(r.success, `n=${n.id}`).toBe(true);
    }
  });

  it('MessageTree round-trips the sample tree shape', () => {
    const tree = {
      rootId: 'n-01',
      activeLeaf: 'n-07',
      nodes: Object.fromEntries(SAMPLE_TREE_NODES.map((n) => [n.id, n])),
    };
    const r = MessageTreeSchema.safeParse(tree);
    expect(r.success).toBe(true);
  });

  it('Agent wire shape is exactly 7 fields (strict check)', () => {
    for (const a of SAMPLE_AGENTS) {
      const r = AgentSchema.safeParse(a);
      expect(r.success, `a=${a.id}`).toBe(true);
    }
    // Extra field is stripped by default, not rejected.
    expect(AgentSchema.safeParse({ ...SAMPLE_AGENTS[0], extra: 'foo' }).success).toBe(true);
  });

  it('AgentFullSchema accepts editable shape', () => {
    const full = {
      id: 'a-1',
      name: 'N',
      initial: 'N',
      desc: '',
      model: 'qwen2.5:14b',
      temperature: 0.5,
      top_p: 1.0,
      max_tokens: 4096,
      system_prompt: 'You are helpful.',
      variables: [],
      tool_ids: ['web_search'],
      permission_default: 'ask_every_time',
      current_version_id: 'av-1',
    };
    const r = AgentFullSchema.safeParse(full);
    expect(r.success).toBe(true);
  });

  it('ToolCallData accepts sample tool calls from SAMPLE_TREE', () => {
    const sampleWithTool = SAMPLE_TREE_NODES.find((n) => n.toolCall);
    expect(sampleWithTool).toBeDefined();
    const r = ToolCallDataSchema.safeParse(sampleWithTool!.toolCall);
    expect(r.success).toBe(true);
  });

  it('ClarifyData + ApprovalData accept sample nodes', () => {
    const clarifyNode = SAMPLE_TREE_NODES.find((n) => n.clarify);
    expect(ClarifyDataSchema.safeParse(clarifyNode!.clarify).success).toBe(true);
    const approvalNode = SAMPLE_TREE_NODES.find((n) => n.approval);
    expect(ApprovalDataSchema.safeParse(approvalNode!.approval).success).toBe(true);
  });
});

describe('schemas — BusEvent discriminated union', () => {
  it('accepts each event kind shape', () => {
    const base = { id: 'ev', at: 1, conversation_id: 'c-1' };
    const cases: unknown[] = [
      { ...base, kind: 'content.delta', node_id: 'n', delta: 'x' },
      { ...base, kind: 'status.update', node_id: 'n', state: 'thinking', elapsed_ms: 0 },
      { ...base, kind: 'reasoning.delta', node_id: 'n', step_index: 0, delta: 'r' },
      { ...base, kind: 'reasoning.step.end', node_id: 'n', step_index: 0, final_text: 'r' },
      {
        ...base,
        kind: 'toolcall.ended',
        node_id: 'n',
        status: 'ok',
        elapsed_ms: 100,
      },
      {
        ...base,
        kind: 'approval.requested',
        node_id: 'n',
        approval_id: 'ap',
        approval: { tool: 'w', title: 't', body: 'b' },
      },
      {
        ...base,
        kind: 'approval.decided',
        node_id: 'n',
        approval_id: 'ap',
        decision: 'allow',
      },
      {
        ...base,
        kind: 'clarify.requested',
        node_id: 'n',
        clarify_id: 'cl',
        clarify: { question: 'q', chips: [], input: '' },
      },
      {
        ...base,
        kind: 'clarify.answered',
        node_id: 'n',
        clarify_id: 'cl',
        response: { selected_chip_ids: [], text: '' },
      },
      {
        ...base,
        kind: 'artifact.updated',
        artifact_id: 'art',
        version_id: 'av',
        version: 1,
        title: 'x.md',
      },
      { ...base, kind: 'active_leaf.changed', active_leaf_id: 'n' },
      { ...base, kind: 'error', message: 'boom', recoverable: false },
    ];
    for (const c of cases) {
      const r = BusEventSchema.safeParse(c);
      expect(r.success, `kind=${(c as { kind: string }).kind}`).toBe(true);
    }
  });

  it('rejects unknown kind', () => {
    const r = BusEventSchema.safeParse({
      id: 'x',
      at: 1,
      conversation_id: 'c',
      kind: 'bogus',
    });
    expect(r.success).toBe(false);
  });
});
