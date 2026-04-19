import { randomUUID } from 'node:crypto';
import { Ollama, type Message as OllamaMessage } from 'ollama';
import {
  EventType,
  type BaseEvent,
  type Message as AGUIMessage,
  type RunAgentInput,
} from '@ag-ui/core';
import { config } from './config.js';

const ollama = new Ollama({ host: config.ollamaHost });

function toOllamaMessages(messages: AGUIMessage[]): OllamaMessage[] {
  const out: OllamaMessage[] = [];
  for (const m of messages) {
    if (m.role === 'activity' || m.role === 'reasoning') continue;
    const role =
      m.role === 'developer' ? 'system'
      : m.role === 'tool' ? 'tool'
      : m.role;
    const content = 'content' in m && typeof m.content === 'string' ? m.content : '';
    out.push({ role, content });
  }
  return out;
}

export async function* runAgent(
  input: RunAgentInput,
  modelOverride?: string,
): AsyncGenerator<BaseEvent> {
  const { threadId, runId, messages, forwardedProps } = input;
  const model =
    modelOverride
    ?? (typeof forwardedProps?.model === 'string' ? forwardedProps.model : undefined)
    ?? config.defaultModel;

  yield { type: EventType.RUN_STARTED, threadId, runId } as BaseEvent;

  const messageId = randomUUID();
  yield {
    type: EventType.TEXT_MESSAGE_START,
    messageId,
    role: 'assistant',
  } as BaseEvent;

  try {
    const stream = await ollama.chat({
      model,
      messages: toOllamaMessages(messages),
      stream: true,
    });
    for await (const part of stream) {
      const delta = part.message?.content;
      if (delta) {
        yield {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId,
          delta,
        } as BaseEvent;
      }
    }
  } catch (err) {
    yield {
      type: EventType.RUN_ERROR,
      message: err instanceof Error ? err.message : String(err),
    } as BaseEvent;
    return;
  }

  yield { type: EventType.TEXT_MESSAGE_END, messageId } as BaseEvent;
  yield { type: EventType.RUN_FINISHED, threadId, runId } as BaseEvent;
}
