import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { bearerAuth } from '../../src/api/middleware/auth.js';
import { config } from '../../src/config.js';

function makeApp(): Hono {
  const app = new Hono();
  app.use('/api/v1/*', bearerAuth);
  app.get('/api/v1/thing', (c) => c.json({ ok: true }));
  app.get('/api/v1/shared/:token', (c) => c.json({ public: true }));
  return app;
}

describe('bearerAuth middleware', () => {
  const originalToken = config.apiToken;
  afterEach(() => {
    (config as { apiToken: string }).apiToken = originalToken;
  });

  it('is a no-op when YAP_API_TOKEN is unset', async () => {
    (config as { apiToken: string }).apiToken = '';
    const res = await makeApp().fetch(new Request('http://x/api/v1/thing'));
    expect(res.status).toBe(200);
  });

  it('rejects missing Authorization with 401', async () => {
    (config as { apiToken: string }).apiToken = 'secret';
    const res = await makeApp().fetch(new Request('http://x/api/v1/thing'));
    expect(res.status).toBe(401);
  });

  it('rejects wrong bearer with 401', async () => {
    (config as { apiToken: string }).apiToken = 'secret';
    const res = await makeApp().fetch(
      new Request('http://x/api/v1/thing', {
        headers: { Authorization: 'Bearer nope' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('rejects non-bearer schemes with 401', async () => {
    (config as { apiToken: string }).apiToken = 'secret';
    const res = await makeApp().fetch(
      new Request('http://x/api/v1/thing', {
        headers: { Authorization: 'Basic secret' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('accepts correct bearer token', async () => {
    (config as { apiToken: string }).apiToken = 'secret';
    const res = await makeApp().fetch(
      new Request('http://x/api/v1/thing', {
        headers: { Authorization: 'Bearer secret' },
      }),
    );
    expect(res.status).toBe(200);
  });

  it('lets /api/v1/shared/:token through without auth (public)', async () => {
    (config as { apiToken: string }).apiToken = 'secret';
    const res = await makeApp().fetch(new Request('http://x/api/v1/shared/abc'));
    expect(res.status).toBe(200);
  });
});
