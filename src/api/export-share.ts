import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { getPrisma } from '../db/index.js';
import {
  getConversation,
  getConversationRaw,
  getConversationTree,
  listArtifactsByConversation,
  walkChain,
} from '../db/queries.js';

export const exportShareRouter = new Hono();

function newShareToken(): string {
  return randomBytes(18).toString('base64url');
}

/**
 * GET /api/v1/conversations/:id/export?format=md|json
 *
 * md linearizes the active-leaf chain into a human-readable doc.
 * json returns the full tree + artifacts + conversation in one blob
 * for data portability.
 */
exportShareRouter.get('/conversations/:id/export', async (c) => {
  const id = c.req.param('id');
  const format = c.req.query('format') ?? 'md';
  const conv = await getConversationRaw(id);
  const wire = await getConversation(id);
  if (!conv || !wire) return c.json({ error: 'not found' }, 404);

  if (format === 'json') {
    const tree = await getConversationTree(id);
    const artifacts = await listArtifactsByConversation(id);
    const disposition = `attachment; filename="${sanitizeFilename(wire.title)}.json"`;
    c.header('Content-Type', 'application/json');
    c.header('Content-Disposition', disposition);
    return c.body(JSON.stringify({ conversation: wire, tree, artifacts }, null, 2));
  }

  if (format !== 'md') {
    return c.json({ error: 'format must be md or json' }, 400);
  }

  if (!conv.activeLeafId) {
    c.header('Content-Type', 'text/markdown');
    return c.body(`# ${wire.title}\n\n(empty conversation)\n`);
  }

  const chain = await walkChain(id, conv.activeLeafId);
  const lines: string[] = [];
  lines.push(`# ${wire.title}`);
  lines.push('');
  lines.push(`> Agent: ${wire.agent} · ${wire.tag || 'untagged'}`);
  lines.push('');
  for (const n of chain) {
    lines.push(`## ${n.role === 'asst' ? 'Assistant' : 'You'} — ${n.time}`);
    lines.push('');
    if (n.reasoning && n.reasoning.length > 0) {
      lines.push('<details><summary>Reasoning</summary>');
      lines.push('');
      for (let i = 0; i < n.reasoning.length; i++) {
        lines.push(`${i + 1}. ${n.reasoning[i]}`);
      }
      lines.push('');
      lines.push('</details>');
      lines.push('');
    }
    lines.push(n.content);
    lines.push('');
    if (n.toolCall) {
      const tc = n.toolCall;
      lines.push(`**Tool:** \`${tc.name}\` · ${tc.status}${tc.elapsed ? ` · ${tc.elapsed}` : ''}`);
      if (tc.result) {
        lines.push('```');
        lines.push(tc.result);
        lines.push('```');
      }
      lines.push('');
    }
  }

  const md = lines.join('\n');
  const disposition = `attachment; filename="${sanitizeFilename(wire.title)}.md"`;
  c.header('Content-Type', 'text/markdown');
  c.header('Content-Disposition', disposition);
  return c.body(md);
});

function sanitizeFilename(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'conversation';
}

// -- share links ------------------------------------------------------------

exportShareRouter.post('/conversations/:id/share', async (c) => {
  const id = c.req.param('id');
  const conv = await getConversationRaw(id);
  if (!conv) return c.json({ error: 'not found' }, 404);
  const token = conv.shareToken ?? newShareToken();
  if (!conv.shareToken) {
    await getPrisma().conversation.update({
      where: { id },
      data: { shareToken: token },
    });
  }
  return c.json({
    conversation_id: id,
    share_token: token,
    public_url: `/api/v1/shared/${token}`,
  });
});

exportShareRouter.delete('/conversations/:id/share', async (c) => {
  const id = c.req.param('id');
  try {
    await getPrisma().conversation.update({
      where: { id },
      data: { shareToken: null },
    });
    return c.json({ ok: true });
  } catch {
    return c.json({ error: 'not found' }, 404);
  }
});

/**
 * GET /api/v1/shared/:token
 *
 * Public read-only view — no auth required. Returns the title, agent
 * display name, and the linear chain along the current active leaf.
 * Everything else (tree, approvals, agent internals, events) is
 * stripped so a shared link can't leak internals.
 */
exportShareRouter.get('/shared/:token', async (c) => {
  const token = c.req.param('token');
  const conv = await getPrisma().conversation.findUnique({
    where: { shareToken: token },
  });
  if (!conv) return c.json({ error: 'not found' }, 404);
  const wire = await getConversation(conv.id);
  if (!wire || !conv.activeLeafId) {
    return c.json({ error: 'not available' }, 404);
  }
  const chain = await walkChain(conv.id, conv.activeLeafId);
  const publicChain = chain.map((n) => ({
    role: n.role,
    time: n.time,
    content: n.content,
    ...(n.reasoning ? { reasoning: n.reasoning } : {}),
    ...(n.toolCall
      ? {
          tool: { name: n.toolCall.name, status: n.toolCall.status },
        }
      : {}),
  }));
  return c.json({
    title: wire.title,
    agent: wire.agent,
    chain: publicChain,
  });
});
