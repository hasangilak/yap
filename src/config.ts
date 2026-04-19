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
  /// Optional bearer token required on /api/v1/*. Unset = open mode.
  apiToken: process.env.YAP_API_TOKEN ?? '',
  /// Per-tool-call deadline in ms. Overridden per-agent later (Phase 4+).
  toolDeadlineMs: Number(process.env.TOOL_DEADLINE_MS ?? 30_000),
  /// Sliding-window rate limit in requests per minute per IP/token.
  rateLimitRpm: Number(process.env.RATE_LIMIT_RPM ?? 60),
};
