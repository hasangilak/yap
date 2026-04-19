import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { Tool } from 'ollama';
import { config } from '../config.js';
import { webSearch } from '../tools/browser.js';
import type { ToolDef } from '../schemas/index.js';

/**
 * The static tool registry. Shapes match chat-box's SAMPLE_TOOLS exactly:
 * the client renders id/name/desc + an enabled + auto flag per tool.
 * `enabled: false` tools are displayed but not selectable; `auto: true`
 * means the agent may auto-approve them (Phase 2 enforces).
 */
export const TOOL_DEFS: ToolDef[] = [
  {
    id: 'read_file',
    name: 'read_file',
    desc: 'Read a file from the linked repo.',
    enabled: true,
    auto: false,
  },
  {
    id: 'write_file',
    name: 'write_file',
    desc: 'Write or edit a file. Requires approval.',
    enabled: true,
    auto: false,
  },
  {
    id: 'run_tests',
    name: 'run_tests',
    desc: 'Execute the test suite; returns pass/fail + logs.',
    enabled: true,
    auto: true,
  },
  {
    id: 'web_search',
    name: 'web_search',
    desc: 'Search the web for recent info.',
    enabled: true,
    auto: true,
  },
  {
    id: 'web_fetch',
    name: 'web_fetch',
    desc: 'Fetch a URL and return its text content.',
    enabled: false,
    auto: false,
  },
  {
    id: 'sql_query',
    name: 'sql_query',
    desc: 'Run a read-only SQL query against the warehouse.',
    enabled: false,
    auto: false,
  },
  {
    id: 'send_email',
    name: 'send_email',
    desc: 'Send an email on your behalf. Always asks first.',
    enabled: false,
    auto: false,
  },
];

/**
 * Ollama function-calling schemas injected into chat() so the model can
 * request a tool. Only read-only tools with a real Phase 1 implementation
 * are advertised — side-effect tools live in Phase 2.
 */
export const OLLAMA_TOOLS: Tool[] = [
  {
    type: 'function' as const,
    function: {
      name: 'web_search',
      description:
        'Search the web via DuckDuckGo and return the results as a numbered accessibility tree. Use this as your first step whenever you need current information, a source to cite, or facts you are not highly confident about.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'write_file',
      description:
        'Write a text file to the sandboxed artifacts directory. Use for code, drafts, notes, and anything the user should be able to keep after the turn. Requires user approval unless the agent has auto_allow_all set.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Relative path under the artifacts dir. Must not contain ".." segments or start with /. Directories are created automatically.',
          },
          content: {
            type: 'string',
            description: 'The file contents to write.',
          },
        },
        required: ['path', 'content'],
      },
    },
  },
];

export interface ToolExecResult {
  status: 'ok' | 'err';
  elapsed_ms: number;
  result?: string;
  error?: string;
}

/**
 * Dispatch a tool call. Phase 1 implements web_search only; every other
 * tool returns a clear not-implemented error so the model can recover.
 * PHASE-2: side-effect tools (write_file, run_tests, send_email) must
 * route through approval before reaching this function.
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolExecResult> {
  const start = Date.now();
  try {
    if (name === 'web_search') {
      const query = String(args.query ?? '').trim();
      if (!query) {
        return { status: 'err', elapsed_ms: 0, error: 'web_search requires a non-empty "query" argument' };
      }
      const result = await webSearch(query);
      return { status: 'ok', elapsed_ms: Date.now() - start, result };
    }
    if (name === 'write_file') {
      const rawPath = String(args.path ?? '').trim();
      const content = String(args.content ?? '');
      if (!rawPath) {
        return { status: 'err', elapsed_ms: 0, error: 'write_file requires a non-empty "path" argument' };
      }
      if (isAbsolute(rawPath) || rawPath.startsWith('~') || rawPath.split(/[\\/]/).some((s) => s === '..')) {
        return { status: 'err', elapsed_ms: 0, error: `path '${rawPath}' escapes the artifacts sandbox` };
      }
      const full = resolve(config.artifactsDir, rawPath);
      // Defensive: after resolution, full must still be under artifactsDir.
      if (relative(config.artifactsDir, full).startsWith('..')) {
        return { status: 'err', elapsed_ms: 0, error: `path '${rawPath}' escapes the artifacts sandbox` };
      }
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content, 'utf8');
      const bytes = Buffer.byteLength(content, 'utf8');
      return {
        status: 'ok',
        elapsed_ms: Date.now() - start,
        result: `✓ wrote ${rawPath} (${bytes} bytes)`,
      };
    }
    return {
      status: 'err',
      elapsed_ms: Date.now() - start,
      error: `tool '${name}' is not implemented yet`,
    };
  } catch (err) {
    return {
      status: 'err',
      elapsed_ms: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Tools whose execution has visible side effects (writes, sends,
 * executes). Phase 1 auto-approves read-only tools; Phase 2 will gate
 * these behind an approval.requested / approval.decided round-trip.
 */
export function isSideEffectful(toolName: string): boolean {
  return ['write_file', 'run_tests', 'send_email'].includes(toolName);
}
