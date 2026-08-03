import type { AIMessageChunk, BaseMessage } from '@langchain/core/messages';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { ChatOllama } from '@langchain/ollama';
import { config } from '../../config.js';
import { OLLAMA_TOOLS } from '../../registry/tools.js';
import { ThinkSplitter, type Segment } from '../think-splitter.js';
import type { NormalizedToolCall, TurnMessage } from './state.js';

/**
 * The model call for one round of the agentic loop.
 *
 * Kept deliberately thin: LangGraph orchestrates and checkpoints, LangChain
 * only talks to Ollama. Four behaviors here are load-bearing and were
 * verified against a live Ollama before this was written:
 *
 *  1. Token-level streaming survives `bindTools()`. The Python
 *     `langchain_ollama` has an open bug where binding tools collapses the
 *     response into one chunk (langchain#26971); `@langchain/ollama@1.3.0`
 *     does not reproduce it. If a future bump regresses this, `<think>`
 *     splitting and `content.delta` granularity both break — the test in
 *     `test/unit/model.test.ts` guards it.
 *  2. Tool-call arguments arrive as a JSON *string* on `tool_call_chunks`,
 *     possibly split across chunks. We accumulate `AIMessageChunk`s with
 *     `.concat()` and read the parsed `.tool_calls` at the end rather than
 *     parsing fragments ourselves.
 *  3. `AbortSignal` in the call options genuinely cancels the HTTP stream
 *     (throws `AbortError`), which is what backs `config.toolDeadlineMs`.
 *  4. Reasoning is detected by tag-splitting `.content`, not by reading a
 *     provider `thinking` field — same as the old direct-client path.
 */

export type AbortReason = 'deadline' | 'external';

export interface ModelRoundResult {
  /** Text outside `<think>` tags produced this round. */
  roundContent: string;
  /** Reasoning blocks that closed during this round. */
  reasoningSteps: string[];
  toolCalls: NormalizedToolCall[];
  /** Set when the stream was cut short rather than ending naturally. */
  abortedBy?: AbortReason;
}

/** Extract plain text from a chunk's content, which may be blocks. */
function chunkText(content: AIMessageChunk['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const part of content) {
    if (typeof part === 'string') out += part;
    else if (part && typeof part === 'object' && 'text' in part) {
      out += String((part as { text?: unknown }).text ?? '');
    }
  }
  return out;
}

/**
 * Convert the turn's own JSON message history into LangChain messages.
 *
 * We build the class instances here rather than storing them in graph state
 * so the checkpoint stays plain JSON. `tool` messages need a
 * `tool_call_id`; when the provider gave us none we synthesize a stable one
 * from the position so the pairing survives a replay.
 */
export function toLangChainMessages(messages: TurnMessage[]): BaseMessage[] {
  const out: BaseMessage[] = [];
  let lastToolCallIds: string[] = [];
  let toolResultCursor = 0;

  for (const m of messages) {
    if (m.role === 'system') {
      out.push(new SystemMessage(m.content));
    } else if (m.role === 'user') {
      out.push(new HumanMessage(m.content));
    } else if (m.role === 'assistant') {
      const toolCalls = (m.tool_calls ?? []).map((tc, i) => ({
        id: tc.id ?? `call_${i}`,
        name: tc.name,
        args: tc.args,
        type: 'tool_call' as const,
      }));
      lastToolCallIds = toolCalls.map((tc) => tc.id);
      toolResultCursor = 0;
      out.push(
        toolCalls.length > 0
          ? new AIMessage({ content: m.content, tool_calls: toolCalls })
          : new AIMessage(m.content),
      );
    } else {
      // Tool results follow their assistant message in order.
      const id = lastToolCallIds[toolResultCursor] ?? `call_${toolResultCursor}`;
      toolResultCursor++;
      out.push(new ToolMessage({ content: m.content, tool_call_id: id }));
    }
  }
  return out;
}

function normalizeToolCalls(acc: AIMessageChunk | undefined): NormalizedToolCall[] {
  if (!acc) return [];
  const calls = acc.tool_calls ?? [];
  return calls.map((tc) => ({
    ...(tc.id !== undefined ? { id: tc.id } : {}),
    name: tc.name,
    args: (tc.args ?? {}) as Record<string, unknown>,
  }));
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || err.message.toLowerCase().includes('abort'))
  );
}

/**
 * Stream one model round, pushing classified segments to `onSegment` as they
 * arrive so the caller can emit `content.delta` / `reasoning.delta` events in
 * order.
 *
 * Aborts are **caught, not thrown**: the caller gets a result with
 * `abortedBy` set. That matters because the graph must checkpoint cleanly —
 * a node that throws skips its checkpoint, which would lose the partial turn
 * we just streamed to the client.
 */
export async function streamModelRound(input: {
  model: string;
  temperature: number;
  topP: number;
  maxTokens: number;
  toolIds: string[];
  messages: TurnMessage[];
  /** Caller-owned signal (mid-turn steering). Never the HTTP request's. */
  signal?: AbortSignal;
  onSegment: (seg: Segment) => void;
}): Promise<ModelRoundResult> {
  const {
    model,
    temperature,
    topP,
    maxTokens,
    toolIds,
    messages,
    signal,
    onSegment,
  } = input;

  const splitter = new ThinkSplitter();
  const reasoningBuffer: string[] = [];
  const reasoningSteps: string[] = [];
  let roundContent = '';
  let acc: AIMessageChunk | undefined;

  const handle = (segments: Segment[]): void => {
    for (const seg of segments) {
      if (seg.type === 'content') {
        roundContent += seg.text;
      } else if (seg.type === 'reasoning') {
        reasoningBuffer[seg.step_index] =
          (reasoningBuffer[seg.step_index] ?? '') + seg.text;
      } else {
        reasoningSteps.push(reasoningBuffer[seg.step_index] ?? '');
      }
      onSegment(seg);
    }
  };

  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), config.toolDeadlineMs);
  const combined = signal
    ? AbortSignal.any([signal, deadline.signal])
    : deadline.signal;

  try {
    const llm = new ChatOllama({
      model,
      baseUrl: config.ollamaHost,
      temperature,
      topP,
      numPredict: maxTokens,
    });
    const selected = new Set(toolIds);
    const enabledTools = OLLAMA_TOOLS.filter(
      (tool) =>
        tool.function.name === 'ask_clarification' ||
        selected.has(tool.function.name ?? ''),
    );
    const withTools = llm.bindTools(enabledTools as never);
    const stream = await withTools.stream(toLangChainMessages(messages), {
      signal: combined,
    });

    for await (const chunk of stream) {
      acc = acc === undefined ? chunk : acc.concat(chunk);
      const text = chunkText(chunk.content);
      if (text) handle(splitter.feed(text));
    }
    handle(splitter.flush());
    return { roundContent, reasoningSteps, toolCalls: normalizeToolCalls(acc) };
  } catch (err) {
    if (!isAbortError(err)) throw err;
    // Keep whatever the splitter was holding so partial output is not lost.
    handle(splitter.flush());
    const abortedBy: AbortReason =
      signal?.aborted && !deadline.signal.aborted ? 'external' : 'deadline';
    return {
      roundContent,
      reasoningSteps,
      toolCalls: normalizeToolCalls(acc),
      abortedBy,
    };
  } finally {
    clearTimeout(timer);
  }
}
