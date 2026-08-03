import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(moduleDir, '..');

export const config = {
  port: Number(process.env.PORT ?? 3001),
  ollamaHost: process.env.OLLAMA_HOST ?? 'http://localhost:11434',
  defaultModel: process.env.MODEL ?? 'qwen2.5:14b',
  maxToolRounds: Number(process.env.MAX_TOOL_ROUNDS ?? 8),
  databaseUrl:
    process.env.DATABASE_URL
    ?? 'postgres://yap:yap@localhost:5432/yap',
  artifactsDir:
    process.env.ARTIFACTS_DIR ?? resolve(projectRoot, '../artifacts'),
  /// Optional trusted project root exposed to read_file/run_tests. Tool
  /// arguments can never replace this root; unset means no workspace tools.
  workspaceDir: process.env.WORKSPACE_DIR
    ? resolve(process.env.WORKSPACE_DIR)
    : null,
  workspaceReadMaxBytes: Number(
    process.env.WORKSPACE_READ_MAX_BYTES ?? 200_000,
  ),
  workspaceTestTimeoutMs: Number(
    process.env.WORKSPACE_TEST_TIMEOUT_MS ?? 120_000,
  ),
  workspaceTestMaxOutputBytes: Number(
    process.env.WORKSPACE_TEST_MAX_OUTPUT_BYTES ?? 200_000,
  ),
  /// Optional bearer token required on /api/v1/*. Unset = open mode.
  apiToken: process.env.YAP_API_TOKEN ?? '',
  /// Per-tool-call deadline in ms. Overridden per-agent later (Phase 4+).
  toolDeadlineMs: Number(process.env.TOOL_DEADLINE_MS ?? 30_000),
  /// Sliding-window rate limit in requests per minute per IP/token.
  rateLimitRpm: Number(process.env.RATE_LIMIT_RPM ?? 60),
  /// Override for the chrome-less CLI entrypoint. Empty = resolve the
  /// installed `chrome-less` package.
  chromeLessBin: process.env.CHROME_LESS_BIN ?? '',
  /// Chrome/Chromium binary chrome-less should drive. Read by the child
  /// process, not by yap — forwarded explicitly in tools/browser.ts.
  chromeLessChrome: process.env.CHROME_LESS_CHROME ?? '',
  /// Postgres schema LangGraph's checkpointer owns. Kept out of `public`
  /// so its four tables never collide with Prisma's models or show up as
  /// drift in `prisma db push`.
  langgraphSchema: process.env.LANGGRAPH_SCHEMA ?? 'langgraph',
};
