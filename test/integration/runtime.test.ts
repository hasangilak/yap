import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted fixture the vi.mock factory reads. Each test pushes a script
// (array of chunks) per anticipated ollama.chat() call; the mock
// shifts one script per call.
const { CHAT_SCRIPTS, CHAT_OPTS } = vi.hoisted(() => ({
  CHAT_SCRIPTS: [] as Array<Array<{ content?: string; tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }> }>>,
  CHAT_OPTS: [] as Array<Record<string, unknown>>,
}));

vi.mock('ollama', () => {
  class Ollama {
    async chat(opts: Record<string, unknown>) {
      CHAT_OPTS.push(opts);
      const script = CHAT_SCRIPTS.shift() ?? [];
      async function* gen() {
        for (const chunk of script) {
          yield {
            message: {
              content: chunk.content ?? '',
              tool_calls: chunk.tool_calls,
            },
          };
        }
      }
      const iter = gen();
      // chrome-less/ollama abortable iterator requires .abort(); keep
      // it a no-op.
      (iter as unknown as { abort: () => void }).abort = () => {};
      return iter;
    }
  }
  return { Ollama };
});

// Also mock the browser so tool tests don't try to fire up Chrome.
vi.mock('../../src/tools/browser.js', () => ({
  webSearch: vi.fn(async (q: string) => `stub search for ${q}`),
  webGoto: vi.fn(async () => 'stub page'),
  webClick: vi.fn(async () => 'stub after click'),
  webType: vi.fn(async () => 'stub after type'),
  webBack: vi.fn(async () => 'stub back'),
}));

import { runAgent } from '../../src/runtime/run.js';
import {
  firstAgentId,
  getConversationRaw,
  insertAgent,
  insertConversation,
} from '../../src/db/queries.js';
import { getPrisma } from '../../src/db/index.js';
import { resolveApproval } from '../../src/runtime/approvals.js';
import { disconnectDb, truncateAll } from '../helpers/db.js';
import type { BusEvent } from '../../src/schemas/index.js';

async function drain(gen: AsyncGenerator<BusEvent, void, unknown>): Promise<BusEvent[]> {
  const out: BusEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

/** Poll `check` at 10ms until it returns non-null or deadline elapses. */
async function waitFor<T>(check: () => T | null, timeoutMs: number): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = check();
    if (v != null) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

async function seed() {
  await insertAgent({
    id: 'a-t',
    name: 'Mock',
    initial: 'M',
    description: '',
    model: 'qwen2.5:14b',
  });
  await insertConversation({ id: 'c-r', title: 'Runtime', agent_id: 'a-t' });
}

beforeEach(async () => {
  CHAT_SCRIPTS.length = 0;
  CHAT_OPTS.length = 0;
  await truncateAll();
  await seed();
});

afterAll(async () => {
  await disconnectDb();
});

describe('runtime — happy path (text only)', () => {
  it('emits node.created(user) → active_leaf.changed → node.created(asst) → status → content × N → node.finalized → active_leaf.changed', async () => {
    CHAT_SCRIPTS.push([{ content: 'Hello ' }, { content: 'world.' }]);
    const events = await drain(
      runAgent({ conversationId: 'c-r', parent: null, content: 'hi' }),
    );
    const kinds = events.map((e) => e.kind);
    // First three are stable:
    expect(kinds[0]).toBe('node.created');
    expect(kinds[1]).toBe('active_leaf.changed');
    expect(kinds[2]).toBe('node.created');
    // Contains at least one content.delta and ends with the two
    // finalization events.
    expect(kinds).toContain('content.delta');
    expect(kinds[kinds.length - 2]).toBe('node.finalized');
    expect(kinds[kinds.length - 1]).toBe('active_leaf.changed');
  });

  it('persists the assistant node and tokens_used bumps', async () => {
    CHAT_SCRIPTS.push([{ content: 'some output text' }]);
    await drain(runAgent({ conversationId: 'c-r', parent: null, content: 'hi' }));
    const conv = await getConversationRaw('c-r');
    expect(conv?.tokensUsed).toBeGreaterThan(0);
    const nodes = await getPrisma().node.findMany({
      where: { conversationId: 'c-r', role: 'asst' },
    });
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.content).toContain('some output text');
  });
});

