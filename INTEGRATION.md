# Integrating `ai-remark` with the `simplest-llm` AG-UI server

This document describes exactly how the `ai-remark` project (streaming markdown
renderer in the Artifacts/Canvas style) can connect to the AG-UI server that
lives in the `simplest-llm` repo. It is written for an AI or developer working
inside `ai-remark` who has no prior knowledge of the server.

---

## 1. Mental model

The server is a **thin HTTP bridge** from the [AG-UI protocol][ag-ui] to a local
[Ollama][ollama] runtime:

```
ai-remark (browser / Next.js)
        │  POST RunAgentInput (JSON)
        ▼
simplest-llm server (Hono, :3001)
        │  ollama.chat({ stream: true })
        ▼
   Ollama (:11434, local)
        │  model = qwen2.5:14b (default)
        ▼
   streamed text chunks
        │  re-emitted as AG-UI SSE events
        ▼
ai-remark consumes `TEXT_MESSAGE_CONTENT` deltas
```

The server speaks a **standard, open protocol** — [AG-UI][ag-ui] (Agent-User
Interaction Protocol). Any AG-UI client — including the official
`@ag-ui/client` SDK, CopilotKit, or a plain `fetch` + SSE parser — can talk to
it unchanged.

[ag-ui]: https://docs.ag-ui.com/introduction
[ollama]: https://ollama.com

---

## 2. Running the server

The server lives at `/Users/hassangilak/Work/simplest-llm/`. From that
directory:

```bash
pnpm install            # once
pnpm dev                # tsx watch on :3001
```

Expected log:

```
AG-UI server listening on http://localhost:3001
  POST /         → stream an agent run (AG-UI RunAgentInput)
  GET  /health   → health check
Model: qwen2.5:14b   Ollama: http://localhost:11434
```

Environment variables (all optional, see `.env.example`):

| Var           | Default                   | Purpose                        |
| ------------- | ------------------------- | ------------------------------ |
| `PORT`        | `3001`                    | HTTP port                      |
| `OLLAMA_HOST` | `http://localhost:11434`  | Where Ollama is reachable      |
| `MODEL`       | `qwen2.5:14b`             | Default model if not overridden |

**Prerequisite:** Ollama is running locally and the chosen model is pulled:

```bash
ollama pull qwen2.5:14b       # 9 GB
# or a lighter alternative:
ollama pull llama3.1:8b       # 4.7 GB
ollama pull qwen2.5:7b        # 4.7 GB
```

---

## 3. The HTTP contract

### 3.1 `GET /health`

Sanity check. Does not touch Ollama beyond returning config.

```bash
$ curl -s http://localhost:3001/health
{"ok":true,"model":"qwen2.5:14b","ollamaHost":"http://localhost:11434"}
```

### 3.2 `POST /`

- **Request body:** a JSON object matching AG-UI's `RunAgentInput`.
- **Response:** `text/event-stream` (SSE) of AG-UI events, one per `data:` line.
- **CORS:** open (`*`). Safe to call from any localhost dev origin.

The request body MUST include these fields (types from `@ag-ui/core`):

```ts
interface RunAgentInput {
  threadId: string;      // your conversation/thread identifier
  runId: string;         // unique per POST request
  messages: Message[];   // full history for this turn (see 3.3)
  tools: Tool[];         // pass [] if you don't use tools
  context: Context[];    // pass [] if you don't use context
  forwardedProps: any;   // free-form extension — used here for per-request model override
  state?: any;           // optional arbitrary state blob
  parentRunId?: string;  // optional
}
```

### 3.3 Message shape

AG-UI messages are discriminated by `role`. The server accepts the full set but
only passes `system | developer | user | assistant | tool` on to Ollama;
`activity` and `reasoning` messages are dropped.

```ts
// minimal user message
{ id: "m-1", role: "user", content: "Write a haiku about streaming." }

// assistant turns you want to include in history
{ id: "m-2", role: "assistant", content: "..." }

// system prompt
{ id: "m-0", role: "system", content: "You are concise and accurate." }
```

`developer` is mapped to `system` on the Ollama side.

### 3.4 Example request

```bash
curl -N -X POST http://localhost:3001/ \
  -H 'Content-Type: application/json' \
  -d '{
    "threadId": "demo-thread",
    "runId": "run-1",
    "state": {},
    "messages": [
      {"id":"m-0","role":"system","content":"You are concise."},
      {"id":"m-1","role":"user","content":"Hello."}
    ],
    "tools": [],
    "context": [],
    "forwardedProps": {}
  }'
```

---

## 4. Event protocol emitted by the server

The server emits a strict, minimal AG-UI event sequence per run. Every line on
the wire is `data: <JSON>\n\n` (SSE).

