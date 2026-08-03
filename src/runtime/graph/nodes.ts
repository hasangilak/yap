import { randomUUID } from 'node:crypto';
import { interrupt, type LangGraphRunnableConfig } from '@langchain/langgraph';
import { config } from '../../config.js';
import {
  getAgentPermission,
  getAgentRaw,
  getConversationRaw,
  consumeInterjections,
  hasGrant,
  isCancelRequested,
  insertGrant,
  insertNode,
  insertPrompt,
  peekInterjections,
  recordArtifactWrite,
  recordPromptResponse,
  updateConversationPointers,
  updateNode,
  walkChain,
} from '../../db/queries.js';
import {
  executeTool,
  filterEnabledToolIds,
  isSideEffectful,
  TOOL_DEFS,
} from '../../registry/tools.js';
import type {
  ApprovalData,
  ClarifyData,
  PromptResponse,
  ToolCallData,
} from '../../schemas/index.js';
import { DEFAULT_SYSTEM_PROMPT } from '../../system-prompt.js';
import { envelope, makeEmit } from './emit.js';
import { streamModelRound } from './model.js';
import type { NormalizedToolCall, OpenPrompt, TurnStateValue } from './state.js';
import { clearAbortController, takeAbortController } from './steering.js';

/**
 * The turn graph's nodes.
 *
 * The shape here is dictated by one LangGraph rule: **a node containing
 * `interrupt()` re-executes from the top when the graph resumes.** So every
 * pause is split across two nodes — `gate` performs the side effects (persist
 * the approval row, emit the request event) and `wait` contains nothing but
 * the `interrupt()` call. The checkpoint written between them is what makes a
 * decision survive a restart.
 *
 * Two related rules are load-bearing:
 *  - `interrupt()` propagates by throwing `GraphInterrupt`, so `wait` must
 *    never sit inside a `try/catch`. Note the old loop wrapped an entire
 *    round in one `try/catch` that turned any throw into an `error` event;
 *    replicating that here would silently convert every pause into a failure.
 *  - Interrupts must not be called in a loop over a dynamic list. Tool calls
 *    are therefore gated **one per `gate`/`wait` pass**, with a conditional
 *    edge looping back for the next one.
 */

// -- permission model (moved verbatim from the old run.ts) --------------------

/**
 * Three-layer model: session grant → agent `permission_default` → tool-level
 * `auto` flag.
 */
async function isAutoApproved(agentId: string, toolName: string): Promise<boolean> {
  if (await hasGrant(agentId, toolName)) return true;
  const perm = await getAgentPermission(agentId);
  if (perm === 'auto_allow_all') return true;
  if (isSideEffectful(toolName)) return false;
  if (perm === 'auto_allow_read') return true;
  const toolDef = TOOL_DEFS.find((t) => t.id === toolName);
  return toolDef?.auto === true;
}

function approvalPayloadFor(
  toolName: string,
  args: Record<string, unknown>,
): ApprovalData {
  const toolDef = TOOL_DEFS.find((t) => t.id === toolName);
  const desc = toolDef?.desc ?? toolName;
  const compact = JSON.stringify(args);
  const preview = compact.length > 200 ? `${compact.slice(0, 197)}...` : compact;
  return { tool: toolName, title: `Run ${toolName}`, body: desc, preview };
}

function clarifyDataFrom(args: Record<string, unknown>): ClarifyData {
  const chipsRaw = Array.isArray(args.chips) ? (args.chips as unknown[]) : [];
  return {
    question: String(args.question ?? 'Could you clarify?'),
    chips: chipsRaw.map((label, i) => ({ id: `c-${i}`, label: String(label) })),
    input: String(args.input_hint ?? ''),
  };
}

function isSelectedExecutableTool(
  state: TurnStateValue,
  toolName: string,
): boolean {
  return (
    (toolName === 'web_search' || (state.toolIds ?? []).includes(toolName)) &&
    filterEnabledToolIds([toolName]).length === 1
  );
}

function expandAgentVariables(
  prompt: string,
  value: unknown,
): string {
  if (!Array.isArray(value)) return prompt;
  return value.reduce((expanded, variable) => {
    if (
      !variable ||
      typeof variable !== 'object' ||
      !('name' in variable) ||
      typeof variable.name !== 'string'
    ) {
      return expanded;
    }
    const replacement =
      'default' in variable && typeof variable.default === 'string'
        ? variable.default
        : '';
    return expanded.split(`{{${variable.name}}}`).join(replacement);
  }, prompt);
}

