import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { rateLimit } from '../../src/api/middleware/rate-limit.js';
import { config } from '../../src/config.js';

function makeApp(): Hono {
  const app = new Hono();
  app.use('/api/v1/*', rateLimit);
  app.get('/api/v1/thing', (c) => c.json({ ok: true }));
  app.get('/api/v1/shared/:token', (c) => c.json({ public: true }));
  return app;
}

async function hit(app: Hono, headers: Record<string, string> = {}): Promise<Response> {
  return app.fetch(new Request('http://x/api/v1/thing', { headers }));
}

describe('rateLimit middleware', () => {
  const originalRpm = config.rateLimitRpm;
  afterEach(() => {
    (config as { rateLimitRpm: number }).rateLimitRpm = originalRpm;
  });

  it('allows traffic up to the cap then returns 429 with Retry-After', async () => {
    (config as { rateLimitRpm: number }).rateLimitRpm = 3;
    const app = makeApp();
    // Unique bearer per test so buckets don't bleed between cases.
    const headers = { Authorization: 'Bearer cap-test-1' };
    expect((await hit(app, headers)).status).toBe(200);
    expect((await hit(app, headers)).status).toBe(200);
    expect((await hit(app, headers)).status).toBe(200);
    const blocked = await hit(app, headers);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(blocked.headers.get('X-RateLimit-Remaining')).toBe('0');
  });

  it('separate identities get separate buckets', async () => {
    (config as { rateLimitRpm: number }).rateLimitRpm = 1;
    const app = makeApp();
    // bearer-a uses its one allowance here.
    expect(
      (await hit(app, { Authorization: 'Bearer bucket-a' })).status,
    ).toBe(200);
    // bearer-b should still have its own allowance.
    expect(
      (await hit(app, { Authorization: 'Bearer bucket-b' })).status,
    ).toBe(200);
    // bearer-a is now out.
    expect(
      (await hit(app, { Authorization: 'Bearer bucket-a' })).status,
    ).toBe(429);
  });

  it('uses X-Forwarded-For as identity when no bearer present', async () => {
    (config as { rateLimitRpm: number }).rateLimitRpm = 1;
    const app = makeApp();
    expect((await hit(app, { 'X-Forwarded-For': '203.0.113.7' })).status).toBe(200);
    expect((await hit(app, { 'X-Forwarded-For': '203.0.113.7' })).status).toBe(429);
    // Different IP — still has its allowance.
    expect((await hit(app, { 'X-Forwarded-For': '203.0.113.8' })).status).toBe(200);
  });

  it('/api/v1/shared/:token bypasses the limit', async () => {
    (config as { rateLimitRpm: number }).rateLimitRpm = 1;
    const app = makeApp();
    // Force the /thing endpoint into 429.
    await hit(app, { Authorization: 'Bearer shared-test' });
    // Now hammer /shared/:token — should still return 200.
    for (let i = 0; i < 5; i++) {
      const r = await app.fetch(
        new Request('http://x/api/v1/shared/xyz', {
          headers: { Authorization: 'Bearer shared-test' },
        }),
      );
      expect(r.status).toBe(200);
    }
  });
});