### 4.1 Happy-path sequence

```
RUN_STARTED
TEXT_MESSAGE_START
TEXT_MESSAGE_CONTENT   ← repeated, one per Ollama chunk
TEXT_MESSAGE_CONTENT
...
TEXT_MESSAGE_END
RUN_FINISHED
```

### 4.2 Exact event shapes

All events carry `type: string` plus the fields below. Field names are
**case-sensitive** and match `@ag-ui/core` schemas.

```ts
// 1. Run lifecycle
{ type: "RUN_STARTED",  threadId: string, runId: string }
{ type: "RUN_FINISHED", threadId: string, runId: string }
{ type: "RUN_ERROR",    message: string }   // emitted instead of RUN_FINISHED on failure

// 2. Text streaming — these are what ai-remark cares about
{ type: "TEXT_MESSAGE_START",   messageId: string, role: "assistant" }
{ type: "TEXT_MESSAGE_CONTENT", messageId: string, delta: string }
{ type: "TEXT_MESSAGE_END",     messageId: string }
```

`messageId` is a UUID generated per run and is stable across all three text
events. Use it to key your rendering target (one artifact / canvas block per
`messageId`).

### 4.3 Error path

On Ollama failure the server emits `RUN_ERROR` and closes the stream. There is
no `RUN_FINISHED` after an error.

```
RUN_STARTED
TEXT_MESSAGE_START
RUN_ERROR  { "message": "model 'foo' not found, try pulling it first" }
<stream closes>
```

### 4.4 Events the server does NOT currently emit

Good to know so you don't build UI that waits for them:

- `TOOL_CALL_*` (tool calling — Ollama's function calls aren't bridged yet)
- `REASONING_*` / `THINKING_*` (reasoning traces — needs a reasoning model and
  a parser; `qwen2.5` is not a thinking model)
- `STATE_SNAPSHOT`, `STATE_DELTA`, `MESSAGES_SNAPSHOT` (state sync)
- `STEP_STARTED` / `STEP_FINISHED`
- `ACTIVITY_*`, `CUSTOM`, `RAW`

If you need any of these, see §11.

---

## 5. Client integration: three ways

Pick one based on how deep you want to go.

### 5.1 Zero dependency — plain `fetch` + SSE parsing

Good for a quick test harness or a minimal renderer.

```ts
async function runAgentStream(
  url: string,
  input: {
    threadId: string;
    runId: string;
    messages: Array<{ id: string; role: string; content: string }>;
  },
  onDelta: (delta: string, messageId: string) => void,
  onDone: () => void,
  onError: (msg: string) => void,
) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...input,
      tools: [],
      context: [],
      forwardedProps: {},
      state: {},
    }),
  });

  if (!res.body) throw new Error('No response body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';

    for (const frame of frames) {
      const line = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const event = JSON.parse(line.slice(5).trim());

      switch (event.type) {
        case 'TEXT_MESSAGE_CONTENT':
          onDelta(event.delta, event.messageId);
          break;
        case 'RUN_FINISHED':
          onDone();
          break;
        case 'RUN_ERROR':
          onError(event.message);
          break;
      }
    }
  }
}
```

### 5.2 Recommended — `@ag-ui/client`

This is the official SDK. It handles transport, parsing, buffering, abort, and
gives you typed lifecycle callbacks. Install in `ai-remark`:

```bash
pnpm add @ag-ui/client @ag-ui/core
```

Minimal usage:

```ts
import { HttpAgent } from '@ag-ui/client';

const agent = new HttpAgent({
  url: 'http://localhost:3001/',
  threadId: 'my-canvas-thread',
});

// push user message into the agent's internal history
agent.addMessage({
  id: crypto.randomUUID(),
  role: 'user',
  content: 'Write a short markdown doc about SSE.',
});

await agent.runAgent(
  {},   // optional: { runId, tools, context, forwardedProps }
  {
    onTextMessageStartEvent: ({ event }) => {
      // new assistant message begins — event.messageId is the stable id
      canvasApi.open(event.messageId);
    },
    onTextMessageContentEvent: ({ event, textMessageBuffer }) => {
      // event.delta     → just the new chunk
      // textMessageBuffer → full text so far (provided by the SDK)
      canvasApi.appendDelta(event.messageId, event.delta);
    },
    onTextMessageEndEvent: ({ event, textMessageBuffer }) => {
      canvasApi.close(event.messageId, textMessageBuffer);
    },
    onRunErrorEvent: ({ event }) => {
      canvasApi.error(event.message);
    },
  },
);
```

Key `HttpAgent` capabilities you will use:

