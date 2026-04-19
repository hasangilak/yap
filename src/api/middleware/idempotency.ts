import type { MiddlewareHandler } from 'hono';
import { getPrisma } from '../../db/index.js';

const TTL_MS = 24 * 60 * 60 * 1000;
const CACHED_METHODS = new Set(['POST', 'PATCH', 'DELETE']);

/**
 * Idempotency-Key middleware. On a mutating request (POST/PATCH/DELETE)
 * carrying an Idempotency-Key header, look up any matching record from
 * the last 24h and replay the stored response; otherwise run the
 * handler and cache the first 2xx/3xx response keyed by
 * (key, method, path).
 *
 * Streaming responses (SSE) aren't cached — they're captured as the
 * terminal string which is rarely useful. The middleware skips them by
 * checking Content-Type after the handler runs.
 */
export const idempotency: MiddlewareHandler = async (c, next) => {
  const key = c.req.header('Idempotency-Key');
  if (!key) return next();
  if (!CACHED_METHODS.has(c.req.method)) return next();

  const prisma = getPrisma();
  const now = Date.now();
  const since = new Date(now - TTL_MS);

  const cached = await prisma.idempotencyRecord.findUnique({
    where: {
      key_method_path: { key, method: c.req.method, path: c.req.path },
    },
  });
  if (cached && cached.createdAt >= since) {
    c.header('X-Idempotent-Replay', 'true');
    c.header('Content-Type', cached.contentType);
    return c.body(cached.body, cached.status as 200);
  }

  await next();

  const res = c.res;
  if (!res) return;
  if (res.status < 200 || res.status >= 400) return;
  const contentType = res.headers.get('Content-Type') ?? 'application/json';
  if (contentType.includes('text/event-stream')) return;

  // Clone before reading so the original response still flows to the
  // client. Discard errors silently — idempotency bookkeeping
  // shouldn't crash a successful request.
  try {
    const body = await res.clone().text();
    await prisma.idempotencyRecord.upsert({
      where: {
        key_method_path: { key, method: c.req.method, path: c.req.path },
      },
      update: {},
      create: {
        key,
        method: c.req.method,
        path: c.req.path,
        status: res.status,
        contentType,
        body,
      },
    });
  } catch (err) {
    console.error('[idempotency]', err);
  }
};