// -- prepare -----------------------------------------------------------------

/**
 * Load the conversation and agent, create the assistant node, and seed the
 * message history. The assistant node id arrives in the initial state because
 * it doubles as the graph's `thread_id`, so the façade mints it first.
 */
export async function prepareNode(
  state: TurnStateValue,
  cfg: LangGraphRunnableConfig,
) {
  const emit = makeEmit(cfg);
  const { conversationId, asstNodeId, parentUserNodeId, branch } = state;

  const conv = await getConversationRaw(conversationId);
  if (!conv) {
    emit({
      kind: 'error',
      ...envelope(conversationId),
      message: `conversation ${conversationId} not found`,
      recoverable: false,
    });
    return { done: true };
  }

  // Hard-stop before spending anything if the budget is already gone.
  if (conv.tokensUsed >= conv.tokenBudget) {
    emit({
      kind: 'error',
      ...envelope(conversationId),
      message: `token budget exhausted (${conv.tokensUsed} / ${conv.tokenBudget})`,
      recoverable: false,
    });
    return { done: true };
  }

  const agent = await getAgentRaw(conv.agentId);
  const model = agent?.model ?? config.defaultModel;
  const systemPromptTemplate =
    agent?.systemPrompt && agent.systemPrompt.trim()
      ? agent.systemPrompt
      : DEFAULT_SYSTEM_PROMPT;
  const systemPrompt = expandAgentVariables(
    systemPromptTemplate,
    agent?.variables,
  );

  const asstNode = await insertNode({
    id: asstNodeId,
    conversation_id: conversationId,
    parent_id: parentUserNodeId,
    role: 'asst',
    branch,
    streaming: true,
    status: 'thinking',
  });
  emit({ kind: 'node.created', ...envelope(conversationId), node: asstNode });
  emit({
    kind: 'status.update',
    ...envelope(conversationId),
    node_id: asstNodeId,
    state: 'thinking',
    elapsed_ms: 0,
  });

  // Cross-turn history is flattened to role+content only — prior tool calls
  // and reasoning are deliberately not replayed into the model.
  const chain = await walkChain(conversationId, parentUserNodeId);
  const messages = [
    { role: 'system' as const, content: systemPrompt },
    ...chain.map((m) => ({
      role: (m.role === 'asst' ? 'assistant' : 'user') as 'assistant' | 'user',
      content: m.content,
    })),
  ];

  return {
    agentId: conv.agentId,
    model,
    temperature: agent?.temperature ?? 0.5,
    topP: agent?.topP ?? 1,
    maxTokens: agent?.maxTokens ?? 4096,
    toolIds: Array.isArray(agent?.toolIds)
      ? agent.toolIds.filter((id): id is string => typeof id === 'string')
      : [],
    messages,
    done: false,
  };
}

// -- callModel ---------------------------------------------------------------

