import { randomUUID } from 'node:crypto';
import { Command } from '@langchain/langgraph';
import {
  getConversationRaw,
  insertNode,
  updateConversationPointers,
  walkChain,
} from '../db/queries.js';
import { envelope } from './graph/emit.js';
import { getTurnGraph, turnConfig } from './graph/index.js';
import type { BusEvent } from '../events/types.js';
import type { MessageNode } from '../schemas/index.js';

/**
 * The turn runtime's public surface.
 *
 * These functions keep the signatures the API layer has always used, but the
 * loop behind them is now a LangGraph `StateGraph` (`./graph/`) checkpointed to
 * Postgres. The reason for the change: pauses for human input used to be
 * in-process promises, so a restart stranded the turn forever.
 *
 * **One semantic change callers must understand.** A LangGraph stream
 * terminates when a node calls `interrupt()`, so this generator now completes
 * when the turn *pauses* — not only when it finishes. "The generator ended"
 * therefore no longer means "the turn ended". The continuation is a separate
 * `resumeTurn()` call made by whichever endpoint receives the human's answer,
 * and it publishes its own events.
 *
 * Nothing downstream breaks because of this: `api/messages.ts` only waits for
 * the first `node.created`, and `api/stream.ts` follows the conversation on the
 * event bus rather than following a producer.
 */

function newNodeId(): string {
  return `n-${randomUUID().slice(0, 8)}`;
}

/**
 * Drain a graph stream, yielding the `BusEvent`s its nodes emitted on the
 * `custom` channel.
 *
 * The stream must always be drained: an unconsumed `IterableReadableStream`
 * applies backpressure and stalls the run. Errors escaping a node are turned
 * into a terminal `error` event so a failure reaches the client instead of
 * only the server log.
 */
async function* drive(
  conversationId: string,
  asstNodeId: string,
  input: unknown,
): AsyncGenerator<BusEvent, void, unknown> {
  const graph = getTurnGraph();
  const cfg = turnConfig(asstNodeId);
  try {
    const stream = await graph.stream(input as never, cfg as never);
    for await (const entry of stream as AsyncIterable<[string, unknown]>) {
      const [mode, chunk] = entry;
      if (mode === 'custom') yield chunk as BusEvent;
    }
  } catch (err) {
    yield {
      kind: 'error',
      ...envelope(conversationId),
      node_id: asstNodeId,
      message: err instanceof Error ? err.message : String(err),
      recoverable: false,
    };
  }
}

/**
 * Run a full turn triggered by a new user message: append the user node, then
 * generate the assistant reply.
 *
 * The user node is created here rather than inside the graph because
 * `api/messages.ts` must return it in the HTTP response, and because it is not
 * part of the assistant turn whose state the checkpointer owns.
 */
export async function* runAgent(input: {
  conversationId: string;
  parent: string | null;
  content: string;
}): AsyncGenerator<BusEvent, void, unknown> {
  const { conversationId, parent, content } = input;

  const conv = await getConversationRaw(conversationId);
  if (!conv) {
    yield {
      kind: 'error',
      ...envelope(conversationId),
      message: `conversation ${conversationId} not found`,
      recoverable: false,
    };
    return;
  }

  const parentChain = parent ? await walkChain(conversationId, parent) : [];
  const branch = parentChain[parentChain.length - 1]?.branch ?? 'main';
  const userId = newNodeId();
  const userNode: MessageNode = await insertNode({
    id: userId,
    conversation_id: conversationId,
    parent_id: parent,
    role: 'user',
    branch,
    content,
  });
  yield { kind: 'node.created', ...envelope(conversationId), node: userNode };

  await updateConversationPointers(conversationId, {
    active_leaf_id: userId,
    root_node_id: conv.rootNodeId ?? userId,
    snippet: content.slice(0, 80),
    updated_at: new Date(),
  });
  yield {
    kind: 'active_leaf.changed',
    ...envelope(conversationId),
    active_leaf_id: userId,
  };

  yield* runAssistantTurn({
    conversationId,
    parentUserNodeId: userId,
    branch,
  });
}

/**
 * Generate just the assistant reply under an existing user node. Used by
 * regenerate and edit-with-ripple.
 *
 * The assistant node id is minted here because it doubles as the graph's
 * `thread_id` — that is what lets a later decision find this exact paused turn
 * with nothing but an id read from a database row.
 */
export async function* runAssistantTurn(input: {
  conversationId: string;
  parentUserNodeId: string;
  branch: string;
}): AsyncGenerator<BusEvent, void, unknown> {
  const { conversationId, parentUserNodeId, branch } = input;
  const asstNodeId = newNodeId();

  const initialState = {
    conversationId,
    agentId: '',
    asstNodeId,
    parentUserNodeId,
    branch,
    model: '',
    temperature: 0.5,
    topP: 1,
    maxTokens: 4096,
    toolIds: [],
    runStartedAt: Date.now(),
    round: 0,
    messages: [],
    accumulatedContent: '',
    reasoningSteps: [],
    pendingToolCalls: [],
    openPrompts: [],
    promptResponses: {},
    resolvedToolCalls: [],
    pendingApproved: false,
    pendingSteering: false,
    cancelRequested: false,
    done: false,
  };

  yield* drive(conversationId, asstNodeId, initialState);
}

/**
 * Continue a paused turn once a human has answered.
 *
 * Called by the approval/clarify endpoints. Because the pause lives in the
 * checkpointer rather than in a promise, this works from any request, long
 * after the original one returned, and across a process restart.
 */
export async function* resumeTurn(input: {
  conversationId: string;
  asstNodeId: string;
  resume: unknown;
}): AsyncGenerator<BusEvent, void, unknown> {
  const { conversationId, asstNodeId, resume } = input;
  yield* drive(conversationId, asstNodeId, new Command({ resume }));
}

/**
 * Continue a turn that stopped without asking for anything — a crash between
 * supersteps rather than a pause.
 *
 * Distinct from `resumeTurn` because the input differs in kind: a paused turn
 * needs `Command({resume})` to satisfy the waiting `interrupt()`, whereas a
 * crashed one needs `null`, which replays from the last completed superstep.
 * Passing a resume value to a thread with no pending interrupt would be
 * meaningless.
 */
export async function* continueTurn(input: {
  conversationId: string;
  asstNodeId: string;
}): AsyncGenerator<BusEvent, void, unknown> {
  yield* drive(input.conversationId, input.asstNodeId, null);
}
