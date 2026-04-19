export const config = {
  port: Number(process.env.PORT ?? 3001),
  ollamaHost: process.env.OLLAMA_HOST ?? 'http://localhost:11434',
  defaultModel: process.env.MODEL ?? 'qwen2.5:14b',
  maxToolRounds: Number(process.env.MAX_TOOL_ROUNDS ?? 8),
};
