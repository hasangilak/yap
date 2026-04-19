import { randomUUID } from 'node:crypto';
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
  insertGrant,
  insertNode,
  updateConversationPointers,
  updateNode,
  walkChain,
} from '../db/queries.js';
import { awaitDecision } from './approvals.js';
import { DEFAULT_SYSTEM_PROMPT } from '../system-prompt.js';
import type {
  ApprovalData,
  BusEvent,
  MessageNode,
  ToolCallData,
} from '../schemas/index.js';

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

  // Side-effect tools always need approval unless the agent is set to
  // auto_allow_all (handled above) or a grant exists.
  if (isSideEffectful(toolName)) return false;

  // Non-side-effect tools: auto_allow_read blanket-approves them, and
  // the tool's own auto flag covers the default case (e.g. web_search).
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
  return {
    tool: toolName,
    title: `Run ${toolName}`,
    body: desc,
    preview,
  };
}

const ollama = new Ollama({ host: config.ollamaHost });

function newNodeId(prefix: 'n' | 'u' | 'a' = 'n'): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

function envelope(conversation_id: string): { id: string; at: number; conversation_id: string } {
  return { id: newEventId(), at: Date.now(), conversation_id };
}

interface OllamaToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

/**
 * Run one assistant turn in response to a user message.
 *
 * Yields every BusEvent the SSE stream needs to show: node.created for
 * the user and assistant nodes, active_leaf.changed, status.update,
 * content.delta, tool call events, and finally node.finalized +
 * active_leaf.changed. DB writes happen inline so the final node is
 * already persisted when node.finalized arrives.
 *
 * PHASE-2: approval gating for side-effect tools lives in the for-loop
 * body marked below.
 * PHASE-5b: a <think>-tag parser would slot into the content-chunk
 * handler to fork text into content.delta vs reasoning.delta.
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

  const agent = await getAgentRaw(conv.agentId);
  const model = agent?.model ?? config.defaultModel;
  const systemPrompt = (agent?.systemPrompt && agent.systemPrompt.trim())
    ? agent.systemPrompt
    : DEFAULT_SYSTEM_PROMPT;

  // -- 1. user node ----------------------------------------------------------
  const parentChain = parent ? await walkChain(conversationId, parent) : [];
  const branch = parentChain[parentChain.length - 1]?.branch ?? 'main';
  const userId = newNodeId('n');
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

  // -- 2. placeholder assistant node ----------------------------------------
  const asstId = newNodeId('n');
  const asstNode = await insertNode({
    id: asstId,
    conversation_id: conversationId,
    parent_id: userId,
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

  // -- 3. build Ollama history from the active chain ------------------------
  const chain = await walkChain(conversationId, userId);
  const history: OllamaMessage[] = [{ role: 'system', content: systemPrompt }];
  for (const m of chain) {
    history.push({
      role: m.role === 'asst' ? 'assistant' : 'user',
      content: m.content,
    });
  }

  let accumulated = '';
  const finalToolCalls: ToolCallData[] = [];

  // -- 4. agentic loop: stream → maybe tool calls → repeat ------------------
  for (let round = 0; round < config.maxToolRounds; round++) {
    let roundContent = '';
    const roundToolCalls: OllamaToolCall[] = [];

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
          roundContent += delta;
          accumulated += delta;
          yield {
            kind: 'content.delta',
            ...envelope(conversationId),
            node_id: asstId,
            delta,
          };
          yield {
            kind: 'status.update',
            ...envelope(conversationId),
            node_id: asstId,
            state: 'streaming',
            elapsed_ms: Date.now() - runStart,
          };
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

      await updateNode(asstId, { content: accumulated });

      if (roundToolCalls.length === 0) {
        break; // no tools requested — normal finish
      }

      // Push the model's turn so the next round has it in context.
      history.push({
        role: 'assistant',
        content: roundContent,
        tool_calls: roundToolCalls,
      });

      for (const tc of roundToolCalls) {
        const toolName = tc.function.name;
        const args = tc.function.arguments;

        const proposedCall: ToolCallData = {
          name: toolName,
          args,
          status: 'pending',
        };
        yield {
          kind: 'toolcall.proposed',
          ...envelope(conversationId),
          node_id: asstId,
          tool_call: proposedCall,
        };

        // Approval gate: skip the round-trip if any layer auto-approves.
        // Otherwise pause the generator until POST /approvals/:id/decide
        // calls resolveApproval().
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
          // Attach to the node so the tree view can render the approval
          // card on refresh, not just in-stream.
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

          if (decision === 'deny') {
            denied = true;
          }
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

  // -- 5. finalize -----------------------------------------------------------
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
