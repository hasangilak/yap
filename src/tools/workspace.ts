import { execFile } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.js';

const execFileAsync = promisify(execFile);

export function inspectLinkedWorkspace(): {
  readable: boolean;
  hasTestScript: boolean;
} {
  if (!config.workspaceDir) return { readable: false, hasTestScript: false };
  try {
    const root = realpathSync(config.workspaceDir);
    if (!statSync(root).isDirectory()) {
      return { readable: false, hasTestScript: false };
    }
    try {
      const pkg = JSON.parse(
        readFileSync(resolve(root, 'package.json'), 'utf8'),
      ) as { scripts?: { test?: unknown } };
      return {
        readable: true,
        hasTestScript:
          typeof pkg.scripts?.test === 'string' && !!pkg.scripts.test.trim(),
      };
    } catch {
      return { readable: true, hasTestScript: false };
    }
  } catch {
    return { readable: false, hasTestScript: false };
  }
}

async function linkedWorkspaceRoot(): Promise<string> {
  if (!config.workspaceDir) {
    throw new Error('no workspace linked; set WORKSPACE_DIR on the Yap server');
  }
  const root = await realpath(config.workspaceDir);
  const info = await stat(root);
  if (!info.isDirectory()) throw new Error('WORKSPACE_DIR is not a directory');
  return root;
}

function assertRelativePath(path: string): void {
  if (
    !path ||
    isAbsolute(path) ||
    path.startsWith('~') ||
    path.split(/[\\/]/).some((segment) => segment === '..')
  ) {
    throw new Error(`path '${path}' escapes the linked workspace`);
  }
}

function assertInside(root: string, target: string): void {
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw new Error('resolved path escapes the linked workspace');
  }
}

export async function readWorkspaceFile(path: string): Promise<string> {
  const clean = path.trim();
  assertRelativePath(clean);
  const root = await linkedWorkspaceRoot();
  const target = await realpath(resolve(root, clean));
  assertInside(root, target);
  const info = await stat(target);
  if (!info.isFile()) throw new Error(`'${clean}' is not a file`);
  if (info.size > config.workspaceReadMaxBytes) {
    throw new Error(
      `'${clean}' is ${info.size} bytes; limit is ${config.workspaceReadMaxBytes}`,
    );
  }
  return readFile(target, 'utf8');
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function testCommand(root: string): Promise<[string, string[]]> {
  const raw = await readFile(resolve(root, 'package.json'), 'utf8');
  const pkg = JSON.parse(raw) as { scripts?: { test?: unknown } };
  if (typeof pkg.scripts?.test !== 'string' || !pkg.scripts.test.trim()) {
    throw new Error('linked workspace has no package.json test script');
  }
  if (await exists(resolve(root, 'pnpm-lock.yaml'))) return ['pnpm', ['test']];
  if (await exists(resolve(root, 'yarn.lock'))) return ['yarn', ['test']];
  if (
    (await exists(resolve(root, 'bun.lock'))) ||
    (await exists(resolve(root, 'bun.lockb')))
  ) {
    return ['bun', ['run', 'test']];
  }
  return ['npm', ['test']];
}

function testEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    CI: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  };
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function outputFrom(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return '';
}

export async function runWorkspaceTests(): Promise<string> {
  const root = await linkedWorkspaceRoot();
  const [command, args] = await testCommand(root);
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: root,
      env: testEnvironment(),
      timeout: config.workspaceTestTimeoutMs,
      maxBuffer: config.workspaceTestMaxOutputBytes,
      encoding: 'utf8',
    });
    const output = [outputFrom(stdout), outputFrom(stderr)]
      .filter(Boolean)
      .join('\n')
      .trim();
    return output || `${command} ${args.join(' ')} passed`;
  } catch (error) {
    const detail = error as {
      message?: string;
      stdout?: unknown;
      stderr?: unknown;
      killed?: boolean;
    };
    const output = [outputFrom(detail.stdout), outputFrom(detail.stderr)]
      .filter(Boolean)
      .join('\n')
      .trim();
    const reason = detail.killed
      ? `test command exceeded ${config.workspaceTestTimeoutMs}ms`
      : detail.message ?? 'test command failed';
    throw new Error(output ? `${reason}\n${output}` : reason);
  }
}
