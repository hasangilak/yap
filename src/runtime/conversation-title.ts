import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatOllama } from '@langchain/ollama';
import { config } from '../config.js';
import {
  getAgentRaw,
  getConversationRaw,
  updateConversationTitleIfCurrent,
} from '../db/queries.js';

export const DEFAULT_CONVERSATION_TITLE = 'New conversation';
const MAX_TITLE_LENGTH = 60;
const MAX_SOURCE_LENGTH = 4_000;

function scriptCounts(text: string): { latin: number; eastAsian: number } {
  return {
    latin: text.match(/\p{Script=Latin}/gu)?.length ?? 0,
    eastAsian:
      text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)
        ?.length ?? 0,
  };
}

/** Reject obvious language drift such as a Chinese title for English input. */
function titleMatchesSourceScript(source: string, title: string): boolean {
  const input = scriptCounts(source);
  const output = scriptCounts(title);
  if (input.latin >= 5 && input.latin > input.eastAsian * 2) {
    return output.latin >= 3 && output.latin >= output.eastAsian;
  }
  if (input.eastAsian >= 3 && input.eastAsian > input.latin * 2) {
    return output.eastAsian >= 2 && output.eastAsian >= output.latin;
  }
  return true;
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && 'text' in part) {
        return String((part as { text?: unknown }).text ?? '');
      }
      return '';
    })
    .join('');
}

/** Turn a model response into a safe, single-line sidebar title. */
export function normalizeConversationTitle(raw: string): string {
  let title = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^\s*(?:title|conversation title)\s*:\s*/i, '')
    .split(/\r?\n/, 1)[0]!
    .trim()
    .replace(/^["'`*_#\s]+|["'`*_#\s]+$/g, '')
    .replace(/[.!?,;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (title.length > MAX_TITLE_LENGTH) {
    title = title.slice(0, MAX_TITLE_LENGTH + 1);
    const lastSpace = title.lastIndexOf(' ');
    title = (lastSpace >= 24 ? title.slice(0, lastSpace) : title.slice(0, MAX_TITLE_LENGTH)).trim();
  }
  return title;
}

/** A readable title when the naming model is temporarily unavailable. */
export function fallbackConversationTitle(content: string): string {
  let plain = content
    .replace(/```[\s\S]*?```/g, ' code ')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^[#>*\-\d.)\s]+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!plain) return DEFAULT_CONVERSATION_TITLE;
  plain = plain.replace(
    /^(?:please\s+)?(?:help\s+me|can\s+you|could\s+you|i\s+need\s+(?:you\s+)?to)\s+/i,
    '',
  );
  if (/^[a-z]/.test(plain)) plain = plain[0]!.toUpperCase() + plain.slice(1);
  const firstThought = plain.split(/(?<=[.!?])\s/, 1)[0] ?? plain;
  return normalizeConversationTitle(firstThought) || DEFAULT_CONVERSATION_TITLE;
}

export async function generateConversationTitle(model: string, content: string): Promise<string> {
  try {
    const llm = new ChatOllama({
      model,
      baseUrl: config.ollamaHost,
      temperature: 0.2,
      numPredict: 24,
    });
    const response = await llm.invoke(
      [
        new SystemMessage(
          'Name this conversation from the user text. Return only a specific 3-7 word title, ' +
            'in the user\'s language. No quotes, markdown, label, or ending punctuation.',
        ),
        new HumanMessage(content.slice(0, MAX_SOURCE_LENGTH)),
      ],
      { signal: AbortSignal.timeout(config.toolDeadlineMs) },
    );
    const title = normalizeConversationTitle(messageText(response.content));
    return title && titleMatchesSourceScript(content, title)
      ? title
      : fallbackConversationTitle(content);
  } catch {
    return fallbackConversationTitle(content);
  }
}

/**
 * Generate and persist a first-message title. Returns null if this conversation
 * already has a meaningful title or another request won the update race.
 */
export async function maybeNameConversation(
  conversationId: string,
  content: string,
): Promise<string | null> {
  const conversation = await getConversationRaw(conversationId);
  if (!conversation || conversation.title !== DEFAULT_CONVERSATION_TITLE) return null;
  const agent = await getAgentRaw(conversation.agentId);
  if (!agent) return null;

  const title = await generateConversationTitle(agent.model, content);
  if (title === DEFAULT_CONVERSATION_TITLE) return null;
  const updated = await updateConversationTitleIfCurrent(
    conversationId,
    DEFAULT_CONVERSATION_TITLE,
    title,
  );
  return updated ? title : null;
}
