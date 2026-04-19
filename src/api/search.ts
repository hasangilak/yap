import { Hono } from 'hono';
import { getPrisma } from '../db/index.js';
import type { SearchHit } from '../schemas/index.js';

export const searchRouter = new Hono();

function contextSnippet(haystack: string, needle: string, span = 120): string {
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  const i = h.indexOf(n);
  if (i < 0) return haystack.slice(0, span);
  const start = Math.max(0, i - Math.floor(span / 3));
  const end = Math.min(haystack.length, start + span);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < haystack.length ? '…' : '';
  return prefix + haystack.slice(start, end) + suffix;
}

function boldMatch(text: string, needle: string): string {
  const i = text.toLowerCase().indexOf(needle.toLowerCase());
  if (i < 0) return text;
  return text.slice(0, i) + '**' + text.slice(i, i + needle.length) + '**' + text.slice(i + needle.length);
}

/**
 * GET /api/v1/search?q=&scope=all|conversations|messages|agents
 *
 * Postgres ILIKE across the three scopes — good enough for Phase 7
 * and easy to upgrade to tsvector later (a GIN index on a generated
 * column is a schema-only change). Results return up to 20 hits per
 * scope, newest-first where applicable.
 */
searchRouter.get('/', async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  const scope = c.req.query('scope') ?? 'all';
  if (q.length < 2) {
    return c.json({ hits: [], query: q, scope });
  }
  const pattern = `%${q.replace(/[%_]/g, '\\$&')}%`;
  const prisma = getPrisma();
  const hits: SearchHit[] = [];
  const take = 20;

  if (scope === 'all' || scope === 'conversations') {
    const rows = await prisma.conversation.findMany({
      where: {
        OR: [
          { title: { contains: q, mode: 'insensitive' } },
          { snippet: { contains: q, mode: 'insensitive' } },
        ],
      },
      orderBy: { updatedAt: 'desc' },
      take,
    });
    for (const r of rows) {
      const source = `${r.title}\n${r.snippet}`;
      hits.push({
        scope: 'conversations',
        id: r.id,
        title: r.title,
        snippet: contextSnippet(source, q),
        highlight: boldMatch(contextSnippet(source, q), q),
      });
    }
  }

  if (scope === 'all' || scope === 'messages') {
    const rows = await prisma.node.findMany({
      where: { content: { contains: q, mode: 'insensitive' } },
      orderBy: { createdAt: 'desc' },
      take,
      select: { id: true, conversationId: true, content: true, role: true },
    });
    for (const r of rows) {
      hits.push({
        scope: 'messages',
        id: r.id,
        title: `${r.role === 'asst' ? 'Assistant' : 'User'} in ${r.conversationId}`,
        snippet: contextSnippet(r.content, q),
        highlight: boldMatch(contextSnippet(r.content, q), q),
      });
    }
  }

  if (scope === 'all' || scope === 'agents') {
    const rows = await prisma.agent.findMany({
      where: {
        deletedAt: null,
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { description: { contains: q, mode: 'insensitive' } },
          { systemPrompt: { contains: q, mode: 'insensitive' } },
        ],
      },
      orderBy: { name: 'asc' },
      take,
      select: {
        id: true,
        name: true,
        description: true,
        systemPrompt: true,
      },
    });
    for (const r of rows) {
      const source = [r.name, r.description, r.systemPrompt].join('\n');
      hits.push({
        scope: 'agents',
        id: r.id,
        title: r.name,
        snippet: contextSnippet(source, q),
        highlight: boldMatch(contextSnippet(source, q), q),
      });
    }
  }

  return c.json({ query: q, scope, hits });
});
