/**
 * Mirrors chat-box/src/data/sample.ts so /api/v1/dev/seed can produce
 * a populated database that renders identically to the client's
 * hardcoded stub. Shapes MUST match the client's types exactly — any
 * drift and the UI will blank out parts of the thread.
 *
 * The chat-box Conversation.agent field is a display-name string, not
 * an id; for seeding we carry the client's shape verbatim and resolve
 * to agent_id at insert time.
 */

import type {
  Agent,
  ApprovalData,
  ClarifyData,
  MessageNode,
  ToolCallData,
} from '../schemas/index.js';

export interface SampleConversation {
  id: string;
  title: string;
  snippet: string;
  agent: string;     // display name; resolved to agent_id by the seeder
  tag: string;
  pinned?: boolean;
  updated: string;
  folder: string;
}

export const SAMPLE_CONVERSATIONS: SampleConversation[] = [
  {
    id: 'c-01',
    title: 'Refactoring the retry policy in orders-service',
    snippet: "Let's look at idempotency keys and exponential backoff…",
    agent: 'Code Reviewer',
    tag: 'work',
    pinned: true,
    updated: '11:42',
    folder: 'Pinned',
  },
  {
    id: 'c-02',
    title: 'Draft a letter to the editor of The Atlantic',
    snippet: 'Something warm, not too earnest. Three paragraphs.',
    agent: 'Essayist',
    tag: 'writing',
    updated: 'Today',
    folder: 'Pinned',
  },
  {
    id: 'c-03',
    title: 'Tree-of-thought for the logistics problem',
    snippet: 'If we branch on carrier first, then SLA…',
    agent: 'Thinker',
    tag: 'research',
    updated: 'Today',
    folder: 'Today',
  },
  {
    id: 'c-04',
    title: 'Prompt optimizer for structured JSON extraction',
    snippet: 'v3 beats v2 on nested fields by 8%.',
    agent: 'Prompt Smith',
    tag: 'agents',
    updated: 'Today',
    folder: 'Today',
  },
  {
    id: 'c-05',
    title: 'Planning the Q3 onsite agenda',
    snippet: 'Keep the salon-style sessions, drop the…',
    agent: 'Assistant',
    tag: 'work',
    updated: 'Yesterday',
    folder: 'This week',
  },
  {
    id: 'c-06',
    title: 'Teach me about Byzantine mosaic techniques',
    snippet: 'Opus vermiculatum vs tessellatum — show me…',
    agent: 'Tutor',
    tag: 'learning',
    updated: 'Yesterday',
    folder: 'This week',
  },
  {
    id: 'c-07',
    title: 'Bug hunt: stale cache in profile loader',
    snippet: 'Suspicious: the ETag changes on every GET.',
    agent: 'Code Reviewer',
    tag: 'work',
    updated: 'Mon',
    folder: 'This week',
  },
  {
    id: 'c-08',
    title: 'Italian grammar — congiuntivo review',
    snippet: 'Sembra che tu abbia ragione…',
    agent: 'Tutor',
    tag: 'learning',
    updated: 'Sun',
    folder: 'Earlier',
  },
  {
    id: 'c-09',
    title: 'Recipe development: sourdough pizza bianca',
    snippet: '72% hydration, 24h cold ferment, rosemary salt.',
    agent: 'Assistant',
    tag: 'personal',
    updated: 'Apr 14',
    folder: 'Earlier',
  },
];

