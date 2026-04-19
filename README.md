# yap

A tiny local LLM server that speaks the [AG-UI protocol][ag-ui] over SSE and
bridges to a locally running [Ollama][ollama] model. Point any AG-UI client at
it and you get streaming text events — no API keys, no network round-trips.

Built originally as a test harness for a streaming-markdown renderer, but
nothing in here is tied to that project. Any AG-UI client works.

[ag-ui]: https://docs.ag-ui.com/introduction
[ollama]: https://ollama.com

## What it does

```
AG-UI client  ──POST RunAgentInput──▶  yap (:3001)  ──ollama.chat stream──▶  Ollama (:11434)
                                           │
                                           ▼
                                  SSE of AG-UI events
                          RUN_STARTED → TEXT_MESSAGE_START
                          → TEXT_MESSAGE_CONTENT × N
                          → TEXT_MESSAGE_END → RUN_FINISHED
```

Drop in a real reasoning model (`deepseek-r1`, `qwq`) and you still get the
same interface — only the tokens change.

## Quick start

```bash
# 1. make sure Ollama is running and a model is pulled
ollama pull qwen2.5:14b          # 9 GB — the default
# lighter alternatives:
ollama pull llama3.1:8b          # 4.7 GB
ollama pull qwen2.5:7b           # 4.7 GB

# 2. install + run
pnpm install
pnpm dev                         # tsx watch on :3001
```

You should see:

```
AG-UI server listening on http://localhost:3001
  POST /         → stream an agent run (AG-UI RunAgentInput)
  GET  /health   → health check
Model: qwen2.5:14b   Ollama: http://localhost:11434
```

## Smoke test

```bash
curl -s http://localhost:3001/health
# {"ok":true,"model":"qwen2.5:14b","ollamaHost":"http://localhost:11434"}

curl -N -X POST http://localhost:3001/ \
  -H 'Content-Type: application/json' \
  -d '{
    "threadId":"t","runId":"r",
    "state":{}, "tools":[], "context":[], "forwardedProps":{},
    "messages":[{"id":"m","role":"user","content":"Say hi in one word."}]
  }'
```

You should see a stream of `data: {...}` lines ending in `RUN_FINISHED`.

## Configuration

Copy `.env.example` to `.env` and tweak:

| Var           | Default                  | Purpose                       |
| ------------- | ------------------------ | ----------------------------- |
| `PORT`        | `3001`                   | HTTP port                     |
| `OLLAMA_HOST` | `http://localhost:11434` | Where Ollama is reachable     |
| `MODEL`       | `qwen2.5:14b`            | Default model                 |

Per-request model override: pass `forwardedProps: { model: "llama3.1:8b" }` in
the `RunAgentInput` body. See [INTEGRATION.md][docs] for precedence rules.

## Using it from a client

Minimal, with the official SDK:

```ts
import { HttpAgent } from '@ag-ui/client';

const agent = new HttpAgent({ url: 'http://localhost:3001/' });

agent.addMessage({ id: crypto.randomUUID(), role: 'user', content: 'hi' });

await agent.runAgent({}, {
  onTextMessageContentEvent: ({ event }) => process.stdout.write(event.delta),
});
```

Zero-dependency fetch + SSE parser, an `Observable` path, and the full event
schema are all in [INTEGRATION.md][docs].

[docs]: ./INTEGRATION.md

## What's in the box

```
src/
  config.ts         env → { port, ollamaHost, defaultModel }
  ollama-agent.ts   Ollama stream → AG-UI event AsyncGenerator
  server.ts         Hono app: POST /, GET /health
.env.example
INTEGRATION.md      full client-integration guide
```

The whole bridge is ~60 lines. Read it.

## What's not in the box (yet)

- Tool calling (`TOOL_CALL_*` events)
- Reasoning traces (`REASONING_*` / `THINKING_*`) — the `<think>` tags from
  `deepseek-r1` etc. currently arrive as plain text
- State sync (`STATE_SNAPSHOT`, `STATE_DELTA`)
- Auth, persistence, rate limiting

See the "Extension points" section in [INTEGRATION.md][docs] for how to add
any of these.

## License

MIT.
