import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(moduleDir, '..');

export const config = {
  port: Number(process.env.PORT ?? 3001),
  ollamaHost: process.env.OLLAMA_HOST ?? 'http://localhost:11434',
  defaultModel: process.env.MODEL ?? 'qwen2.5:14b',
  chromeLessBin:
    process.env.CHROME_LESS_BIN ?? resolve(projectRoot, '../chrome-lite/dist/cli.js'),
  maxToolRounds: Number(process.env.MAX_TOOL_ROUNDS ?? 8),
};