export const SAMPLE_AGENTS: Agent[] = [
  {
    id: 'a-01',
    name: 'Code Reviewer',
    initial: 'C',
    desc: 'Careful, opinionated reviews of code diffs. Flags bugs, style, and test gaps.',
    model: 'qwen2.5:14b',
    tools: 4,
    temp: 0.2,
  },
  {
    id: 'a-02',
    name: 'Essayist',
    initial: 'E',
    desc: 'Warm, considered prose in the style of long-form magazines.',
    model: 'qwen2.5:14b',
    tools: 1,
    temp: 0.9,
  },
  {
    id: 'a-03',
    name: 'Thinker',
    initial: 'T',
    desc: 'Deep reasoning with tree-of-thought. Explores, critiques, resolves.',
    model: 'qwen2.5:14b',
    tools: 2,
    temp: 0.5,
  },
  {
    id: 'a-04',
    name: 'Prompt Smith',
    initial: 'P',
    desc: 'Refines, tests, and versions your prompts against a held-out set.',
    model: 'qwen2.5:14b',
    tools: 3,
    temp: 0.3,
  },
  {
    id: 'a-05',
    name: 'Tutor',
    initial: 'U',
    desc: 'Socratic tutor. Asks before telling. Gentle, curious, never condescending.',
    model: 'qwen2.5:14b',
    tools: 0,
    temp: 0.7,
  },
  {
    id: 'a-06',
    name: 'Researcher',
    initial: 'R',
    desc: 'Surveys sources, cites carefully, flags conflicting evidence.',
    model: 'qwen2.5:14b',
    tools: 5,
    temp: 0.4,
  },
  // Synthetic — SAMPLE_CONVERSATIONS references "Assistant" but the
  // client's SAMPLE_AGENTS doesn't ship one. Adding it here keeps the
  // agent-name join total so every seeded conversation has a real FK.
  {
    id: 'a-07',
    name: 'Assistant',
    initial: 'A',
    desc: 'A helpful general-purpose assistant.',
    model: 'qwen2.5:14b',
    tools: 2,
    temp: 0.5,
  },
];

export interface SampleTreeNode extends Omit<MessageNode, 'reasoning' | 'toolCall' | 'clarify' | 'approval'> {
  reasoning?: string[];
  toolCall?: ToolCallData;
  clarify?: ClarifyData;
  approval?: ApprovalData;
}

/**
 * The one fully-populated tree the client ships. Everything belongs to
 * conversation c-01; the seeder writes every node under that id.
 * rootId: n-01, activeLeaf: n-07.
 */
