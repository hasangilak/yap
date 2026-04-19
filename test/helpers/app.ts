import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { apiV1 } from '../../src/api/index.js';
import { bearerAuth } from '../../src/api/middleware/auth.js';
import { idempotency } from '../../src/api/middleware/idempotency.js';
import { rateLimit } from '../../src/api/middleware/rate-limit.js';

/**
 * Build a fresh Hono app identical to the real server (minus the
 * legacy POST / and /health, which aren't under /api/v1). Caller
 * can omit middleware with `{ skipAuth: true, skipRateLimit: true,
 * skipIdempotency: true }` so endpoint tests don't have to pretend
 * to pass through the full stack.
 */
export function buildTestApp(opts: {
  skipAuth?: boolean;
  skipRateLimit?: boolean;
  skipIdempotency?: boolean;
} = {}): Hono {
  const app = new Hono();
  app.use('*', cors());
  if (!opts.skipAuth) app.use('/api/v1/*', bearerAuth);
  if (!opts.skipRateLimit) app.use('/api/v1/*', rateLimit);
  if (!opts.skipIdempotency) app.use('/api/v1/*', idempotency);
  app.route('/api/v1', apiV1);
  return app;
}

/** JSON helper with sane defaults for tests. */
export async function jsonReq(
  app: Hono,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

export async function expectOk(res: Response): Promise<unknown> {
  if (res.status >= 400) {
    const body = await res.text();
    throw new Error(`expected 2xx, got ${res.status}: ${body}`);
  }
  return res.json();
}
