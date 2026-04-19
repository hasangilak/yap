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
};
