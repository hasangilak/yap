import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { stream } from 'hono/streaming';
import { serve } from '@hono/node-server';
import { EventEncoder } from '@ag-ui/encoder';
import type { RunAgentInput } from '@ag-ui/core';
import { config } from './config.js';
import { runAgent as runAgUiAgent } from './ollama-agent.js';
import { apiV1 } from './api/index.js';
import { bearerAuth } from './api/middleware/auth.js';
import { idempotency } from './api/middleware/idempotency.js';
import { rateLimit } from './api/middleware/rate-limit.js';
import { closeCheckpointer } from './runtime/graph/checkpointer.js';
import { recoverInterruptedTurns } from './runtime/recovery.js';

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

app.use('/api/v1/*', bearerAuth);
app.use('/api/v1/*', rateLimit);
app.use('/api/v1/*', idempotency);
app.route('/api/v1', apiV1);

// Reconcile turns that were mid-flight when this process last stopped, before
// accepting any connections. Turns paused on human input are left alone (their
// checkpoint is durable and a decision will resume them); crashed ones are
// replayed; unrecoverable ones stop pretending to be live.
await recoverInterruptedTurns();

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`yap listening on http://localhost:${info.port}`);
  console.log(`  POST /                          AG-UI stream (ai-remark)`);
  console.log(`  GET  /health                    health check`);
  console.log(`  GET  /api/v1/conversations      chat-box conversations list`);
  console.log(`  POST /api/v1/dev/seed           load SAMPLE_* fixtures`);
  console.log(`Model: ${config.defaultModel}   Ollama: ${config.ollamaHost}`);
});

/**
 * Release the checkpointer's connection pool on shutdown.
 *
 * Turns paused on human input need no special handling here — that is the
 * point of checkpointing them. They are already durable in Postgres and will
 * be picked up by `recoverInterruptedTurns()` on the next boot, so a restart
 * mid-approval is now survivable rather than fatal to the turn.
 */
let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[${signal}] shutting down`);
    void closeCheckpointer()
      .catch((err) => console.error('[shutdown]', err))
      .finally(() => process.exit(0));
  });
}
