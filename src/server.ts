import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { stream } from 'hono/streaming';
import { serve } from '@hono/node-server';
import { EventEncoder } from '@ag-ui/encoder';
import type { RunAgentInput } from '@ag-ui/core';
import { config } from './config.js';
import { runAgent as runAgUiAgent } from './ollama-agent.js';
import { apiV1 } from './api/index.js';

const app = new Hono();
const encoder = new EventEncoder();

app.use('*', cors());

app.get('/health', (c) =>
  c.json({ ok: true, model: config.defaultModel, ollamaHost: config.ollamaHost }),
);

// Legacy AG-UI surface used by ai-remark. Stays unchanged; the chat-box
// client hits /api/v1/* instead, which has a different event envelope
// and real persistence.
app.post('/', async (c) => {
  const body = (await c.req.json()) as RunAgentInput & { model?: string };

  c.header('Content-Type', encoder.getContentType());
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'keep-alive');
  c.header('X-Accel-Buffering', 'no');

  return stream(c, async (s) => {
    for await (const event of runAgUiAgent(body, body.model)) {
      await s.write(encoder.encodeSSE(event));
    }
  });
});

app.route('/api/v1', apiV1);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`yap listening on http://localhost:${info.port}`);
  console.log(`  POST /                          AG-UI stream (ai-remark)`);
  console.log(`  GET  /health                    health check`);
  console.log(`  GET  /api/v1/conversations      chat-box conversations list`);
  console.log(`  POST /api/v1/dev/seed           load SAMPLE_* fixtures`);
  console.log(`Model: ${config.defaultModel}   Ollama: ${config.ollamaHost}`);
});