/** One model round: stream text, split reasoning, collect tool calls. */
export async function callModelNode(
  state: TurnStateValue,
  cfg: LangGraphRunnableConfig,
) {
  const emit = makeEmit(cfg);
  const { conversationId, asstNodeId, runStartedAt } = state;

  // Any text the user pushed in mid-turn goes in before this round runs.
  // Peeked, not drained: these are only marked consumed once the round below
  // has finished streaming, so a crash mid-round re-injects rather than
  // silently swallowing what the user typed.
  const pending = await peekInterjections(asstNodeId);
  const injected = pending.map((row) => ({
    role: 'user' as const,
    content: row.text,
  }));

  const ac = takeAbortController(asstNodeId);
  const result = await streamModelRound({
    model: state.model,
    temperature: state.temperature ?? 0.5,
    topP: state.topP ?? 1,
    maxTokens: state.maxTokens ?? 4096,
    toolIds: state.toolIds ?? [],
    messages: [...state.messages, ...injected],
    signal: ac.signal,
    onSegment: (seg) => {
      if (seg.type === 'content') {
        emit({
          kind: 'content.delta',
          ...envelope(conversationId),
          node_id: asstNodeId,
          delta: seg.text,
        });
        emit({
          kind: 'status.update',
          ...envelope(conversationId),
          node_id: asstNodeId,
          state: 'streaming',
          elapsed_ms: Date.now() - runStartedAt,
        });
      } else if (seg.type === 'reasoning') {
        emit({
          kind: 'reasoning.delta',
          ...envelope(conversationId),
          node_id: asstNodeId,
          step_index: seg.step_index,
          delta: seg.text,
        });
      }
      // `reasoning.step.end` needs the assembled text, which the model
      // module tracks; emitted below once the round settles.
    },
  });

  // The round is over: drop the controller so nothing can later "abort" a call
  // that already finished. Leaving it behind made `POST /cancel` report
  // `aborted: true` for a turn parked on a prompt, which in turn skipped the
  // branch that finalizes a parked node — stranding it as `streaming` forever.
  clearAbortController(asstNodeId);

  // The round is over, so the steering text it carried has been delivered.
  // Deliberately after `streamModelRound`, not before it.
  await consumeInterjections(pending.map((row) => row.id));

  // Re-read: anything that arrived *during* the round is still pending, which
  // includes the interjection that aborted this round in the first place (it was
  // inserted after the peek above). The flag is what keeps the loop going —
  // an aborted round has no tool calls, so without it the turn would finalize
  // having accepted the user's steering and never used it.
  const stillPending = await peekInterjections(asstNodeId);

  // The cancel arrives on a different request than the one running this turn,
  // so the node row is the only channel the two share.
  const cancelled = await isCancelRequested(asstNodeId);

  for (const [i, text] of result.reasoningSteps.entries()) {
    emit({
      kind: 'reasoning.step.end',
      ...envelope(conversationId),
      node_id: asstNodeId,
      step_index: i,
      final_text: text,
    });
  }

  const accumulatedContent = state.accumulatedContent + result.roundContent;

  // Per-round token estimate. The old loop recomputed this from the whole
  // accumulated string each round, which double-counted; this charges only
  // what the round actually produced.
  const roundChars =
    result.roundContent.length +
    result.reasoningSteps.reduce((s, r) => s + r.length, 0);
  const roundTokens = (roundChars / 4) | 0;
  if (roundTokens > 0) {
    const { getPrisma } = await import('../../db/index.js');
    await getPrisma().conversation.update({
      where: { id: conversationId },
      data: { tokensUsed: { increment: roundTokens } },
    });
    await updateConversationPointers(conversationId, { updated_at: new Date() });
  }

  await updateNode(asstNodeId, {
    content: accumulatedContent,
    ...(result.reasoningSteps.length > 0
      ? { reasoning: [...state.reasoningSteps, ...result.reasoningSteps] }
      : {}),
  });

  // A deadline abort ends the turn, matching the old behavior. An external
  // abort is a steering interject: keep the partial text and loop.
  if (result.abortedBy === 'deadline') {
    emit({
      kind: 'error',
      ...envelope(conversationId),
      message: `model round exceeded ${config.toolDeadlineMs}ms`,
      node_id: asstNodeId,
      recoverable: false,
    });
    return { accumulatedContent, reasoningSteps: result.reasoningSteps, done: true };
  }

  const assistantMessage = {
    role: 'assistant' as const,
    content: result.roundContent,
    ...(result.toolCalls.length > 0 ? { tool_calls: result.toolCalls } : {}),
  };

  return {
    accumulatedContent,
    reasoningSteps: result.reasoningSteps,
    messages: [...injected, assistantMessage],
    pendingToolCalls: result.toolCalls,
    pendingSteering: stillPending.length > 0,
    cancelRequested: cancelled,
    round: state.round + 1,
    done: false,
  };
}

// -- gate --------------------------------------------------------------------

/**
 * Decide whether the next pending tool call needs a human, and if so persist
 * the row and announce it. **Side effects only** — the actual pause is the
 * separate `wait` node, so nothing here is re-run on resume.
 */