export const SAMPLE_TREE_NODES: SampleTreeNode[] = [
  {
    id: 'n-01',
    parent: null,
    role: 'user',
    time: '11:28',
    branch: 'main',
    content:
      "Walk me through refactoring the retry policy in orders-service. It currently retries everything 5 times with no backoff, and we're seeing thundering herd on the payments API.",
  },
  {
    id: 'n-02',
    parent: 'n-01',
    role: 'asst',
    time: '11:28',
    branch: 'main',
    content:
      'Before I draft anything, one question: are the payment calls **idempotent on the server side** — i.e. does the payments API dedupe by `Idempotency-Key`, or do retries risk double-charging? That changes the whole shape of the fix.\n\nIn the meantime, let me read the current retry utility so I can be specific.',
    reasoning: [
      'The user describes blind retries with no backoff, causing a thundering herd. This is a classic reliability anti-pattern.',
      "I should diagnose before prescribing: which errors are retried, what's idempotent, what downstream expects idempotency keys.",
      "I'll ask one clarifying question, then outline a policy: classify errors, backoff+jitter, bounded attempts, idempotency.",
      'I have read-access to the repo — I should probably peek at the existing retry code to be concrete.',
    ],
    toolCall: {
      name: 'read_file',
      args: { path: 'services/orders/src/retry.ts' },
      status: 'ok',
      elapsed: '0.4s',
      result:
        'export async function withRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {\n  let lastErr;\n  for (let i = 0; i < attempts; i++) {\n    try { return await fn(); }\n    catch (e) { lastErr = e; }\n  }\n  throw lastErr;\n}',
    },
    clarify: {
      question: 'Also — which of these constraints matter for this refactor?',
      chips: [
        { id: 'idem', label: 'Idempotency-safe by default', selected: true },
        { id: 'jitt', label: 'Full jitter backoff', selected: true },
        { id: 'budg', label: 'Per-request retry budget' },
        { id: 'obs', label: 'Emit OTel spans' },
        { id: 'circ', label: 'Circuit breaker' },
      ],
      input: 'Anything else I should respect? (e.g. deadlines, SLAs)',
    },
  },
  {
    id: 'n-03',
    parent: 'n-02',
    role: 'user',
    time: '11:30',
    branch: 'main',
    content:
      'Payments API uses Idempotency-Key. Pick idempotency + full jitter + retry budget. We have a 30s deadline per order write.',
  },
  {
    id: 'n-04',
    parent: 'n-03',
    role: 'asst',
    time: '11:31',
    branch: 'main',
    content:
      "Here's the shape I'd propose. Three moving parts:\n\n**1. Classification.** Only retry on: network errors, 5xx, 429. Never on 4xx-except-429 — those are bugs, not flakes.\n\n**2. Full-jitter backoff** with a cap and a **shared deadline**, not a fixed attempt count.\n\n**3. A retry budget** (token bucket) so a failing dependency can't multiply your traffic.\n\nI want to apply this as a diff, but writing to the repo needs your approval.",
    reasoning: [
      'Good — with idempotency on the server, retries are safe for payments.',
      'Full jitter is the AWS recipe: sleep = random(0, base * 2^attempt) capped. Works well under contention.',
      'Retry budget: a token bucket at the client. Kills cascades when the backend is down.',
      '30s deadline → attempts must share the deadline. Not fixed attempts; retry until deadline-slack < RTT.',
    ],
    approval: {
      tool: 'write_file',
      title: 'Apply retry policy refactor',
      body: 'Write the new `retry.ts` with full-jitter, deadline-aware retry + a shared token bucket. 3 files will be changed.',
      preview:
        'services/orders/src/retry.ts   (+82, -9)\nservices/orders/src/config.ts  (+6)\nservices/orders/tests/retry.test.ts  (+134)',
    },
  },
  {
    id: 'n-05',
    parent: 'n-04',
    role: 'user',
    time: '11:33',
    branch: 'main',
    content: 'Approved. Also add OTel spans around each attempt.',
  },
  {
    id: 'n-06',
    parent: 'n-05',
    role: 'asst',
    time: '11:34',
    branch: 'main',
    content: 'Writing now, with spans.',
    status: 'streaming',
    reasoning: [
      'Wrap each attempt in a span named retry.attempt with attrs: attempt_number, sleep_ms, error.type.',
      'Parent span should be retry.call, carrying deadline_ms and final_outcome.',
      "Keep dependency on @opentelemetry/api as is; it's already in the repo.",
    ],
    toolCall: {
      name: 'write_file',
      args: { path: 'services/orders/src/retry.ts', bytes: 3642, lines: 128 },
      status: 'ok',
      elapsed: '1.1s',
      result:
        '✓ 3 files written.\n  services/orders/src/retry.ts\n  services/orders/src/config.ts\n  services/orders/tests/retry.test.ts',
    },
  },
  {
    id: 'n-07',
    parent: 'n-06',
    role: 'asst',
    time: '11:34',
    branch: 'main',
    content:
      'Done. Quick summary of what I changed, so you can eyeball before we run the tests:\n\n• `withRetry(fn, { deadline, budget })` — deadline-aware, no fixed attempt count.\n• Full-jitter: `sleep = random(0, min(cap, base * 2^attempt))`.\n• Retry budget: token bucket (100 tokens, refills at 10/s). Prevents cascades.\n• Every attempt gets an OTel span; the call-level span carries the final outcome.\n\nShall I run the test suite?',
    streaming: true,
  },
  {
    id: 'n-03b',
    parent: 'n-02',
    role: 'user',
    time: '11:34',
    branch: 'alt-1',
    edited: true,
    content:
      'Payments API uses Idempotency-Key. Pick idempotency + circuit breaker + retry budget. Deadline is 15s (not 30s) per order write.',
  },
  {
    id: 'n-04b',
    parent: 'n-03b',
    role: 'asst',
    time: '11:35',
    branch: 'alt-1',
    content:
      "With 15s and a breaker, retries become more conservative. I'd allow at most 2 retries per call, each with jitter, and cut off as soon as the breaker trips. Want me to sketch the state machine?",
    reasoning: [
      'Tighter deadline: 15s. Circuit breaker replaces jitter as main failure mode defense.',
      'Retry budget still makes sense as a second line.',
    ],
  },
];

export const SAMPLE_TREE_ROOT = 'n-01';
export const SAMPLE_TREE_ACTIVE_LEAF = 'n-07';
export const SAMPLE_TREE_CONVERSATION = 'c-01';