- `agent.addMessage(msg)` — append to history.
- `agent.setMessages(msgs)` — replace history wholesale.
- `agent.runAgent(params?, subscriber?)` — kick off a run; promise resolves on
  `RUN_FINISHED`. Params: `{ runId?, tools?, context?, forwardedProps? }`.
- `agent.abortRun()` — cancel the active run. Use this when the user clicks
  "stop generating".
- `agent.subscribe(subscriber)` — register persistent subscribers (returns an
  `unsubscribe()` function). Handy for React hooks.
- `agent.run(input)` — low-level `Observable<BaseEvent>` if you prefer rxjs.

### 5.3 Low-level — `Observable` stream

If you already use rxjs in `ai-remark` or want every event including ones the
subscriber hooks don't expose:

```ts
import { HttpAgent } from '@ag-ui/client';

const agent = new HttpAgent({ url: 'http://localhost:3001/' });

agent.run({
  threadId: 't',
  runId: crypto.randomUUID(),
  messages: [{ id: 'u1', role: 'user', content: 'hi' }],
  tools: [],
  context: [],
  forwardedProps: {},
  state: {},
}).subscribe({
  next: (event) => console.log(event.type, event),
  error: (err) => console.error(err),
  complete: () => console.log('done'),
});
```

---

## 6. Wiring the event stream into a remark-based renderer

`ai-remark` is, per its `package.json`, a streaming-markdown renderer. The
mapping from AG-UI events to its rendering model is:

| AG-UI event              | ai-remark action                                        |
| ------------------------ | ------------------------------------------------------- |
| `TEXT_MESSAGE_START`     | Begin a new artifact / canvas block keyed by `messageId` |
| `TEXT_MESSAGE_CONTENT`   | Feed `event.delta` into the incremental parser          |
| `TEXT_MESSAGE_END`       | Finalize the block (unlock highlight-to-refine, etc.)    |
| `RUN_ERROR`              | Surface error, stop further appends                      |
| `RUN_FINISHED`           | Close the run; re-enable input                           |

If the renderer in `ai-remark/packages/react` exposes a controlled-component
API that accepts an ever-growing string, the simplest shim is:

```tsx
function AgentCanvas() {
  const [text, setText] = useState('');
  const [messageId, setMessageId] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'streaming' | 'done' | 'error'>('idle');

  const agent = useMemo(
    () => new HttpAgent({ url: 'http://localhost:3001/' }),
    [],
  );

  const send = useCallback(async (prompt: string) => {
    agent.addMessage({ id: crypto.randomUUID(), role: 'user', content: prompt });
    setText('');
    setStatus('streaming');

    await agent.runAgent({}, {
      onTextMessageStartEvent: ({ event }) => setMessageId(event.messageId),
      onTextMessageContentEvent: ({ event }) =>
        setText((prev) => prev + event.delta),
      onTextMessageEndEvent: () => setStatus('done'),
      onRunErrorEvent: () => setStatus('error'),
    });
  }, [agent]);

  return <StreamingMarkdown source={text} key={messageId ?? 'empty'} />;
}
```

If the renderer accepts an async iterable of chunks (more remark-native), use
the `Observable` path in §5.3 and convert with `rxjs`'s `firstValueFrom` +
an `AsyncGenerator`, or push into a `ReadableStream`.

**Important invariant:** the parser must be tolerant of partial markdown. A
delta may arrive mid-word, mid-code-fence, or mid-link. Ollama chunks are
typically 1–3 tokens. Buffer defensively in the parser, not in the transport.

---

## 7. Selecting a model per request

There are three override mechanisms, in precedence order. Pick whichever fits
your UX.

### 7.1 Server default (simplest)

Set `MODEL` env var when launching the server:

```bash
MODEL=llama3.1:8b pnpm dev
```

### 7.2 Per-request via `forwardedProps.model` (preferred from `@ag-ui/client`)

`forwardedProps` is AG-UI's spec-blessed extension channel. The server reads
`forwardedProps.model`:

```ts
await agent.runAgent({
  forwardedProps: { model: 'llama3.1:8b' },
});
```

### 7.3 Per-request via body `model` (only via raw fetch)

If you POST raw JSON yourself (see §5.1), you can also put `model` at the body
root:

```json
{ "...": "...", "model": "qwen2.5:14b" }
```

The `@ag-ui/client` `HttpAgent` does NOT send this field, so use this only
from a plain-fetch client.

**Precedence in the server:** root-body `model` > `forwardedProps.model` >
env `MODEL` > hard-coded default `qwen2.5:14b`.

---

## 8. Error handling

### 8.1 `RUN_ERROR` event

Emitted when Ollama rejects the request (model not pulled, bad params,
connection refused). Its `message` field is the stringified error from the
Ollama client. After `RUN_ERROR`, the server closes the stream — do not expect
`TEXT_MESSAGE_END` or `RUN_FINISHED`.

