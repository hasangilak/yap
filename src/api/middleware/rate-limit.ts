import type { MiddlewareHandler } from 'hono';
import { config } from '../../config.js';

/**
 * Simple in-memory sliding-window rate limiter. Keyed by bearer token
 * when one is present, otherwise by X-Forwarded-For (for reverse-
 * proxy deploys) or a constant 'anon' (single-user dev). Evicted
 * timestamps are pruned on every request so the map stays bounded.
 *
 * A later phase can swap the in-memory Map for Redis; the contract
 * is one call per request into `allow(identity, limit)`.
 */

const windows = new Map<string, number[]>();
const WINDOW_MS = 60_000;

function allow(identity: string, limit: number): { allowed: boolean; retry_after_s: number } {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const ts = (windows.get(identity) ?? []).filter((t) => t > cutoff);
  if (ts.length >= limit) {
    const oldest = ts[0]!;
    return { allowed: false, retry_after_s: Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000)) };
  }
  ts.push(now);
  windows.set(identity, ts);
  return { allowed: true, retry_after_s: 0 };
}

function identityOf(c: { req: { header: (k: string) => string | undefined } }): string {
  const auth = c.req.header('Authorization');
  if (auth) return `bearer:${auth.slice(0, 32)}`;
  const xff = c.req.header('X-Forwarded-For');
  if (xff) return `ip:${xff.split(',')[0]!.trim()}`;
  return 'anon';
}

export const rateLimit: MiddlewareHandler = async (c, next) => {
  // Public share reads bypass the rate limit — they're cache-friendly
  // and the cap there is mostly handled by CDN / front proxy.
  if (c.req.path.startsWith('/api/v1/shared/')) return next();

  const { allowed, retry_after_s } = allow(identityOf(c), config.rateLimitRpm);
  if (!allowed) {
    c.header('Retry-After', String(retry_after_s));
    c.header('X-RateLimit-Remaining', '0');
    return c.json({ error: 'rate limit exceeded', retry_after_s }, 429);
  }
  return next();
};