export async function gateNode(
  state: TurnStateValue,
  cfg: LangGraphRunnableConfig,
) {
  const emit = makeEmit(cfg);
  const { conversationId, asstNodeId, runStartedAt } = state;
  const call = state.pendingToolCalls[0];
  if (!call) return { openPrompts: [], pendingApproved: false };

  // `ask_clarification` is not an executable tool — it is a pause mechanic.
  if (call.name === 'ask_clarification') {
    const promptId = `pr-${randomUUID().slice(0, 8)}`;
    const clarifyData = clarifyDataFrom(call.args);
    await insertPrompt({
      id: promptId,
      conversation_id: conversationId,
      node_id: asstNodeId,
      thread_id: asstNodeId,
      kind: 'clarify',
      tool: call.name,
      payload: { prompt_kind: 'clarify', clarify: clarifyData },
    });
    await updateNode(asstNodeId, { status: 'approval' });
    emit({
      kind: 'prompt.requested',
      ...envelope(conversationId),
      node_id: asstNodeId,
      prompt_id: promptId,
      tool: call.name,
      request: { prompt_kind: 'clarify', clarify: clarifyData },
    });
    emit({
      kind: 'status.update',
      ...envelope(conversationId),
      node_id: asstNodeId,
      state: 'approval',
      elapsed_ms: Date.now() - runStartedAt,
    });
    const prompt: OpenPrompt = {
      id: promptId,
      kind: 'clarify',
      toolCallIndex: 0,
      tool: call.name,
    };
    return { openPrompts: [prompt], pendingApproved: false };
  }

  const proposedCall: ToolCallData = {
    name: call.name,
    args: call.args,
    status: 'pending',
  };
  emit({
    kind: 'toolcall.proposed',
    ...envelope(conversationId),
    node_id: asstNodeId,
    tool_call: proposedCall,
  });

  // Binding tools is the primary provider-side boundary. Keep a second
  // server-side check because an unexpected/hallucinated tool call must not
  // gain authority merely by reaching this node.
  if (!isSelectedExecutableTool(state, call.name)) {
    return { openPrompts: [], pendingApproved: true };
  }

  if (await isAutoApproved(state.agentId, call.name)) {
    return { openPrompts: [], pendingApproved: true };
  }

  const promptId = `pr-${randomUUID().slice(0, 8)}`;
  const payload = approvalPayloadFor(call.name, call.args);
  await insertPrompt({
    id: promptId,
    conversation_id: conversationId,
    node_id: asstNodeId,
    thread_id: asstNodeId,
    kind: 'approval',
    tool: call.name,
    payload: { prompt_kind: 'approval', approval: payload },
  });
  await updateNode(asstNodeId, { status: 'approval' });
  emit({
    kind: 'prompt.requested',
    ...envelope(conversationId),
    node_id: asstNodeId,
    prompt_id: promptId,
    tool: call.name,
    request: { prompt_kind: 'approval', approval: payload },
  });
  emit({
    kind: 'status.update',
    ...envelope(conversationId),
    node_id: asstNodeId,
    state: 'approval',
    elapsed_ms: Date.now() - runStartedAt,
  });

  const prompt: OpenPrompt = {
    id: promptId,
    kind: 'approval',
    toolCallIndex: 0,
    tool: call.name,
  };
  return { openPrompts: [prompt], pendingApproved: false };
}

// -- wait --------------------------------------------------------------------

/**
 * The pause. Contains **only** `interrupt()` — no try/catch, no side effects,
 * exactly one call per invocation. Everything about durable human-in-the-loop
 * rests on this node staying this small.
 */
export async function waitNode(state: TurnStateValue) {
  const prompt = state.openPrompts[0];
  const answer = interrupt({
    prompt_id: prompt?.id,
    kind: prompt?.kind,
    tool: prompt?.tool,
  });
  return { promptResponses: { [prompt?.id ?? 'unknown']: answer } };
}

// -- resolvePrompt -----------------------------------------------------------

/**
 * Apply the human's answer: announce it, and decide whether the gated call
 * runs. Sets `pendingApproved` for the conditional edge rather than returning
 * a route, so the decision survives the checkpoint.
 *
 * The response arrives already tagged (`PromptResponse`), so this node narrows
 * on the answer itself rather than trusting `prompt.kind` to agree with it.
 *
 * The row is **not** written here — `POST /prompts/:id/respond` persists the
 * response before resuming, which is what makes an answer survive a crash in
 * between. Writing it again here would only move `responded_at`.
 */
