import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { config } from '../config.js';

const require = createRequire(import.meta.url);
const CHROME_LESS_CLI =
  config.chromeLessBin || require.resolve('chrome-less/dist/cli.js');

/**
 * The env handed to the browser subprocess.
 *
 * This is an allowlist, not `{...process.env}`: the child drives a real
 * Chromium over untrusted third-party pages, and the renderer sandbox may
 * be disabled in container builds (see CHROME_NO_SANDBOX in the
 * Dockerfile). Passing yap's own environment would hand DATABASE_URL and
 * YAP_API_TOKEN to a compromised renderer. Only process-level plumbing
 * gets through — HOME because chrome-less keeps its Chrome profile under
 * `~/.chrome-less`, and CHROME_LESS_CHROME to pick the browser binary.
 */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '' };
  if (process.env.HOME) env.HOME = process.env.HOME;
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  if (config.chromeLessChrome) env.CHROME_LESS_CHROME = config.chromeLessChrome;
  return env;
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function run(args: string[]): Promise<RunResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn('node', [CHROME_LESS_CLI, ...args], {
      env: childEnv(),
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('error', rejectPromise);
    proc.on('close', (code) => {
      resolvePromise({ stdout, stderr, exitCode: code ?? 0 });
    });
  });
}

async function runOrThrow(args: string[]): Promise<void> {
  const result = await run(args);
  if (result.exitCode !== 0) {
    const msg = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
    throw new Error(`chrome-less ${args[0]}: ${msg}`);
  }
}

async function currentPage(): Promise<string> {
  const result = await run(['text']);
  if (result.exitCode !== 0) {
    const msg = result.stderr.trim() || result.stdout.trim();
    throw new Error(`chrome-less text: ${msg}`);
  }
  return result.stdout.trim();
}

export async function webSearch(query: string): Promise<string> {
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
  await runOrThrow(['goto', url]);
  return currentPage();
}

export async function webGoto(url: string): Promise<string> {
  await runOrThrow(['goto', url]);
  return currentPage();
}

export async function webClick(elementId: number): Promise<string> {
  await runOrThrow(['click', String(elementId)]);
  return currentPage();
}

export async function webType(
  elementId: number,
  text: string,
  submit: boolean,
): Promise<string> {
  const args = ['type', String(elementId), text];
  if (submit) args.push('--submit');
  await runOrThrow(args);
  return currentPage();
}

export async function webBack(): Promise<string> {
  await runOrThrow(['back']);
  return currentPage();
}
