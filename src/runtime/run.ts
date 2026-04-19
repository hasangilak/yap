import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { Ollama, type Message as OllamaMessage } from 'ollama';
import { config } from '../config.js';
import { newEventId } from '../events/types.js';
import { executeTool, isSideEffectful, OLLAMA_TOOLS, TOOL_DEFS } from '../registry/tools.js';
import {
  getAgentPermission,
  getAgentRaw,
  getConversationRaw,
  hasGrant,
  insertApproval,
  insertClarify,
  insertGrant,
  insertNode,
  recordArtifactWrite,
  recordClarifyResponse,
  updateConversationPointers,
  updateNode,
  walkChain,
} from '../db/queries.js';
import { awaitDecision } from './approvals.js';
import { awaitAnswer } from './clarifications.js';
import { ThinkSplitter } from './think-splitter.js';
import { DEFAULT_SYSTEM_PROMPT } from '../system-prompt.js';
import type {
  ApprovalData,
  BusEvent,
  ClarifyData,
  MessageNode,
  ToolCallData,
} from '../schemas/index.js';

const ollama = new Ollama({ host: config.ollamaHost });

// Tiny façade so the clarify branch can write the node's embedded
// clarify JSON without widening updateNode's signature for a Phase 5a
// concern. This goes away once Phase 5a+ consolidates clarify storage.
async function getPrismaFacadeUpdateClarify(
  nodeId: string,
  clarify: ClarifyData,
): Promise<void> {
  const { getPrisma } = await import('../db/index.js');
  await getPrisma().node.update({
    where: { id: nodeId },
    data: { clarify: clarify as unknown as Prisma.InputJsonValue },
  });
}

function newNodeId(): string {
  return `n-${randomUUID().slice(0, 8)}`;
}

function envelope(conversation_id: string): { id: string; at: number; conversation_id: string } {
  return { id: newEventId(), at: Date.now(), conversation_id };
}

interface OllamaToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

/**
 * Approval decision under the three-layer model in docs/server-spec.md §6:
 * session grant → agent permission_default → agent-level tool auto flag.
 * Phase 2 pools agent-level auto into the global TOOL_DEFS.auto flag
 * because chat-box's Agent type has no per-tool overrides yet; Phase 4's
 * agent builder will split them.
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

function approvalPayloadFor(toolName: string, args: Record<string, unknown>): ApprovalData {
  const toolDef = TOOL_DEFS.find((t) => t.id === toolName);
  const desc = toolDef?.desc ?? toolName;
  const preview = (() => {
    const compact = JSON.stringify(args);
    return compact.length > 200 ? compact.slice(0, 197) + '...' : compact;
  })();
  return { tool: toolName, title: `Run ${toolName}`, body: desc, preview };
}

// -- public entry points -----------------------------------------------------

/**
 * Run one full assistant turn triggered by a user message. Inserts the
 * user node + placeholder assistant node, then runs the agent loop to
 * completion, yielding every BusEvent the SSE stream needs.
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
 * Generate just the assistant reply for an existing user node. Used by
 * regenerate (§3.4) and edit-with-ripple (§3.2): both cases already have
 * the user turn in place and need a fresh asst reply under it.
 */
