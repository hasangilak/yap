import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, expectOk, jsonReq } from '../helpers/app.js';
import { disconnectDb, truncateAll } from '../helpers/db.js';

const app = buildTestApp({ skipAuth: true, skipRateLimit: true, skipIdempotency: true });

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await disconnectDb();
});

async function createAgent(body: Record<string, unknown> = { name: 'T' }): Promise<{
  id: string;
  current_version_id: string | null;
  temperature: number;
  name: string;
  system_prompt: string;
}> {
  return (await expectOk(await jsonReq(app, 'POST', '/api/v1/agents', body))) as never;
}

describe('agents CRUD', () => {
  it('POST creates agent with v1 and returns full shape', async () => {
    const a = await createAgent({ name: 'Alpha', desc: 'first', temperature: 0.3 });
    expect(a.id).toMatch(/^a-/);
    expect(a.current_version_id).toMatch(/^av-/);
    expect(a.temperature).toBe(0.3);
  });

  it('GET /agents returns thin 7-field wire shape (not current_version_id)', async () => {
    await createAgent({ name: 'X' });
    const list = (await expectOk(
      await jsonReq(app, 'GET', '/api/v1/agents'),
    )) as Array<{ id: string; current_version_id?: unknown }>;
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty('current_version_id');
  });

  it('GET /agents/:id returns thin shape', async () => {
    const a = await createAgent({ name: 'B' });
    const r = (await expectOk(
      await jsonReq(app, 'GET', `/api/v1/agents/${a.id}`),
    )) as { id: string; tools: number };
    expect(r.id).toBe(a.id);
    expect(typeof r.tools).toBe('number');
  });

  it('GET /agents/:id/full returns the editable shape', async () => {
    const a = await createAgent({ name: 'Full', system_prompt: 'p' });
    const full = (await expectOk(
      await jsonReq(app, 'GET', `/api/v1/agents/${a.id}/full`),
    )) as { system_prompt: string };
    expect(full.system_prompt).toBe('p');
  });

  it('PATCH appends a new version and updates current_version_id', async () => {
    const a = await createAgent({ name: 'P', temperature: 0.5 });
    const first = (await expectOk(
      await jsonReq(app, 'PATCH', `/api/v1/agents/${a.id}`, {
        temperature: 0.9,
        message: 'hot',
      }),
    )) as {
      agent: { temperature: number; current_version_id: string };
      version: { version: number; message: string };
    };
    expect(first.agent.temperature).toBe(0.9);
    expect(first.version.version).toBe(2);
    expect(first.version.message).toBe('hot');
  });

  it('DELETE soft-deletes — agent disappears from listing but versions survive', async () => {
    const a = await createAgent({ name: 'Goner' });
    await expectOk(await jsonReq(app, 'DELETE', `/api/v1/agents/${a.id}`));
    const list = (await expectOk(
      await jsonReq(app, 'GET', '/api/v1/agents'),
    )) as Array<{ id: string }>;
    expect(list.some((x) => x.id === a.id)).toBe(false);
  });
});

describe('agent versions + restore + diff', () => {
  it('lists versions newest-first', async () => {
    const a = await createAgent({ name: 'V', system_prompt: 'v1' });
    await jsonReq(app, 'PATCH', `/api/v1/agents/${a.id}`, { system_prompt: 'v2' });
    await jsonReq(app, 'PATCH', `/api/v1/agents/${a.id}`, { system_prompt: 'v3' });
    const vs = (await expectOk(
      await jsonReq(app, 'GET', `/api/v1/agents/${a.id}/versions`),
    )) as Array<{ version: number }>;
    expect(vs.map((x) => x.version)).toEqual([3, 2, 1]);
  });

  it('restores an old version by writing a new one with its snapshot', async () => {
    const a = await createAgent({ name: 'R', system_prompt: 'p1' });
    await jsonReq(app, 'PATCH', `/api/v1/agents/${a.id}`, { system_prompt: 'p2' });
    const restored = (await expectOk(
      await jsonReq(app, 'POST', `/api/v1/agents/${a.id}/versions/1/restore`, {}),
    )) as { agent: { system_prompt: string }; version: { version: number; message: string } };
    expect(restored.agent.system_prompt).toBe('p1');
    expect(restored.version.version).toBe(3);
    expect(restored.version.message).toMatch(/Restore of v1/);
  });

  it('diff returns changed_fields for two versions', async () => {
    const a = await createAgent({ name: 'D', system_prompt: 'a', temperature: 0.2 });
    await jsonReq(app, 'PATCH', `/api/v1/agents/${a.id}`, {
      system_prompt: 'b',
      temperature: 0.9,
    });
    const diff = (await expectOk(
      await jsonReq(app, 'GET', `/api/v1/agents/${a.id}/versions/1/diff?against=2`),
    )) as { changed_fields: string[] };
    expect(diff.changed_fields.sort()).toEqual(['system_prompt', 'temperature']);
  });
});

describe('agent templates + stubs', () => {
  it('GET /agent-templates returns the catalog', async () => {
    const rows = (await expectOk(
      await jsonReq(app, 'GET', '/api/v1/agent-templates'),
    )) as Array<{ id: string }>;
    expect(rows.map((r) => r.id).sort()).toEqual([
      'code-reviewer',
      'data-analyst',
      'researcher',
      'socratic-tutor',
    ]);
  });

  it('instantiate from template creates an agent', async () => {
    const a = (await expectOk(
      await jsonReq(app, 'POST', '/api/v1/agents/from-template/socratic-tutor', {}),
    )) as { id: string; name: string };
    expect(a.name).toBe('Socratic Tutor');
  });

  it('unknown template → 404', async () => {
    const res = await jsonReq(app, 'POST', '/api/v1/agents/from-template/ghost', {});
    expect(res.status).toBe(404);
  });

  it('optimize stub returns a canned suggestion shape', async () => {
    const a = await createAgent({ name: 'Opt' });
    const r = (await expectOk(
      await jsonReq(app, 'POST', `/api/v1/agents/${a.id}/optimize`, {}),
    )) as { suggestion: { predicted_delta_pct: number; applies_to: string } };
    expect(r.suggestion.applies_to).toBe('system_prompt');
    expect(typeof r.suggestion.predicted_delta_pct).toBe('number');
  });

  it('eval run + fetch stub round-trip', async () => {
    const a = await createAgent({ name: 'E' });
    const run = (await expectOk(
      await jsonReq(app, 'POST', `/api/v1/agents/${a.id}/eval/run`, {}),
    )) as { job_id: string };
    expect(run.job_id).toMatch(/^ev-/);
    const fetched = (await expectOk(
      await jsonReq(app, 'GET', `/api/v1/agents/${a.id}/eval/runs/${run.job_id}`),
    )) as { cases: unknown[]; pass_rate: number };
    expect(Array.isArray(fetched.cases)).toBe(true);
    expect(typeof fetched.pass_rate).toBe('number');
  });
});
