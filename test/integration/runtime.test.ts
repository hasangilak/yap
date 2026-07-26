import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Hoisted fixtures the `vi.mock` factory reads. Each test pushes one script
 * (an array of chunks) per anticipated model round; the mock shifts one script
 * per `.stream()` call.
 *
 * The mock targets `@langchain/ollama` rather than `ollama` because the turn
 * runtime now goes through `ChatOllama`. It yields real `AIMessageChunk`
 * instances with `tool_call_chunks` carrying **stringified** args, which is
 * what a live Ollama stream actually produces — the runtime relies on
 * `AIMessageChunk.concat()` to reassemble and parse them, so faking the parsed
 * shape would test a code path that never runs in production.
 */
const { CHAT_SCRIPTS, STREAM_CALLS, MID_STREAM } = vi.hoisted(() => ({
  CHAT_SCRIPTS: [] as Array<
    Array<{
      content?: string;
      tool_calls?: Array<{
        function: { name: string; arguments: Record<string, unknown> };
      }>;
    }>
  >,
  STREAM_CALLS: [] as Array<Record<string, unknown>>,
  /**
   * One optional hook per model round, run after the round's first chunk.
   *
   * This is how a test simulates something happening *while* the model is
   * streaming — a user interjecting mid-sentence. Without it the mock stream
   * completes atomically and the mid-round race can't be reached at all.
   */
  MID_STREAM: [] as Array<(() => Promise<void>) | undefined>,
}));

vi.mock('@langchain/ollama', async () => {
  const { AIMessageChunk } = await import('@langchain/core/messages');
  class ChatOllama {
    constructor(public opts: Record<string, unknown>) {}

    bindTools() {
      return {
        stream: async (
          messages: unknown,
          callOpts?: Record<string, unknown>,
        ) => {
          STREAM_CALLS.push({ messages, callOpts });
          const script = CHAT_SCRIPTS.shift() ?? [];
          const midStream = MID_STREAM.shift();
          async function* gen() {
            let emitted = 0;
            for (const chunk of script) {
              if (emitted === 1 && midStream) await midStream();
              emitted++;
              if (chunk.tool_calls) {
                yield new AIMessageChunk({
                  content: chunk.content ?? '',
                  tool_call_chunks: chunk.tool_calls.map((tc, i) => ({
                    name: tc.function.name,
                    args: JSON.stringify(tc.function.arguments),
                    id: `call_${i}`,
                    index: i,
                    type: 'tool_call_chunk' as const,
                  })),
                });
              } else {
                yield new AIMessageChunk({ content: chunk.content ?? '' });
              }
            }
          }
          return gen();
        },
      };
    }
  }
  return { ChatOllama };
});

// Also mock the browser so tool tests don't try to fire up Chrome.
vi.mock('../../src/tools/browser.js', () => ({
  webSearch: vi.fn(async (q: string) => `stub search for ${q}`),
  webGoto: vi.fn(async () => 'stub page'),
  webClick: vi.fn(async () => 'stub after click'),
  webType: vi.fn(async () => 'stub after type'),
  webBack: vi.fn(async () => 'stub back'),
}));

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resumeTurn, runAgent } from '../../src/runtime/run.js';
import { setupCheckpointer } from '../../src/runtime/graph/checkpointer.js';
import { getPendingInterrupts } from '../../src/runtime/graph/index.js';
import { config } from '../../src/config.js';
import {
  firstAgentId,
  getConversationRaw,
  getPrompt,
  insertAgent,
  insertConversation,
  insertInterjection,
  listPrompts,
  peekInterjections,
} from '../../src/db/queries.js';
import { getPrisma } from '../../src/db/index.js';
import {
  disconnectDb,
  truncateAll,
  truncateCheckpoints,
} from '../helpers/db.js';
import type { BusEvent } from '../../src/schemas/index.js';

async function drain(
  gen: AsyncGenerator<BusEvent, void, unknown>,
): Promise<BusEvent[]> {
  const out: BusEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
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
  STREAM_CALLS.length = 0;
  MID_STREAM.length = 0;
  await setupCheckpointer();
  await truncateAll();
  await truncateCheckpoints();
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
    expect(kinds[0]).toBe('node.created');
    expect(kinds[1]).toBe('active_leaf.changed');
    expect(kinds[2]).toBe('node.created');
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

  it('clears streaming so boot recovery does not treat the turn as stranded', async () => {
    CHAT_SCRIPTS.push([{ content: 'done' }]);
    await drain(runAgent({ conversationId: 'c-r', parent: null, content: 'hi' }));
    const nodes = await getPrisma().node.findMany({
      where: { conversationId: 'c-r', role: 'asst' },
    });
    expect(nodes[0]!.streaming).toBe(false);
    expect(nodes[0]!.status).toBeNull();
  });
});

