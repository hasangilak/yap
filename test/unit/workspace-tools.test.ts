import {
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import {
  readWorkspaceFile,
  runWorkspaceTests,
} from '../../src/tools/workspace.js';

describe('linked workspace tools', () => {
  const root = mkdtempSync(join(tmpdir(), 'yap-workspace-'));
  const outside = mkdtempSync(join(tmpdir(), 'yap-outside-'));
  const originalRoot = config.workspaceDir;
  const originalReadLimit = config.workspaceReadMaxBytes;

  beforeAll(() => {
    (config as { workspaceDir: string | null }).workspaceDir = root;
    (config as { workspaceReadMaxBytes: number }).workspaceReadMaxBytes = 32;
    writeFileSync(join(root, 'inside.txt'), 'workspace contents');
    writeFileSync(join(root, 'large.txt'), 'x'.repeat(33));
    writeFileSync(join(outside, 'secret.txt'), 'outside');
    symlinkSync(join(outside, 'secret.txt'), join(root, 'linked-secret.txt'));
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        scripts: {
          test: "node -e \"console.log('workspace-tests-ok')\"",
        },
      }),
    );
  });

  afterAll(() => {
    (config as { workspaceDir: string | null }).workspaceDir = originalRoot;
    (config as { workspaceReadMaxBytes: number }).workspaceReadMaxBytes =
      originalReadLimit;
  });

  it('reads a relative file inside the linked root', async () => {
    await expect(readWorkspaceFile('inside.txt')).resolves.toBe(
      'workspace contents',
    );
  });

  it('rejects traversal and symlink escapes', async () => {
    await expect(readWorkspaceFile('../secret.txt')).rejects.toThrow(/escapes/);
    await expect(readWorkspaceFile('linked-secret.txt')).rejects.toThrow(/escapes/);
  });

  it('rejects files above the configured byte limit', async () => {
    await expect(readWorkspaceFile('large.txt')).rejects.toThrow(/limit is 32/);
  });

  it('runs only the package test script', async () => {
    await expect(runWorkspaceTests()).resolves.toContain('workspace-tests-ok');
  });
});
