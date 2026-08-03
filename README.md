# yap

A local LLM server with two personalities on one port.

**`/api/v1/*`** — a full chat-product backend: conversation trees,
streamed reasoning + content + tool calls, durable human-in-the-loop
prompts (approve / edit-then-approve / clarify), versioned agents,
artifacts with diffs, tags/notes/snippets/search/
export/share, auth + idempotency + rate limits. Consumed by
[`chat-box`](https://github.com/hasangilak/chat-box).

**`POST /`** — the original [AG-UI protocol][ag-ui] over SSE. A thin
bridge from AG-UI clients to whatever Ollama model you have. Consumed
by [`ai-remark`](https://github.com/hasangilak/ai-remark).

Both surfaces share one process, one Postgres, one Ollama runtime.
Both stream responses token-by-token. Everything is local — no API
keys, no network round-trips.

[ag-ui]: https://docs.ag-ui.com/introduction
[ollama]: https://ollama.com

## What it does

```
                    ┌─────────────────────┐
                    │  chat-box frontend  │
                    └──────────┬──────────┘
                               │  REST + SSE
                               ▼
  ┌────────────────┐   ┌──────────────────┐   ┌─────────────┐
  │   ai-remark    │──▶│   yap (:3001)    │──▶│   Ollama    │
  │   (AG-UI SSE)  │   │                  │   │  (:11434)   │
  └────────────────┘   │  /api/v1/*       │   └─────────────┘
                       │  POST /          │
                       │                  │   ┌─────────────┐
                       │                  │──▶│  Postgres   │
                       └──────────────────┘   │  (:5432)    │
                                              └─────────────┘
```

## Quick start

### Docker (server + database)

```bash
# Ollama runs on the host so it can use the host GPU and model store.
ollama pull qwen2.5:14b
docker compose up --build
# postgres + yap on :3001; yap connects to host Ollama on :11434
```

### Local dev

```bash
# 1. Postgres — either via compose or your own
docker compose up -d postgres

# 2. Ollama with a model pulled
ollama pull qwen2.5:14b          # 9 GB default
# or lighter: llama3.1:8b | qwen2.5:7b
# or reasoning: deepseek-r1:14b | qwq:32b

# 3. yap
pnpm install
pnpm db:push                     # applies Prisma schema
pnpm dev                         # tsx watch on :3001
```

You should see:

```
yap listening on http://localhost:3001
  POST /                          AG-UI stream (ai-remark)
  GET  /health                    health check
  GET  /api/v1/conversations      chat-box conversations list
  POST /api/v1/dev/seed           load SAMPLE_* fixtures
Model: qwen2.5:14b   Ollama: http://localhost:11434
```

## Smoke tests

### Health + chat-box API

```bash
curl -s http://localhost:3001/health
# {"ok":true,"model":"qwen2.5:14b","ollamaHost":"..."}

curl -sX POST http://localhost:3001/api/v1/dev/seed
# {"ok":true,"agents":7,"conversations":9,"nodes":9,"populated_conversation":"c-01"}

curl -s http://localhost:3001/api/v1/conversations | jq length    # → 9
curl -s http://localhost:3001/api/v1/conversations/c-01 | jq '.tree.activeLeaf'
# → "n-07"
```

### Full streaming round-trip

```bash
# Open a stream in one terminal
curl -N http://localhost:3001/api/v1/conversations/c-01/stream

# Send a message in another
curl -sX POST http://localhost:3001/api/v1/conversations/c-01/messages \
  -H 'Content-Type: application/json' \
  -d '{"content":"Say hi in one word."}'
```

Stream emits:

```
event: node.created      (the user node)
event: active_leaf.changed
event: node.created      (the assistant placeholder)
event: status.update     (thinking)
event: content.delta     × N
event: node.finalized
event: active_leaf.changed
```

### AG-UI (ai-remark) path

```bash
curl -N -X POST http://localhost:3001/ \
  -H 'Content-Type: application/json' \
  -d '{
    "threadId":"t","runId":"r",
    "state":{}, "tools":[], "context":[], "forwardedProps":{},
    "messages":[{"id":"m","role":"user","content":"Say hi in one word."}]
  }'
```

Emits `RUN_STARTED → TEXT_MESSAGE_START → TEXT_MESSAGE_CONTENT × N →
TEXT_MESSAGE_END → RUN_FINISHED`.

## Configuration

Copy `.env.example` to `.env` and tweak. All vars optional:

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3001` | HTTP listen port |
| `DATABASE_URL` | `postgres://yap:yap@localhost:5432/yap` | Prisma DSN |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama server |
| `MODEL` | `qwen2.5:14b` | Default model |
| `ARTIFACTS_DIR` | `../artifacts` | `write_file` sandbox root |
| `WORKSPACE_DIR` | *(empty)* | Trusted project root; enables `read_file`, plus approval-gated `run_tests` when `scripts.test` exists |
| `WORKSPACE_READ_MAX_BYTES` | `200000` | Maximum file size returned by `read_file` |
| `WORKSPACE_TEST_TIMEOUT_MS` | `120000` | Hard timeout for the linked package test script |
| `WORKSPACE_TEST_MAX_OUTPUT_BYTES` | `200000` | Maximum captured stdout/stderr from tests |
| `YAP_API_TOKEN` | *(empty)* | If set, requires `Authorization: Bearer <token>` on `/api/v1` |
| `MAX_TOOL_ROUNDS` | `8` | Hard stop on model ⇄ tool loops |
| `TOOL_DEADLINE_MS` | `30000` | Per-round Ollama stream deadline |
| `RATE_LIMIT_RPM` | `60` | Per-identity rate limit (rpm) |

## What's in the box

The `/api/v1/*` surface implements every endpoint in
[`chat-box/docs/server-spec.md`][spec] across 8 shipped phases:

| | Surface |
|---|---|
| Phase 1 | Conversation CRUD + message tree + SSE stream + `web_search` tool |
| Phase 2 | Tool approvals + "allow always" grants + three-layer permission model |
| LangGraph | Turn runtime is a Postgres-checkpointed `StateGraph`; pauses survive restarts. Approvals + clarifications unified into one `Prompt` model with `edited_args`. Adds `POST /:id/cancel` (stop the turn) and `POST /:id/interject` (steer it without stopping) |
| Phase 3 | Edit (creates branch) / regenerate / branch / prune / ripple-preview |
| Phase 4 | Agents CRUD + versions + restore + diff + templates + optimizer/eval stubs |
| Phase 5a | Clarifications via `ask_clarification` pseudo-tool |
| Phase 5b | Reasoning — `<think>` tag splitter → `reasoning.delta` events |
| Phase 6 | Artifacts (canvas) + version chain + unified diff |
| Phase 7 | Tags, notes, pinned snippets, timeline, search, export (md/json), share |
| Phase 8 | Bearer auth + idempotency + reconnect-race fix + token budget + tool deadline + rate limit |

Plus the untouched `POST /` AG-UI surface for `ai-remark`.

### Source layout

```
src/
  api/                   Hono routers grouped by resource
    conversations.ts     list, create, get, tree, tag attach/detach, artifacts list
    messages.ts          POST /conversations/:id/messages
    stream.ts            GET /stream with subscribe-first + since_event replay
    nodes.ts             edit, branch, regenerate, prune, ripple-preview
    agents.ts            agents CRUD + versions + restore + diff
    agent-templates.ts   templates catalog, from-template, optimize + eval stubs
    prompts.ts           respond to a prompt, get one, list pending
    cancel.ts            stop the running turn (the stop button)
    interject.ts         steer the running turn without stopping it
    approvals.ts         list grants, revoke grant
    artifacts.ts         preview, versions, diff
    tags.ts              CRUD
    notes.ts             thread note + pinned snippets
    timeline.ts          event → TimelineEvent synthesis
    search.ts            ILIKE across messages + conversations + agents
    export-share.ts      export md/json, share mint/revoke/public read
    dev.ts               POST /dev/seed
    middleware/
      auth.ts            bearer-token gate
      idempotency.ts     Idempotency-Key replay
      rate-limit.ts      sliding-window per identity

  runtime/
    run.ts               façade: runAgent / runAssistantTurn / resumeTurn
    recovery.ts          boot reconciliation of turns left mid-flight
    graph/
      index.ts           StateGraph assembly + turnConfig (durability:'sync')
      nodes.ts           prepare, callModel, gate, wait, resolvePrompt,
                         execute, finalize — plus the routing predicates
      state.ts           checkpointable turn state (plain JSON only)
      model.ts           ChatOllama streaming round + abort handling
      checkpointer.ts    PostgresSaver on its own `langgraph` schema
      steering.ts        in-memory AbortController per in-flight model call
                         (the steering *text* is durable — interjections table)
    think-splitter.ts    streaming <think>…</think> parser

  db/
    index.ts             PrismaClient singleton
    queries.ts           typed wrappers over prisma — one call per logical op

  events/
    bus.ts               in-process EventEmitter + persist-then-publish
    encoder.ts           named-event SSE encoder
    types.ts             BusEvent union re-export

  registry/tools.ts      7-tool def registry + executeTool dispatcher
  schemas/               zod schemas mirroring chat-box/src/types.ts
  seed/samples.ts        chat-box SAMPLE_* fixtures for /dev/seed
  seed/templates.ts      4 starter agents for /agent-templates

  ollama-agent.ts        legacy AG-UI → Ollama bridge (POST /)
  system-prompt.ts       default assistant prompt
  server.ts              Hono app wiring

prisma/schema.prisma     15 models: Conversation, Node, Agent, AgentVersion,
                         Event, Prompt, Interjection, ApprovalGrant, Artifact,
                         ArtifactVersion, Tag, ConversationTag, ThreadNote,
                         PinnedSnippet, IdempotencyRecord
                         (LangGraph owns 4 more in the `langgraph` schema)

test/                    163 tests across 15 files
  unit/                  schemas, splitter, encoder, tools
                         sandbox, auth, rate-limit
  integration/           db queries, API endpoints, mocked-Ollama runtime,
                         idempotency with real DB
  helpers/               app + db test harness

docs/
  server-upgrade-plan.md   phased design doc (historical)
  chat-box-integration.md  full frontend-facing API/SSE/types guide
```

## Client integration

- **chat-box** (conversation UI): read
  [docs/chat-box-integration.md][chatbox]. It's the authoritative
  spec: every endpoint, every event, every TypeScript wire type, a
  reducer sketch, and a file-by-file map from chat-box stubs to yap
  routes.
- **ai-remark** (streaming markdown renderer): read
  [INTEGRATION.md][aguidocs]. AG-UI `HttpAgent` against `POST /`.
- **Any other AG-UI client**: same — point the AG-UI transport at
  `http://localhost:3001/` and go.

[spec]: ../chat-box/docs/server-spec.md
[chatbox]: ./docs/chat-box-integration.md
[aguidocs]: ./INTEGRATION.md

## Tests

```bash
pnpm test                # full suite (requires Postgres)
pnpm test:watch          # vitest --watch
pnpm test:unit           # pure-module tests only (no DB needed)
pnpm test:integration    # DB + API + runtime with mocked Ollama
```

163 tests covering:

- Pure modules: `ThinkSplitter`, SSE encoder, rate-limit bucket
  arithmetic, `write_file` sandbox path traversal, schema round-trip
  through every `SAMPLE_*` fixture, full `BusEvent`
  discriminated-union coverage (including that a prompt whose
  `prompt_kind` disagrees with its payload is rejected), bearer auth.
- DB layer: every Prisma helper in `src/db/queries.ts` — conversation/
  node/agent/artifact/prompt/tag/event CRUD, branch naming,
  subtree walking, ripple-count arithmetic, version chains, and the
  prompt-response compare-and-set under concurrent writers.
- API layer: every `/api/v1` endpoint — conversations, agents +
  versions + templates + stubs, tools, tags, notes, pinned snippets,
  timeline synthesis, search highlighting, export, share mint/read/
  revoke, seed fixtures.
- Runtime: `vi.hoisted` scripted `@langchain/ollama` + mocked
  chrome-less, against a real Postgres checkpointer. Happy path,
  tool-call round-trip, a turn parking on a durable interrupt,
  deny/allow resume, `edited_args` reaching the tool, an edit still
  failing the sandbox check, token budget refusal, `<think>` tag
  splitting, unknown-conversation error.
- Prompt API: respond/409/400 paths, concurrent responses resolving to
  one winner, and the pending-prompt listing.
- Interrupt/steer: interjections persisted before the 200 and delivered
  at-least-once, a steered turn not finalizing before it applies the
  steering, the steering self-loop staying inside the round budget, a
  cancel outranking a proposed tool call, and cancelling a turn parked on
  a prompt actually finalizing it.
- Middleware: auth + idempotency + rate-limit end-to-end.

## Containerization

`docker-compose.yml` brings up the server and database. Ollama stays on
the host so models are stored once and can use the host GPU directly:

```yaml
services:
  postgres:       # 5432 published for pnpm dev
  db-init:        # one-shot prisma db push, blocks yap
  yap:            # bound to 3001; connects to host.docker.internal:11434
```

## License

MIT.