describe('runtime — tool call flow', () => {
  it('auto-approved web_search produces toolcall.proposed/started/ended then a second assistant round', async () => {
    CHAT_SCRIPTS.push([
      {
        tool_calls: [
          { function: { name: 'web_search', arguments: { query: 'rust async' } } },
        ],
      },
    ]);
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
    // No prompt because web_search is auto-approved.
    expect(kinds).not.toContain('prompt.requested');
  });

  it('write_file pauses the turn on an interrupt rather than blocking in-process', async () => {
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

    // The generator now *completes* at the pause — a LangGraph stream
    // terminates when a node interrupts. Previously this required draining in
    // the background because the runtime blocked on an in-process promise.
    const first = await drain(
      runAgent({ conversationId: 'c-r', parent: null, content: 'do it' }),
    );
    const promptEv = first.find((e) => e.kind === 'prompt.requested');
    expect(promptEv).toBeDefined();
    expect(promptEv).toMatchObject({
      tool: 'write_file',
      request: { prompt_kind: 'approval' },
    });

    // The pause is durable: it lives in the checkpointer, not in memory.
    const asstId = (promptEv as { node_id: string }).node_id;
    expect(await getPendingInterrupts(asstId)).toHaveLength(1);

    // The row backing the prompt is written before the pause, so a client can
    // find out what is being asked without replaying the event stream.
    const promptId = (promptEv as { prompt_id: string }).prompt_id;
    const row = await getPrompt(promptId);
    expect(row).toMatchObject({ kind: 'approval', tool: 'write_file', nodeId: asstId });
    expect(row?.response).toBeNull();
    expect(await listPrompts('c-r', true)).toHaveLength(1);

    // Only one model round happened; the turn is genuinely parked.
    expect(STREAM_CALLS).toHaveLength(1);
  });

  it('deny → toolcall.ended(err) and the turn continues after resume', async () => {
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
    CHAT_SCRIPTS.push([{ content: 'OK, I will not write.' }]);

    const first = await drain(
      runAgent({ conversationId: 'c-r', parent: null, content: 'do it' }),
    );
    const promptEv = first.find((e) => e.kind === 'prompt.requested');
    const asstId = (promptEv as { node_id: string }).node_id;

    const second = await drain(
      resumeTurn({
        conversationId: 'c-r',
        asstNodeId: asstId,
        resume: { prompt_kind: 'approval', decision: 'deny' },
      }),
    );

    const kinds = second.map((e) => e.kind);
    expect(kinds).toContain('prompt.responded');
    const ended = second.find((e) => e.kind === 'toolcall.ended');
    expect((ended as { status: string }).status).toBe('err');
    expect((ended as { error?: string }).error).toMatch(/denied/i);
    // The loop resumed: a second model round ran and the turn finalized.
    expect(STREAM_CALLS).toHaveLength(2);
    expect(kinds).toContain('node.finalized');
  });

  it('allow → the tool runs and the turn finalizes', async () => {
    CHAT_SCRIPTS.push([
      {
        tool_calls: [
          {
            function: {
              name: 'write_file',
              arguments: { path: 'allowed.txt', content: 'hi' },
            },
          },
        ],
      },
    ]);
    CHAT_SCRIPTS.push([{ content: 'Written.' }]);

    const first = await drain(
      runAgent({ conversationId: 'c-r', parent: null, content: 'do it' }),
    );
    const asstId = (
      first.find((e) => e.kind === 'prompt.requested') as { node_id: string }
    ).node_id;

    const second = await drain(
      resumeTurn({
        conversationId: 'c-r',
        asstNodeId: asstId,
        resume: { prompt_kind: 'approval', decision: 'allow' },
      }),
    );
    const kinds = second.map((e) => e.kind);
    expect(kinds).toContain('toolcall.started');
    const ended = second.find((e) => e.kind === 'toolcall.ended');
    expect((ended as { status: string }).status).toBe('ok');
    expect(kinds).toContain('node.finalized');
    // Nothing is left pending once the turn is done.
    expect(await getPendingInterrupts(asstId)).toHaveLength(0);
  });

  /**
   * Edit-then-approve. The point of the assertion is that the tool ran with
   * the human's args, not the model's — so `toolcall.started` must carry the
   * edited path, and the file the model asked for must not exist.
   */
  it('edited_args replace the proposed args before the tool runs', async () => {
    CHAT_SCRIPTS.push([
      {
        tool_calls: [
          {
            function: {
              name: 'write_file',
              arguments: { path: 'model-chose.txt', content: 'from model' },
            },
          },
        ],
      },
    ]);
    CHAT_SCRIPTS.push([{ content: 'Done.' }]);

    const first = await drain(
      runAgent({ conversationId: 'c-r', parent: null, content: 'do it' }),
    );
    const asstId = (
      first.find((e) => e.kind === 'prompt.requested') as { node_id: string }
    ).node_id;

    const second = await drain(
      resumeTurn({
        conversationId: 'c-r',
        asstNodeId: asstId,
        resume: {
          prompt_kind: 'approval',
          decision: 'allow',
          edited_args: { path: 'human-chose.txt', content: 'from human' },
        },
      }),
    );

    const started = second.find((e) => e.kind === 'toolcall.started');
    expect(started).toMatchObject({
      tool: 'write_file',
      args: { path: 'human-chose.txt', content: 'from human' },
    });
    expect((second.find((e) => e.kind === 'toolcall.ended') as { status: string }).status)
      .toBe('ok');

    // The response event carries the edit, so a client rebuilding history from
    // the stream shows what actually ran rather than what was proposed.
    expect(second.find((e) => e.kind === 'prompt.responded')).toMatchObject({
      response: {
        prompt_kind: 'approval',
        decision: 'allow',
        edited_args: { path: 'human-chose.txt' },
      },
    });

    const written = await readFile(
      join(config.artifactsDir, 'human-chose.txt'),
      'utf8',
    );
    expect(written).toBe('from human');
    await expect(
      readFile(join(config.artifactsDir, 'model-chose.txt'), 'utf8'),
    ).rejects.toThrow();
  });

  /**
   * Edited args are not a trust boundary bypass: `executeTool` validates paths
   * at execution time, so the sandbox check applies to a human's edit exactly
   * as it does to a model's proposal.
   */
  it('edited_args cannot escape the write_file sandbox', async () => {
    CHAT_SCRIPTS.push([
      {
        tool_calls: [
          {
            function: {
              name: 'write_file',
              arguments: { path: 'fine.txt', content: 'ok' },
            },
          },
        ],
      },
    ]);
    CHAT_SCRIPTS.push([{ content: 'Could not write.' }]);

    const first = await drain(
      runAgent({ conversationId: 'c-r', parent: null, content: 'do it' }),
    );
    const asstId = (
      first.find((e) => e.kind === 'prompt.requested') as { node_id: string }
    ).node_id;

    const second = await drain(
      resumeTurn({
        conversationId: 'c-r',
        asstNodeId: asstId,
        resume: {
          prompt_kind: 'approval',
          decision: 'allow',
          edited_args: { path: '../../escaped.txt', content: 'pwned' },
        },
      }),
    );

    const ended = second.find((e) => e.kind === 'toolcall.ended');
    expect((ended as { status: string }).status).toBe('err');
    expect((ended as { error?: string }).error).toMatch(/path|escape|outside|sandbox/i);
  });
});