export async function resolvePromptNode(
  state: TurnStateValue,
  cfg: LangGraphRunnableConfig,
) {
  const emit = makeEmit(cfg);
  const { conversationId, asstNodeId } = state;
  const prompt = state.openPrompts[0];
  const call = state.pendingToolCalls[0];
  if (!prompt || !call) return { openPrompts: [], pendingApproved: false };

  const response = state.promptResponses[prompt.id] as PromptResponse | undefined;
  if (!response) return { openPrompts: [], pendingApproved: false };

  emit({
    kind: 'prompt.responded',
    ...envelope(conversationId),
    node_id: asstNodeId,
    prompt_id: prompt.id,
    tool: prompt.tool,
    response,
  });

  if (response.prompt_kind === 'clarify') {
    const { answer } = response;
    const clarifyData = clarifyDataFrom(call.args);
    const picked = clarifyData.chips
      .filter((c) => answer.selected_chip_ids.includes(c.id))
      .map((c) => c.label);
    const summary = [
      picked.length ? `Selected: ${picked.join(', ')}.` : 'No chips selected.',
      answer.text ? `Free-form: ${answer.text}` : 'No free-form text.',
    ].join(' ');

    await updateNode(asstNodeId, { status: null });
    const { getPrisma } = await import('../../db/index.js');
    await getPrisma().node.update({
      where: { id: asstNodeId },
      data: {
        clarify: {
          ...clarifyData,
          chips: clarifyData.chips.map((c) => ({
            ...c,
            selected: answer.selected_chip_ids.includes(c.id),
          })),
        } as never,
      },
    });

    return {
      messages: [{ role: 'tool' as const, content: summary }],
      pendingToolCalls: state.pendingToolCalls.slice(1),
      openPrompts: [],
      pendingApproved: false,
    };
  }

  const { decision } = response;
  if (decision === 'always') await insertGrant(state.agentId, prompt.tool);

  if (decision === 'deny') {
    const deniedCall: ToolCallData = {
      name: call.name,
      args: call.args,
      status: 'err',
      elapsed: '0.0s',
    };
    await updateNode(asstNodeId, { tool_call: deniedCall, status: null });
    emit({
      kind: 'toolcall.ended',
      ...envelope(conversationId),
      node_id: asstNodeId,
      status: 'err',
      elapsed_ms: 0,
      error: 'Denied by user',
    });
    return {
      messages: [
        {
          role: 'tool' as const,
          content: `The user denied the ${call.name} call. Continue without it.`,
        },
      ],
      pendingToolCalls: state.pendingToolCalls.slice(1),
      openPrompts: [],
      pendingApproved: false,
      resolvedToolCalls: [deniedCall],
    };
  }

  await updateNode(asstNodeId, { status: null });

  // Edit-then-approve: swap the proposed args for the human's before the call
  // reaches `execute`. Nothing about safety rests on this substitution —
  // `executeTool` validates at execution time, so `write_file`'s sandbox check
  // applies to edited args exactly as it does to model-proposed ones.
  //
  // Note the in-turn `messages` history keeps the assistant's *original*
  // tool_calls. That is deliberate: the history records what the model said,
  // while the node row, `toolcall.started`, and `prompt.responded` all carry
  // what actually ran.
  if (response.edited_args) {
    const edited: NormalizedToolCall = { ...call, args: response.edited_args };
    return {
      pendingToolCalls: [edited, ...state.pendingToolCalls.slice(1)],
      openPrompts: [],
      pendingApproved: true,
    };
  }

  return { openPrompts: [], pendingApproved: true };
}

// -- execute -----------------------------------------------------------------

