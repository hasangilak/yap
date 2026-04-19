import type { MiddlewareHandler } from 'hono';
import { config } from '../../config.js';

/**
 * Bearer-token auth for /api/v1/*. When YAP_API_TOKEN is unset the
 * middleware is a no-op so dev / localhost UX is unchanged; when set,
 * every request must carry Authorization: Bearer <token>.
 *
 * Exceptions: /api/v1/shared/:token is public by design — share links
 * are consumed without auth, the token on the URL IS the credential.
 */
export const bearerAuth: MiddlewareHandler = async (c, next) => {
  const expected = config.apiToken;
  if (!expected) return next();

  const path = c.req.path;
  if (path.startsWith('/api/v1/shared/')) return next();

  const header = c.req.header('Authorization') ?? '';
  const m = header.match(/^Bearer\s+(.+)$/);
  if (!m || m[1] !== expected) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  return next();
};