describe('runtime — mid-turn steering', () => {
  /**
   * The durable half of steering, end to end: text persisted while the turn is
   * parked must reach the *next* model round.
   *
   * Driven through an approval pause because that is the point where the
   * assistant node id is known and the turn is genuinely mid-flight — the same
   * shape as a user typing while a prompt is on screen.
   */
  it('an interjection persisted mid-turn is injected into the next round', async () => {
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
    CHAT_SCRIPTS.push([{ content: 'Understood, switching approach.' }]);

    const first = await drain(
      runAgent({ conversationId: 'c-r', parent: null, content: 'do it' }),
    );
    const asstId = (
      first.find((e) => e.kind === 'prompt.requested') as { node_id: string }
    ).node_id;

    await insertInterjection({
      id: 'ij-test',
      conversation_id: 'c-r',
      node_id: asstId,
      text: 'actually, stop and just summarise',
    });

    await drain(
      resumeTurn({
        conversationId: 'c-r',
        asstNodeId: asstId,
        resume: { prompt_kind: 'approval', decision: 'deny' },
      }),
    );

    // The second model call must carry the steering as a user message.
    expect(STREAM_CALLS).toHaveLength(2);
    const secondRound = STREAM_CALLS[1]!.messages as Array<{ content: unknown }>;
    const texts = secondRound.map((m) => String(m.content));
    expect(texts).toContain('actually, stop and just summarise');

    // Consumed only after the round completed, so it is not re-injected.
    expect(await peekInterjections(asstId)).toHaveLength(0);
  });

  /**
   * Regression: an interjection arriving *mid-round* must not let the turn
   * finalize without applying it.
   *
   * This was a real bug found by interjecting against a live Ollama. The abort
   * and the persistence both worked, but an aborted round produces no tool
   * calls — which is indistinguishable from a finished round — so
   * `afterCallModel` routed straight to `finalize`. The turn ended having
   * accepted the user's steering and never used it (`consumed_at` stayed null).
   * `pendingSteering` plus the `callModel` self-edge is the fix.
   */
  it('does not finalize while steering arrived mid-round is unapplied', async () => {
    CHAT_SCRIPTS.push([{ content: 'Writing a long essay' }, { content: ' about canals…' }]);
    CHAT_SCRIPTS.push([{ content: 'I was steered.' }]);

    // Fires between the first and second chunk of round 1 — i.e. while the
    // model is still streaming, which is when a real user would interject.
    MID_STREAM.push(async () => {
      const nodes = await getPrisma().node.findMany({
        where: { conversationId: 'c-r', role: 'asst' },
        select: { id: true },
      });
      await insertInterjection({
        id: 'ij-mid',
        conversation_id: 'c-r',
        node_id: nodes[0]!.id,
        text: 'stop, just say you were steered',
      });
    });

    const events = await drain(
      runAgent({ conversationId: 'c-r', parent: null, content: 'write an essay' }),
    );

    // A second round ran, and it carried the steering.
    expect(STREAM_CALLS).toHaveLength(2);
    const round2 = (STREAM_CALLS[1]!.messages as Array<{ content: unknown }>).map((m) =>
      String(m.content),
    );
    expect(round2).toContain('stop, just say you were steered');

    // The turn finalized only after applying it, and nothing is left pending.
    expect(events.map((e) => e.kind)).toContain('node.finalized');
    const asstId = (
      events.find(
        (e) => e.kind === 'node.created' && e.node.role === 'asst',
      ) as { node: { id: string } }
    ).node.id;
    expect(await peekInterjections(asstId)).toHaveLength(0);
  });

  /**
   * The self-edge added for steering must stay bounded, or a user could keep a
   * turn alive forever by interjecting. `afterCallModel` checks the round
   * budget before either continuation path.
   */
  it('stops steering rounds at the round budget', async () => {
    for (let i = 0; i < config.maxToolRounds + 3; i++) {
      CHAT_SCRIPTS.push([{ content: `round ${i} a` }, { content: 'b' }]);
      // Every round gets a fresh interjection, so pendingSteering never clears.
      MID_STREAM.push(async () => {
        const nodes = await getPrisma().node.findMany({
          where: { conversationId: 'c-r', role: 'asst' },
          select: { id: true },
        });
        await insertInterjection({
          id: `ij-loop-${i}`,
          conversation_id: 'c-r',
          node_id: nodes[0]!.id,
          text: `steer ${i}`,
        });
      });
    }

    const events = await drain(
      runAgent({ conversationId: 'c-r', parent: null, content: 'go' }),
    );
    expect(STREAM_CALLS.length).toBeLessThanOrEqual(config.maxToolRounds);
    expect(events.map((e) => e.kind)).toContain('node.finalized');
  });

  /**
   * The interjection is consumed *after* the round, so a turn that never gets
   * another round must leave it pending rather than silently dropping it.
   */
  it('leaves an interjection pending when no further round runs', async () => {
    CHAT_SCRIPTS.push([{ content: 'single round, done' }]);
    const events = await drain(
      runAgent({ conversationId: 'c-r', parent: null, content: 'hi' }),
    );
    const asstId = (
      events.find(
        (e) => e.kind === 'node.created' && e.node.role === 'asst',
      ) as { node: { id: string } }
    ).node.id;

    // Arrives after the only round finished.
    await insertInterjection({
      id: 'ij-late',
      conversation_id: 'c-r',
      node_id: asstId,
      text: 'too late for this turn',
    });
    expect(await peekInterjections(asstId)).toHaveLength(1);
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
    // runAgent creates the user node + active_leaf.changed before delegating,
    // so the error follows those two. The point: no model call was issued.
    const kinds = events.map((e) => e.kind);
    expect(kinds[0]).toBe('node.created');
    expect(kinds[1]).toBe('active_leaf.changed');
    const err = events.find((e) => e.kind === 'error');
    expect(err).toBeDefined();
    expect((err as { recoverable: boolean }).recoverable).toBe(false);
    expect(STREAM_CALLS).toHaveLength(0);
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
    const contentText = events
      .filter(
        (e): e is Extract<BusEvent, { kind: 'content.delta' }> =>
          e.kind === 'content.delta',
      )
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