describe('runtime — tool call flow', () => {
  it('auto-approved web_search produces toolcall.proposed/started/ended then a second assistant round', async () => {
    // Round 1: model requests web_search
    CHAT_SCRIPTS.push([
      {
        tool_calls: [
          { function: { name: 'web_search', arguments: { query: 'rust async' } } },
        ],
      },
    ]);
    // Round 2: model produces a concluding message
    CHAT_SCRIPTS.push([{ content: 'Based on results: …' }]);

    const events = await drain(
      runAgent({ conversationId: 'c-r', parent: null, content: 'search' }),
    );
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('toolcall.proposed');
    expect(kinds).toContain('toolcall.started');
    const ended = events.find((e) => e.kind === 'toolcall.ended');
    expect(ended).toBeDefined();
    expect((ended as { status: string }).status).toBe('ok');
    // No approval because web_search is auto-approved.
    expect(kinds).not.toContain('approval.requested');
  });

  it('write_file requires approval; deny → toolcall.ended(err) and runtime continues', async () => {
    // Round 1: model calls write_file (side-effectful → approval)
    CHAT_SCRIPTS.push([
      {
        tool_calls: [
          {
            function: {
              name: 'write_file',
              arguments: { path: 'x.txt', content: 'y' },
            },
          },
        ],
      },
    ]);
    // Round 2: continuation after user denies
    CHAT_SCRIPTS.push([{ content: 'OK, I will not write.' }]);

    const seen: BusEvent[] = [];
    const gen = runAgent({ conversationId: 'c-r', parent: null, content: 'do it' });

    // Drain the generator in the background so awaitDecision actually
    // gets a chance to register before we fire resolveApproval.
    const drainPromise = (async () => {
      for await (const ev of gen) seen.push(ev);
    })();

    // Wait for the runtime to reach its blocking awaitDecision().
    const approvalEv = await waitFor(
      () => seen.find((e) => e.kind === 'approval.requested') ?? null,
      3_000,
    );
    expect(approvalEv).toBeDefined();
    resolveApproval(
      (approvalEv as { approval_id: string }).approval_id,
      'deny',
    );
    await drainPromise;

    const kinds = seen.map((e) => e.kind);
    expect(kinds).toContain('approval.decided');
    const ended = seen.find((e) => e.kind === 'toolcall.ended');
    expect((ended as { status: string; error?: string }).status).toBe('err');
    expect((ended as { error?: string }).error).toMatch(/denied/i);
  });
});

describe('runtime — token budget', () => {
  it('stops with recoverable:false error when tokens_used already exceeds budget', async () => {
    await getPrisma().conversation.update({
      where: { id: 'c-r' },
      data: { tokensUsed: 999_999, tokenBudget: 1000 },
    });
    const events = await drain(
      runAgent({ conversationId: 'c-r', parent: null, content: 'hi' }),
    );
    // runAgent creates the user node + active_leaf.changed before
    // delegating to runAssistantTurn, so the error comes after those
    // two. The point is: no ollama.chat() call was ever issued.
    const kinds = events.map((e) => e.kind);
    expect(kinds[0]).toBe('node.created');
    expect(kinds[1]).toBe('active_leaf.changed');
    const err = events.find((e) => e.kind === 'error');
    expect(err).toBeDefined();
    expect((err as { recoverable: boolean }).recoverable).toBe(false);
    expect(CHAT_OPTS).toHaveLength(0);
  });
});

describe('runtime — agent not found', () => {
  it('emits error when conversation id is unknown', async () => {
    const events = await drain(
      runAgent({
        conversationId: 'c-does-not-exist',
        parent: null,
        content: 'hi',
      }),
    );
    expect(events[0]!.kind).toBe('error');
  });
});

describe('runtime — <think> tag splitting', () => {
  it('content inside <think> blocks emits reasoning events', async () => {
    CHAT_SCRIPTS.push([
      { content: 'before <think>looking at options</think> after' },
    ]);
    const events = await drain(
      runAgent({ conversationId: 'c-r', parent: null, content: 'go' }),
    );
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('reasoning.delta');
    expect(kinds).toContain('reasoning.step.end');
    // The 'before' and ' after' still arrive as content.delta segments.
    const contentText = events
      .filter((e): e is Extract<BusEvent, { kind: 'content.delta' }> => e.kind === 'content.delta')
      .map((e) => e.delta)
      .join('');
    expect(contentText).toMatch(/before/);
    expect(contentText).toMatch(/after/);
  });
});

describe('runtime — firstAgentId sanity', () => {
  it('returns the seeded agent id', async () => {
    expect(await firstAgentId()).toBe('a-t');
  });
});
