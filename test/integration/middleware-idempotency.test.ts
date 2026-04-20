import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, jsonReq } from '../helpers/app.js';
import { disconnectDb, truncateAll } from '../helpers/db.js';
import { getPrisma } from '../../src/db/index.js';

// Full middleware chain on for these tests: auth is off (no token),
// rate limit is effectively disabled by the generous RPM default,
// idempotency is on.
const app = buildTestApp({ skipAuth: true, skipRateLimit: true });

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await disconnectDb();
});

describe('idempotency middleware', () => {
  it('replays cached response when the same Idempotency-Key is used twice', async () => {
    const first = await jsonReq(app, 'POST', '/api/v1/tags', { name: 'urgent' }, {
      'Idempotency-Key': 'k1',
    });
    expect(first.status).toBe(201);
    const firstBody = await first.text();
    const second = await jsonReq(app, 'POST', '/api/v1/tags', { name: 'urgent' }, {
      'Idempotency-Key': 'k1',
    });
    expect(second.headers.get('X-Idempotent-Replay')).toBe('true');
    expect(await second.text()).toBe(firstBody);

    // Only one tag row — no double side-effect.
    const count = await getPrisma().tag.count();
    expect(count).toBe(1);
  });

  it('different keys do NOT replay — each request runs fresh', async () => {
    await jsonReq(app, 'POST', '/api/v1/tags', { name: 'a' }, { 'Idempotency-Key': 'ka' });
    await jsonReq(app, 'POST', '/api/v1/tags', { name: 'b' }, { 'Idempotency-Key': 'kb' });
    const count = await getPrisma().tag.count();
    expect(count).toBe(2);
  });

  it('different path with same key runs fresh (key is per-path)', async () => {
    // First request creates tag.
    await jsonReq(app, 'POST', '/api/v1/tags', { name: 'same-key' }, {
      'Idempotency-Key': 'shared',
    });
    // Second request, different path, same key — must run.
    const conv = await jsonReq(app, 'POST', '/api/v1/conversations', { title: 'x' }, {
      'Idempotency-Key': 'shared',
    });
    // 400 is expected (no agent seeded), but not a replay — header
    // should NOT be X-Idempotent-Replay because path differs.
    expect(conv.headers.get('X-Idempotent-Replay')).toBeNull();
  });

  it('GET requests are not memoized', async () => {
    await jsonReq(app, 'GET', '/api/v1/conversations', undefined, {
      'Idempotency-Key': 'kg',
    });
    const second = await jsonReq(app, 'GET', '/api/v1/conversations', undefined, {
      'Idempotency-Key': 'kg',
    });
    expect(second.headers.get('X-Idempotent-Replay')).toBeNull();
  });

  it('error responses are not cached', async () => {
    // POST /conversations with no agent seeded → 400
    const first = await jsonReq(app, 'POST', '/api/v1/conversations', { title: 'x' }, {
      'Idempotency-Key': 'kerr',
    });
    expect(first.status).toBe(400);
    // Seed an agent, then retry — should run fresh (not replay 400).
    await (await import('../../src/db/queries.js')).insertAgent({
      id: 'a-i',
      name: 'N',
      initial: 'N',
      description: '',
      model: 'qwen2.5:14b',
    });
    const second = await jsonReq(app, 'POST', '/api/v1/conversations', { title: 'y' }, {
      'Idempotency-Key': 'kerr',
    });
    expect(second.status).toBe(201);
    expect(second.headers.get('X-Idempotent-Replay')).toBeNull();
  });
});
