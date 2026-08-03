import { beforeEach, describe, expect, it, vi } from 'vitest';

const { INVOCATIONS, MODEL_OPTIONS, RESPONSE } = vi.hoisted(() => ({
  INVOCATIONS: [] as Array<{ messages: unknown; options: unknown }>,
  MODEL_OPTIONS: [] as Array<Record<string, unknown>>,
  RESPONSE: { content: '', error: null as Error | null },
}));

vi.mock('@langchain/ollama', () => ({
  ChatOllama: class ChatOllama {
    constructor(options: Record<string, unknown>) {
      MODEL_OPTIONS.push(options);
    }

    async invoke(messages: unknown, options: unknown) {
      INVOCATIONS.push({ messages, options });
      if (RESPONSE.error) throw RESPONSE.error;
      return { content: RESPONSE.content };
    }
  },
}));

import {
  fallbackConversationTitle,
  generateConversationTitle,
  normalizeConversationTitle,
} from '../../src/runtime/conversation-title.js';

beforeEach(() => {
  INVOCATIONS.length = 0;
  MODEL_OPTIONS.length = 0;
  RESPONSE.content = '';
  RESPONSE.error = null;
});

describe('conversation title generation', () => {
  it('asks the selected model for a short title and cleans its response', async () => {
    RESPONSE.content = '<think>Internal notes</think>\nTitle: **Berlin Weekend Itinerary.**';

    await expect(
      generateConversationTitle('qwen-title:latest', 'Help me plan a weekend in Berlin'),
    ).resolves.toBe('Berlin Weekend Itinerary');
    expect(MODEL_OPTIONS[0]).toMatchObject({
      model: 'qwen-title:latest',
      temperature: 0.2,
      numPredict: 24,
    });
    expect(INVOCATIONS).toHaveLength(1);
  });

  it('falls back to readable user text if the model is unavailable', async () => {
    RESPONSE.error = new Error('offline');
    await expect(
      generateConversationTitle(
        'missing-model',
        'Diagnose intermittent checkout failures. They started after the deploy.',
      ),
    ).resolves.toBe('Diagnose intermittent checkout failures');
  });

  it('rejects a title in a different writing system than the user text', async () => {
    RESPONSE.content = '支付失败的订阅续订策略设计';
    await expect(
      generateConversationTitle(
        'qwen-title:latest',
        'Help me design a resilient payment retry strategy for failed subscription renewals.',
      ),
    ).resolves.toBe('Design a resilient payment retry strategy for failed');
  });

  it('normalizes labels, quotes, markdown, punctuation, whitespace, and length', () => {
    expect(normalizeConversationTitle('  Conversation title: "**Cache   Invalidation Fix!**"  '))
      .toBe('Cache Invalidation Fix');
    expect(normalizeConversationTitle('A very long title describing every single possible detail about an issue'))
      .toBe('A very long title describing every single possible detail');
  });

  it('removes noisy source formatting from fallback titles', () => {
    expect(fallbackConversationTitle('# Review https://example.com the API migration plan. More'))
      .toBe('Review the API migration plan');
  });
});