/** Run the gated tool call and record its result. */
export async function executeNode(
  state: TurnStateValue,
  cfg: LangGraphRunnableConfig,
) {
  const emit = makeEmit(cfg);
  const { conversationId, asstNodeId, runStartedAt } = state;
  const call = state.pendingToolCalls[0];
  if (!call) return { pendingApproved: false };

  await updateNode(asstNodeId, { status: null });
  emit({
    kind: 'toolcall.started',
    ...envelope(conversationId),
    node_id: asstNodeId,
    tool: call.name,
    args: call.args,
  });
  emit({
    kind: 'status.update',
    ...envelope(conversationId),
    node_id: asstNodeId,
    state: 'tool',
    elapsed_ms: Date.now() - runStartedAt,
    tool: call.name,
  });

  const exec = isSelectedExecutableTool(state, call.name)
    ? await executeTool(call.name, call.args)
    : {
        status: 'err' as const,
        elapsed_ms: 0,
        error: `tool '${call.name}' is unavailable or not enabled for this agent`,
      };
  const status = exec.status === 'ok' ? 'ok' : 'err';
  const finalized: ToolCallData = {
    name: call.name,
    args: call.args,
    status,
    elapsed: `${(exec.elapsed_ms / 1000).toFixed(1)}s`,
    ...(exec.result ? { result: exec.result } : {}),
  };
  await updateNode(asstNodeId, { tool_call: finalized });
  emit({
    kind: 'toolcall.ended',
    ...envelope(conversationId),
    node_id: asstNodeId,
    status,
    elapsed_ms: exec.elapsed_ms,
    ...(exec.result !== undefined ? { result: exec.result } : {}),
    ...(exec.error !== undefined ? { error: exec.error } : {}),
  });

  // write_file promotes to a versioned artifact. Recompute from args so we
  // never depend on the tool's result string carrying the bytes.
  if (
    call.name === 'write_file' &&
    status === 'ok' &&
    typeof call.args.path === 'string' &&
    typeof call.args.content === 'string'
  ) {
    try {
      const { artifact, version } = await recordArtifactWrite({
        conversation_id: conversationId,
        title: call.args.path,
        content: call.args.content,
        author: 'asst',
        produced_by_node_id: asstNodeId,
        message: `Written by ${call.name}`,
      });
      emit({
        kind: 'artifact.updated',
        ...envelope(conversationId),
        artifact_id: artifact.id,
        version_id: version.id,
        version: version.version,
        title: artifact.title,
      });
    } catch (err) {
      // Artifact bookkeeping must not kill the turn.
      console.error('[artifact]', err);
    }
  }

  return {
    messages: [
      { role: 'tool' as const, content: exec.result ?? exec.error ?? '' },
    ],
    pendingToolCalls: state.pendingToolCalls.slice(1),
    resolvedToolCalls: [finalized],
    pendingApproved: false,
  };
}

// -- finalize ----------------------------------------------------------------

/** Close out the turn: clear streaming state and move the active leaf. */
export async function finalizeNode(
  state: TurnStateValue,
  cfg: LangGraphRunnableConfig,
) {
  const emit = makeEmit(cfg);
  const { conversationId, asstNodeId } = state;

  const finalized = await updateNode(asstNodeId, {
    streaming: false,
    status: null,
  });
  await updateConversationPointers(conversationId, {
    active_leaf_id: asstNodeId,
    snippet: state.accumulatedContent.slice(0, 80),
    updated_at: new Date(),
  });
  if (finalized) {
    emit({
      kind: 'node.finalized',
      ...envelope(conversationId),
      node_id: asstNodeId,
      node: finalized,
    });
  }
  emit({
    kind: 'active_leaf.changed',
    ...envelope(conversationId),
    active_leaf_id: asstNodeId,
  });
  return { done: true };
}

// -- routing -----------------------------------------------------------------

export function afterPrepare(state: TurnStateValue): 'callModel' | 'finalize' {
  return state.done ? 'finalize' : 'callModel';
}

/**
 * The round budget is checked **first** so it bounds both continuation paths.
 * Tool calls loop through `gate`; steering loops straight back to `callModel`,
 * and that self-loop needs the same ceiling or a user could keep a turn alive
 * indefinitely by interjecting.
 */
export function afterCallModel(
  state: TurnStateValue,
): 'gate' | 'callModel' | 'finalize' {
  if (state.done) return 'finalize';
  // A cancel outranks every continuation path — including a tool call the model
  // just proposed. Stopping means stopping, not "after one more tool".
  if (state.cancelRequested) return 'finalize';
  if (state.round >= config.maxToolRounds) return 'finalize';
  if (state.pendingToolCalls.length > 0) return 'gate';
  // No tool calls, but the user steered mid-round. An aborted round looks
  // exactly like a finished one from here, so without this the turn would end
  // having accepted the steering and never applied it.
  if (state.pendingSteering) return 'callModel';
  return 'finalize';
}

export function afterGate(state: TurnStateValue): 'wait' | 'execute' | 'callModel' {
  if (state.openPrompts.length > 0) return 'wait';
  if (state.pendingApproved) return 'execute';
  return 'callModel';
}

export function afterResolve(
  state: TurnStateValue,
): 'execute' | 'gate' | 'callModel' {
  if (state.pendingApproved) return 'execute';
  return state.pendingToolCalls.length > 0 ? 'gate' : 'callModel';
}

export function afterExecute(state: TurnStateValue): 'gate' | 'callModel' {
  return state.pendingToolCalls.length > 0 ? 'gate' : 'callModel';
}

export type { NormalizedToolCall };
