import { END, START, StateGraph } from '@langchain/langgraph';
import { getCheckpointer } from './checkpointer.js';
import {
  afterCallModel,
  afterExecute,
  afterGate,
  afterPrepare,
  afterResolve,
  callModelNode,
  executeNode,
  finalizeNode,
  gateNode,
  prepareNode,
  resolvePromptNode,
  waitNode,
} from './nodes.js';
import { TurnState } from './state.js';

/**
 * The turn graph.
 *
 *              ┌── steering ──┐
 *              ▼              │
 *   prepare ─▶ callModel ─▶ gate ─▶ wait ─▶ resolvePrompt ─▶ execute
 *                  ▲          │                    │            │
 *                  │          └── auto-approved ───┴────────────┤
 *                  └──────────── next round ────────────────────┘
 *                                    │
 *                                 finalize ─▶ END
 *
 * `gate` and `wait` are separate nodes on purpose: `wait` is the only node
 * that re-executes on resume, so all side effects live in `gate`. See
 * `nodes.ts` for the full set of rules this shape encodes.
 *
 * `callModel` also loops back to itself when a mid-turn interjection arrived
 * during the round. An aborted round is indistinguishable from a finished one
 * by tool calls alone, so that self-edge is what stops a steered turn from
 * finalizing without ever applying the steering. `config.maxToolRounds` bounds
 * it — see `afterCallModel`.
 */
function build() {
  return new StateGraph(TurnState)
    .addNode('prepare', prepareNode)
    .addNode('callModel', callModelNode)
    .addNode('gate', gateNode)
    .addNode('wait', waitNode)
    .addNode('resolvePrompt', resolvePromptNode)
    .addNode('execute', executeNode)
    .addNode('finalize', finalizeNode)
    .addEdge(START, 'prepare')
    .addConditionalEdges('prepare', afterPrepare, ['callModel', 'finalize'])
    .addConditionalEdges('callModel', afterCallModel, [
      'gate',
      'callModel',
      'finalize',
    ])
    .addConditionalEdges('gate', afterGate, ['wait', 'execute', 'callModel'])
    .addEdge('wait', 'resolvePrompt')
    .addConditionalEdges('resolvePrompt', afterResolve, [
      'execute',
      'gate',
      'callModel',
    ])
    .addConditionalEdges('execute', afterExecute, ['gate', 'callModel'])
    .addEdge('finalize', END);
}

type CompiledTurnGraph = ReturnType<ReturnType<typeof build>['compile']>;

let compiled: CompiledTurnGraph | null = null;

/**
 * The compiled graph, built once. Sharing one instance across turns is safe —
 * per-turn state lives in the checkpointer keyed by `thread_id`, not on the
 * graph — and `@langchain/langgraph` ≥1.4.4 is required because earlier
 * versions leaked ambient `configurable` between concurrent invocations of a
 * shared compiled graph.
 */
export function getTurnGraph(): CompiledTurnGraph {
  compiled ??= build().compile({ checkpointer: getCheckpointer() });
  return compiled;
}

/**
 * Config for one turn. `thread_id` is the assistant node id, so a decision
 * arriving later only needs that id to find the paused turn.
 *
 * `durability: 'sync'` is not optional: the default `'async'` may lose a
 * checkpoint if the process dies mid-execution, which is the exact failure
 * this whole change exists to eliminate.
 */
export function turnConfig(asstNodeId: string) {
  return {
    configurable: { thread_id: asstNodeId },
    durability: 'sync' as const,
    streamMode: ['custom', 'values'] as const,
  };
}

/**
 * Ids of the interrupts a turn is currently blocked on, empty if it is not
 * paused (or was never started).
 *
 * This replaces `pendingCount()` on the old in-memory coordinators, and unlike
 * that function it answers truthfully after a restart — the answer comes from
 * Postgres, not from a `Map` that died with the process. Endpoints use it to
 * tell "the turn is waiting for this decision" apart from "there is nothing to
 * resume", and boot recovery uses it to classify stranded turns.
 */
export async function getPendingInterrupts(asstNodeId: string): Promise<string[]> {
  const snapshot = await getTurnGraph().getState({
    configurable: { thread_id: asstNodeId },
  });
  return snapshot.tasks
    .flatMap((t) => t.interrupts)
    .map((i) => i.id)
    .filter((id): id is string => id !== undefined);
}

/** True when the thread has a checkpoint with work still to do. */
export async function hasUnfinishedWork(asstNodeId: string): Promise<boolean> {
  const snapshot = await getTurnGraph().getState({
    configurable: { thread_id: asstNodeId },
  });
  return snapshot.next.length > 0;
}
