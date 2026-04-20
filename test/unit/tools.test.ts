import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import {
  executeTool,
  isSideEffectful,
  OLLAMA_TOOLS,
  TOOL_DEFS,
} from '../../src/registry/tools.js';

describe('tool registry', () => {
  it('ships all 7 client-shaped tool defs with enabled/auto flags', () => {
    const ids = TOOL_DEFS.map((t) => t.id).sort();
    expect(ids).toEqual([
      'read_file',
      'run_tests',
      'send_email',
      'sql_query',
      'web_fetch',
      'web_search',
      'write_file',
    ]);
    const autoTrue = TOOL_DEFS.filter((t) => t.auto).map((t) => t.id).sort();
    expect(autoTrue).toEqual(['run_tests', 'web_search']);
  });

  it('advertises web_search and write_file to Ollama', () => {
    const names = OLLAMA_TOOLS.map((t) => t.function.name).sort();
    expect(names).toEqual(['ask_clarification', 'web_search', 'write_file']);
  });

  it('marks write_file / run_tests / send_email as side-effectful', () => {
    expect(isSideEffectful('write_file')).toBe(true);
    expect(isSideEffectful('run_tests')).toBe(true);
    expect(isSideEffectful('send_email')).toBe(true);
    expect(isSideEffectful('web_search')).toBe(false);
    expect(isSideEffectful('read_file')).toBe(false);
  });
});

describe('executeTool sandbox (write_file)', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'yap-sandbox-'));
  const originalDir = config.artifactsDir;

  // Rewriting the exported config at runtime — tests are the one
  // place this is fine.
  (config as { artifactsDir: string }).artifactsDir = sandbox;

  it('writes a simple file inside the sandbox', async () => {
    const r = await executeTool('write_file', { path: 'ok.txt', content: 'hello' });
    expect(r.status).toBe('ok');
    expect(r.result).toMatch(/ok\.txt/);
  });

  it('rejects absolute paths', async () => {
    const r = await executeTool('write_file', { path: '/etc/passwd', content: 'x' });
    expect(r.status).toBe('err');
    expect(r.error).toMatch(/escapes the artifacts sandbox/);
  });

  it('rejects .. traversal', async () => {
    const r = await executeTool('write_file', { path: '../secret.txt', content: 'x' });
    expect(r.status).toBe('err');
    expect(r.error).toMatch(/escapes the artifacts sandbox/);
  });

  it('rejects nested .. inside otherwise-valid paths', async () => {
    const r = await executeTool('write_file', { path: 'foo/../../etc/passwd', content: 'x' });
    expect(r.status).toBe('err');
  });

  it('rejects home-dir expansion', async () => {
    const r = await executeTool('write_file', { path: '~/.bashrc', content: 'x' });
    expect(r.status).toBe('err');
  });

  it('rejects empty path', async () => {
    const r = await executeTool('write_file', { path: '', content: 'x' });
    expect(r.status).toBe('err');
  });

  it('unknown tool returns err', async () => {
    const r = await executeTool('nope', {});
    expect(r.status).toBe('err');
    expect(r.error).toMatch(/not implemented/);
  });

  // Restore after this file's tests — doesn't matter for parallel
  // execution because the config is a singleton and we force
  // single-thread in vitest.config.ts.
  (config as { artifactsDir: string }).artifactsDir = originalDir;
});
