import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { Tool } from 'ollama';
import { config } from '../config.js';
import { webSearch } from '../tools/browser.js';
import { readWorkspaceFile, runWorkspaceTests } from '../tools/workspace.js';
import type { ToolDef } from '../schemas/index.js';

const workspaceLinked = config.workspaceDir !== null;

/**
 * The process-scoped tool registry. Shapes match chat-box's SAMPLE_TOOLS:
 * the client renders id/name/desc + an enabled + auto flag per tool. Workspace
 * tools are enabled at startup only when WORKSPACE_DIR is configured.
 * `enabled: false` tools are displayed but not selectable; `auto: true`
 * means the agent may auto-approve them (Phase 2 enforces).
 */
export const TOOL_DEFS: ToolDef[] = [
  {
    id: 'read_file',
    name: 'read_file',
    desc: workspaceLinked
      ? 'Read a UTF-8 file from the linked workspace.'
      : 'Read a file from the linked repo. Unavailable until WORKSPACE_DIR is set.',
    enabled: workspaceLinked,
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
    desc: workspaceLinked
      ? 'Execute the linked workspace package test script. Requires approval.'
      : 'Execute the test suite. Unavailable until WORKSPACE_DIR is set.',
    enabled: workspaceLinked,
    auto: workspaceLinked,
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
 * request a tool. Only executable tools are advertised; clarification is a
 * runtime control tool and therefore does not appear in the client catalog.
 */
export const OLLAMA_TOOLS: Tool[] = [
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description:
        'Read one UTF-8 text file from the trusted linked workspace. The path must be relative to the workspace root. Use this to inspect source, configuration, documentation, and tests before proposing code changes.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative file path inside the linked workspace.',
          },
        },
        required: ['path'],
      },
    },
  },
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
  {
    type: 'function' as const,
    function: {
      name: 'run_tests',
      description:
        'Run the linked workspace package.json test script and return its output. This executes repository code and therefore requires approval. The command and workspace cannot be supplied by the model.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'ask_clarification',
      description:
        'Ask the user a clarifying question with optional multi-select chips. Use this when you need structured input before proceeding — especially useful when the user\'s request is ambiguous or when constraints (idempotency, jitter, retry budget, etc.) would change the shape of the answer. The user will pick chips and/or type free-form text; your next turn will have their choice as a tool result.',
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'The clarifying question shown above the chips.',
          },
          chips: {
            type: 'array',
            items: { type: 'string' },
            description: 'Short answer options the user can tick. Keep to 2–6 labels.',
          },
          input_hint: {
            type: 'string',
            description: 'Placeholder text for the free-form input below the chips.',
          },
        },
        required: ['question'],
      },
    },
  },
];

const enabledAgentToolIds = new Set(
  TOOL_DEFS.filter((tool) => tool.enabled).map((tool) => tool.id),
);

/** Remove unknown and unavailable tools while preserving selection order. */
export function filterEnabledToolIds(toolIds: string[]): string[] {
  return [...new Set(toolIds.filter((id) => enabledAgentToolIds.has(id)))];
}

export interface ToolExecResult {
  status: 'ok' | 'err';
  elapsed_ms: number;
  result?: string;
  error?: string;
}

/**
 * Dispatch a tool call. Executable side-effect tools route through approval
 * before reaching this function; unknown or unavailable tools return a clear
 * error so a stale model response can recover.
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolExecResult> {
  const start = Date.now();
  try {
    if (name === 'read_file') {
      const path = String(args.path ?? '').trim();
      if (!path) {
        return {
          status: 'err',
          elapsed_ms: 0,
          error: 'read_file requires a non-empty "path" argument',
        };
      }
      const result = await readWorkspaceFile(path);
      return { status: 'ok', elapsed_ms: Date.now() - start, result };
    }
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
    if (name === 'run_tests') {
      const result = await runWorkspaceTests();
      return { status: 'ok', elapsed_ms: Date.now() - start, result };
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
 * Tools whose execution has visible side effects (writes, sends, executes).
 * These never auto-approve on the tool's own authority — a call to one is
 * routed through the `prompt.requested` / `prompt.responded` round-trip unless
 * a higher layer of the permission model (a standing grant, or an agent set to
 * `auto_allow_all`) allows it. See `graph/nodes.ts#isAutoApproved`.
 */
export function isSideEffectful(toolName: string): boolean {
  return ['write_file', 'run_tests', 'send_email'].includes(toolName);
}