export async function* runAssistantTurn(input: {
  conversationId: string;
  parentUserNodeId: string;
  branch: string;
}): AsyncGenerator<BusEvent, void, unknown> {
  const { conversationId, parentUserNodeId, branch } = input;

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

  const agent = await getAgentRaw(conv.agentId);
  const model = agent?.model ?? config.defaultModel;
  const systemPrompt = (agent?.systemPrompt && agent.systemPrompt.trim())
    ? agent.systemPrompt
    : DEFAULT_SYSTEM_PROMPT;

  const asstId = newNodeId();
  const asstNode = await insertNode({
    id: asstId,
    conversation_id: conversationId,
    parent_id: parentUserNodeId,
    role: 'asst',
    branch,
    streaming: true,
    status: 'thinking',
  });
  yield { kind: 'node.created', ...envelope(conversationId), node: asstNode };

  const runStart = Date.now();
  yield {
    kind: 'status.update',
    ...envelope(conversationId),
    node_id: asstId,
    state: 'thinking',
    elapsed_ms: 0,
  };

  const chain = await walkChain(conversationId, parentUserNodeId);
  const history: OllamaMessage[] = [{ role: 'system', content: systemPrompt }];
  for (const m of chain) {
    history.push({
      role: m.role === 'asst' ? 'assistant' : 'user',
      content: m.content,
    });
  }

  let accumulated = '';
  const reasoningSteps: string[] = [];
  const reasoningBuffer: string[] = [];
  const finalToolCalls: ToolCallData[] = [];

  // -- agentic loop --
  for (let round = 0; round < config.maxToolRounds; round++) {
    let roundContent = '';
    const roundToolCalls: OllamaToolCall[] = [];
    const splitter = new ThinkSplitter();

    // Helper: dispatch splitter segments to events + accumulators.
    const dispatch = (segments: ReturnType<ThinkSplitter['feed']>): BusEvent[] => {
      const events: BusEvent[] = [];
      for (const seg of segments) {
        if (seg.type === 'content') {
          accumulated += seg.text;
          roundContent += seg.text;
          events.push({
            kind: 'content.delta',
            ...envelope(conversationId),
            node_id: asstId,
            delta: seg.text,
          });
          events.push({
            kind: 'status.update',
            ...envelope(conversationId),
            node_id: asstId,
            state: 'streaming',
            elapsed_ms: Date.now() - runStart,
          });
        } else if (seg.type === 'reasoning') {
          reasoningBuffer[seg.step_index] =
            (reasoningBuffer[seg.step_index] ?? '') + seg.text;
          events.push({
            kind: 'reasoning.delta',
            ...envelope(conversationId),
            node_id: asstId,
            step_index: seg.step_index,
            delta: seg.text,
          });
        } else {
          // reasoning_end
          const finalText = reasoningBuffer[seg.step_index] ?? '';
          reasoningSteps.push(finalText);
          events.push({
            kind: 'reasoning.step.end',
            ...envelope(conversationId),
            node_id: asstId,
            step_index: seg.step_index,
            final_text: finalText,
          });
        }
      }
      return events;
    };

    try {
      const stream = await ollama.chat({
        model,
        messages: history,
        tools: OLLAMA_TOOLS,
        stream: true,
      });

      for await (const part of stream) {
        const delta = part.message?.content;
        if (delta) {
          for (const ev of dispatch(splitter.feed(delta))) yield ev;
        }
        const tcs = part.message?.tool_calls;
        if (tcs) {
          for (const tc of tcs) {
            roundToolCalls.push({
              function: {
                name: tc.function.name,
                arguments: (tc.function.arguments ?? {}) as Record<string, unknown>,
              },
            });
          }
        }
      }

      // Drain any chars the splitter was holding back.
      for (const ev of dispatch(splitter.flush())) yield ev;

      await updateNode(asstId, {
        content: accumulated,
        ...(reasoningSteps.length > 0 ? { reasoning: reasoningSteps } : {}),
      });

      if (roundToolCalls.length === 0) break;

      history.push({
        role: 'assistant',
        content: roundContent,
        tool_calls: roundToolCalls,
      });

      for (const tc of roundToolCalls) {
        const toolName = tc.function.name;
        const args = tc.function.arguments;

        // ask_clarification is modeled as a tool call the model issues,
        // but it's really a pause-for-user mechanic — not an executable
        // tool. Short-circuit into the clarify flow: persist a Clarify
        // row, emit clarify.requested, block on the user's answer,
        // push that back as the "tool result" the model sees, continue.
        if (toolName === 'ask_clarification') {
          const clarifyId = `cl-${randomUUID().slice(0, 8)}`;
          const chipsRaw = Array.isArray(args.chips) ? (args.chips as unknown[]) : [];
          const clarifyData: ClarifyData = {
            question: String(args.question ?? 'Could you clarify?'),
            chips: chipsRaw.map((label, i) => ({
              id: `c-${i}`,
              label: String(label),
            })),
            input: String(args.input_hint ?? ''),
          };
          await insertClarify({
            id: clarifyId,
            conversation_id: conversationId,
            node_id: asstId,
            question: clarifyData.question,
            chips: clarifyData.chips,
            input_hint: clarifyData.input,
          });
          await updateNode(asstId, { status: 'approval' });

          yield {
            kind: 'clarify.requested',
            ...envelope(conversationId),
            node_id: asstId,
            clarify_id: clarifyId,
            clarify: clarifyData,
          };
          yield {
            kind: 'status.update',
            ...envelope(conversationId),
            node_id: asstId,
            state: 'approval',
            elapsed_ms: Date.now() - runStart,
          };

          const response = await awaitAnswer(clarifyId);
          await recordClarifyResponse(clarifyId, response);

          yield {
            kind: 'clarify.answered',
            ...envelope(conversationId),
            node_id: asstId,
            clarify_id: clarifyId,
            response,
          };

          const pickedLabels = clarifyData.chips
            .filter((c) => response.selected_chip_ids.includes(c.id))
            .map((c) => c.label);
          const summary = [
            pickedLabels.length
              ? `Selected: ${pickedLabels.join(', ')}.`
              : 'No chips selected.',
            response.text ? `Free-form: ${response.text}` : 'No free-form text.',
          ].join(' ');

          // Persist on the node so tree-view shows the answered state.
          const answeredClarify: ClarifyData = {
            ...clarifyData,
            chips: clarifyData.chips.map((c) => ({
              ...c,
              selected: response.selected_chip_ids.includes(c.id),
            })),
          };
          await updateNode(asstId, { status: null });
          await getPrismaFacadeUpdateClarify(asstId, answeredClarify);

          history.push({ role: 'tool', content: summary });
          continue;
        }

        const proposedCall: ToolCallData = { name: toolName, args, status: 'pending' };
        yield {
          kind: 'toolcall.proposed',
          ...envelope(conversationId),
          node_id: asstId,
          tool_call: proposedCall,
        };

        const autoApproved = await isAutoApproved(conv.agentId, toolName);
        let denied = false;
        if (!autoApproved) {
          const approvalId = `ap-${randomUUID().slice(0, 8)}`;
          const approvalPayload = approvalPayloadFor(toolName, args);
          await insertApproval({
            id: approvalId,
            conversation_id: conversationId,
            node_id: asstId,
            tool: approvalPayload.tool,
            title: approvalPayload.title,
            body: approvalPayload.body,
            preview: approvalPayload.preview,
          });
          await updateNode(asstId, { status: 'approval' });

          yield {
            kind: 'approval.requested',
            ...envelope(conversationId),
            node_id: asstId,
            approval_id: approvalId,
            approval: approvalPayload,
          };
          yield {
            kind: 'status.update',
            ...envelope(conversationId),
            node_id: asstId,
            state: 'approval',
            elapsed_ms: Date.now() - runStart,
            tool: toolName,
          };

          const decision = await awaitDecision(approvalId);

          yield {
            kind: 'approval.decided',
            ...envelope(conversationId),
            node_id: asstId,
            approval_id: approvalId,
            decision,
          };

          if (decision === 'always') {
            await insertGrant(conv.agentId, toolName);
          }
          if (decision === 'deny') denied = true;
        }

        if (denied) {
          const deniedCall: ToolCallData = {
            name: toolName,
            args,
            status: 'err',
            elapsed: '0.0s',
          };
          finalToolCalls.push(deniedCall);
          await updateNode(asstId, { tool_call: deniedCall, status: null });
          yield {
            kind: 'toolcall.ended',
            ...envelope(conversationId),
            node_id: asstId,
            status: 'err',
            elapsed_ms: 0,
            error: 'Denied by user',
          };
          history.push({
            role: 'tool',
            content: `The user denied the ${toolName} call. Continue without it.`,
          });
          continue;
        }

        await updateNode(asstId, { status: null });

        yield {
          kind: 'toolcall.started',
          ...envelope(conversationId),
          node_id: asstId,
          tool: toolName,
          args,
        };
        yield {
          kind: 'status.update',
          ...envelope(conversationId),
          node_id: asstId,
          state: 'tool',
          elapsed_ms: Date.now() - runStart,
          tool: toolName,
        };

        const exec = await executeTool(toolName, args);

        const finalStatus = exec.status === 'ok' ? 'ok' : 'err';
        const finalizedCall: ToolCallData = {
          name: toolName,
          args,
          status: finalStatus,
          elapsed: `${(exec.elapsed_ms / 1000).toFixed(1)}s`,
          ...(exec.result ? { result: exec.result } : {}),
        };
        finalToolCalls.push(finalizedCall);
        await updateNode(asstId, { tool_call: finalizedCall });

        yield {
          kind: 'toolcall.ended',
          ...envelope(conversationId),
          node_id: asstId,
          status: finalStatus,
          elapsed_ms: exec.elapsed_ms,
          ...(exec.result !== undefined ? { result: exec.result } : {}),
          ...(exec.error !== undefined ? { error: exec.error } : {}),
        };

        // Phase 6: write_file promotes to a versioned artifact. We
        // recompute content from args so we don't rely on the tool
        // result string carrying the bytes.
        if (
          toolName === 'write_file' &&
          finalStatus === 'ok' &&
          typeof args.path === 'string' &&
          typeof args.content === 'string'
        ) {
          try {
            const { artifact, version } = await recordArtifactWrite({
              conversation_id: conversationId,
              title: args.path,
              content: args.content,
              author: 'asst',
              produced_by_node_id: asstId,
              message: `Written by ${toolName}`,
            });
            yield {
              kind: 'artifact.updated',
              ...envelope(conversationId),
              artifact_id: artifact.id,
              version_id: version.id,
              version: version.version,
              title: artifact.title,
            };
          } catch (err) {
            // Artifact bookkeeping failure shouldn't kill the turn;
            // log and continue so the user still gets a reply.
            console.error('[artifact]', err);
          }
        }

        history.push({
          role: 'tool',
          content: exec.result ?? exec.error ?? '',
        });
      }
    } catch (err) {
      await updateNode(asstId, { streaming: false, status: null });
      yield {
        kind: 'error',
        ...envelope(conversationId),
        node_id: asstId,
        message: err instanceof Error ? err.message : String(err),
        recoverable: false,
      };
      return;
    }
  }

  const finalized = await updateNode(asstId, { streaming: false, status: null });
  await updateConversationPointers(conversationId, {
    active_leaf_id: asstId,
    snippet: accumulated.slice(0, 80),
    updated_at: new Date(),
  });
  if (finalized) {
    yield {
      kind: 'node.finalized',
      ...envelope(conversationId),
      node_id: asstId,
      node: finalized,
    };
  }
  yield {
    kind: 'active_leaf.changed',
    ...envelope(conversationId),
    active_leaf_id: asstId,
  };
}
