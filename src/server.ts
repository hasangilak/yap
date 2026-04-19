import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { stream } from 'hono/streaming';
import { serve } from '@hono/node-server';
import { EventEncoder } from '@ag-ui/encoder';
import type { RunAgentInput } from '@ag-ui/core';
import { config } from './config.js';
import { runAgent } from './ollama-agent.js';

const app = new Hono();
const encoder = new EventEncoder();

app.use('*', cors());

app.get('/health', (c) =>
  c.json({ ok: true, model: config.defaultModel, ollamaHost: config.ollamaHost }),
);

app.post('/', async (c) => {
  const body = (await c.req.json()) as RunAgentInput & { model?: string };

  c.header('Content-Type', encoder.getContentType());
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'keep-alive');
  c.header('X-Accel-Buffering', 'no');

  return stream(c, async (s) => {
    for await (const event of runAgent(body, body.model)) {
      await s.write(encoder.encodeSSE(event));
    }
  });
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`AG-UI server listening on http://localhost:${info.port}`);
  console.log(`  POST /         → stream an agent run (AG-UI RunAgentInput)`);
  console.log(`  GET  /health   → health check`);
  console.log(`Model: ${config.defaultModel}   Ollama: ${config.ollamaHost}`);
});
