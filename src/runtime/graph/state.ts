import { ReducedValue, StateSchema } from '@langchain/langgraph';
import { z } from 'zod';
import { ToolCallDataSchema } from '../../schemas/node.js';

/**
 * Graph state for one assistant turn.
 *
 * Everything here is checkpointed to Postgres between supersteps, so it must
 * be **plain JSON** — no class instances, no `BaseMessage`. That is why the
 * turn keeps its own message shape and converts to LangChain input at call
 * time in `model.ts`: it keeps the checkpoint readable and avoids depending
 * on LangChain's serde for our own durability guarantee.
 *
 * This replaces the closure variables the old loop mutated in `run.ts`
 * (`accumulated`, `roundContent`, `reasoningBuffer`, `reasoningSteps`,
 * `history`) — those died with the process, which is exactly why a restart
 * stranded a paused turn.
 */

/** A tool call after normalization away from provider-specific shapes. */
export const NormalizedToolCallSchema = z.object({
  /** Provider-assigned id when present; used to correlate tool results. */
  id: z.string().optional(),
  name: z.string(),
  args: z.record(z.string(), z.unknown()),
});
export type NormalizedToolCall = z.infer<typeof NormalizedToolCallSchema>;

/**
 * A message in the turn's own history. Mirrors what Ollama expects on the
 * wire (`role` + `content`, plus `tool_calls` on assistant turns) rather than
 * LangChain's class hierarchy.
 */
export const TurnMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
  tool_calls: z.array(NormalizedToolCallSchema).optional(),
});
export type TurnMessage = z.infer<typeof TurnMessageSchema>;

/**
 * A pause awaiting a human. `interruptId` is filled in once LangGraph hands
 * us one, so a response can be routed back to the right interrupt when
 * several are open at once.
 */
export const OpenPromptSchema = z.object({
  id: z.string(),
  kind: z.enum(['approval', 'clarify']),
  /** Index into `pendingToolCalls` this prompt gates. */
  toolCallIndex: z.number().int().nonnegative(),
  tool: z.string(),
  interruptId: z.string().optional(),
});
export type OpenPrompt = z.infer<typeof OpenPromptSchema>;

/** Append reducer — used only for genuinely additive channels. */
function appendAll<T>(current: T[], next: T[]): T[] {
  return [...current, ...next];
}

export const TurnState = new StateSchema({
  // -- identity, set once by `prepare` and never reduced --
  conversationId: z.string(),
  agentId: z.string(),
  asstNodeId: z.string(),
  parentUserNodeId: z.string(),
  branch: z.string(),
  model: z.string(),
  /** Agent sampling/tool configuration captured when the turn starts. */
  temperature: z.number().optional(),
  topP: z.number().optional(),
  maxTokens: z.number().int().positive().optional(),
  toolIds: z.array(z.string()).optional(),
  /** Wall-clock start, so `elapsed_ms` on status events survives a resume. */
  runStartedAt: z.number().int(),

  // -- loop bookkeeping --
  round: z.number().int(),

  /**
   * The model conversation. Append-only: a node returns just the messages it
   * added. Safe because the only node that re-executes on resume is `wait`,
   * which contributes no messages.
   */
  messages: new ReducedValue(z.array(TurnMessageSchema), {
    inputSchema: z.array(TurnMessageSchema),
    reducer: appendAll<TurnMessage>,
  }),

  /**
   * Full assistant text so far. Overwritten rather than appended — the node
   * returns `state.accumulatedContent + roundText`, which stays correct even
   * if the node runs twice.
   */
  accumulatedContent: z.string(),

  reasoningSteps: new ReducedValue(z.array(z.string()), {
    inputSchema: z.array(z.string()),
    reducer: appendAll<string>,
  }),

  // -- tool round state, replaced wholesale each round --
  pendingToolCalls: z.array(NormalizedToolCallSchema),
  openPrompts: z.array(OpenPromptSchema),
  /** Answers keyed by prompt id, gathered as prompts are responded to. */
  promptResponses: z.record(z.string(), z.unknown()),

  resolvedToolCalls: new ReducedValue(z.array(ToolCallDataSchema), {
    inputSchema: z.array(ToolCallDataSchema),
    reducer: appendAll<z.infer<typeof ToolCallDataSchema>>,
  }),

  /**
   * Set by `resolvePrompt` to tell the conditional edge whether the gated
   * tool call should now run. A state field rather than a return value
   * because LangGraph routes on state, and it must survive the checkpoint
   * written between the pause and the resume.
   */
  pendingApproved: z.boolean(),

  /**
   * True when interjected text is waiting that this round did not consume —
   * either it arrived mid-round (and aborted the model call) or it landed after
   * the round's initial read.
   *
   * Without this the loop finalizes as soon as a round produces no tool calls,
   * which is exactly what an aborted round looks like. The turn would end
   * having accepted the user's steering and never applied it.
   */
  pendingSteering: z.boolean(),

  /**
   * True when the user asked this turn to stop (`POST /:id/cancel`).
   *
   * Read from the node row after each round rather than pushed in, because the
   * cancel arrives on a different request than the one running the turn — the
   * DB is the only channel both sides share.
   */
  cancelRequested: z.boolean(),

  /** Set when the loop should stop before the round budget is spent. */
  done: z.boolean(),
});

export type TurnStateValue = typeof TurnState.State;
export type TurnStateUpdate = typeof TurnState.Update;