### 8.2 HTTP-level errors

- **Invalid JSON body** → Hono returns `400` before entering the stream.
- **Server not running** → fetch rejects; handle with try/catch around
  `agent.runAgent()`.
- **Ollama host unreachable** → server returns 200 and opens the SSE stream,
  then emits `RUN_ERROR` once the Ollama client fails to connect. The UI should
  show the error identically to model-not-found.

### 8.3 Aborts

Call `agent.abortRun()` from the UI. It aborts the underlying `fetch` via the
internal `AbortController`. The server will stop receiving reads and terminate
the Ollama stream. Note: the assistant message already rendered is kept; you
decide whether to clear or mark as "stopped".

---

## 9. CORS and dev workflow

- The server sends `Access-Control-Allow-Origin: *` via Hono's `cors()`
  middleware. No CORS config needed on the `ai-remark` side for local dev.
- Recommended ports:
  - `simplest-llm`       → `3001`
  - `ai-remark` example  → `3000` (Next.js default)
- Run both in parallel; the example app in `ai-remark` fetches
  `http://localhost:3001/` directly.
- If you want to proxy through Next.js (to avoid CORS on prod or to inject
  auth), add a Next API route that pipes to the server. The server's response
  is standard SSE — pipe `req.body` through and forward headers.

---

## 10. Known limitations (read this before designing features)

- **Single-turn, single-agent.** No agent-to-agent handoff, no `parentRunId`
  tracking.
- **No tool calls.** The server ignores `RunAgentInput.tools` entirely. Ollama
  does support function calling for compatible models (`llama3.1`, `qwen2.5`),
  but that bridge isn't wired yet.
- **No reasoning events.** `qwen2.5` is not a thinking model. If you switch to
  `deepseek-r1` or `qwq`, the `<think>...</think>` tags arrive as regular text
  in `TEXT_MESSAGE_CONTENT`; you'd need a parser (server- or client-side) to
  split them into `REASONING_MESSAGE_*` events.
- **No state sync.** `state`, `STATE_SNAPSHOT`, `STATE_DELTA` events are not
  emitted. `RunAgentInput.state` is received but ignored.
- **No auth.** Anyone who can reach `:3001` can use it. Fine for localhost,
  not for anything exposed.
- **No persistence.** Each request carries its full history in `messages`. The
  server has no DB.
- **No rate limiting, no timeouts beyond Ollama's.** A slow model + short
  context window can block requests.

---

## 11. Extension points (when you need more)

Everything below is a small, self-contained change in `simplest-llm/src/`.
Mentioning these so `ai-remark` PRs can reference or request them.

- **Tool calling.** Enable Ollama's `tools` param, parse streamed
  `tool_calls` from chunks, emit `TOOL_CALL_START` / `TOOL_CALL_ARGS` /
  `TOOL_CALL_END`, then receive a `tool` role message in the next run to
  continue.
- **Reasoning traces.** For `deepseek-r1`-family, regex-split streamed text on
  `<think>` / `</think>` and emit `REASONING_MESSAGE_*` events for the
  interior, `TEXT_MESSAGE_*` for the exterior.
- **Steps.** Emit `STEP_STARTED` / `STEP_FINISHED` around tool rounds so the UI
  can show a stepped trace.
- **Per-thread history.** Store messages keyed by `threadId` so the client can
  send only the new user turn instead of the full history.
- **Auth.** Add a middleware checking a bearer token; pass it from
  `ai-remark` via `new HttpAgent({ url, headers: { Authorization: ... } })`.

---

## 12. File map of `simplest-llm`

```
simplest-llm/
├── src/
│   ├── config.ts          env → { port, ollamaHost, defaultModel }
│   ├── ollama-agent.ts    Ollama stream → AG-UI event AsyncGenerator
│   └── server.ts          Hono app, POST /, GET /health
├── .env.example           copy to .env and edit
├── INTEGRATION.md         this file
├── package.json
└── tsconfig.json
```

The entire bridge is ~60 lines; read it if anything here is ambiguous.

---

## 13. Quick verification checklist for `ai-remark`

Before building anything fancy, confirm:

1. `curl http://localhost:3001/health` returns `{"ok":true,...}`.
2. The `curl -N -X POST ...` example in §3.4 streams back `data: {...}`
   lines and ends with `RUN_FINISHED`.
3. From `ai-remark`, a minimal `HttpAgent({ url: 'http://localhost:3001/' })`
   + `runAgent` with a single `onTextMessageContentEvent` logger prints deltas
   to the browser console.
4. Deltas concatenated form coherent markdown.

If all four pass, the transport is solid and any remaining issues are on the
renderer side.
