# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm dev                         # tsx watch src/server.ts on :3001
pnpm start                       # same, no watcher
pnpm typecheck                   # tsc --noEmit
pnpm db:push                     # prisma db push --accept-data-loss (dev; no migrations yet)
pnpm db:generate                 # prisma generate (also runs on postinstall)

pnpm test                        # full suite — REQUIRES Postgres on :5432
pnpm test:unit                   # pure modules only, no DB needed
pnpm test:integration            # DB + API + runtime with mocked Ollama
pnpm test:watch                  # vitest watch
pnpm vitest run test/unit/schemas.test.ts           # single file
pnpm vitest run -t 'name pattern'                   # single test by name
```

Integration tests expect `DATABASE_URL=postgres://yap:yap@localhost:5432/yap` (the compose default). `test/setup.ts` sets it if unset. Tests run **serially** (`singleThread: true`, `fileParallelism: false`) because each test `TRUNCATE`s every mutable table — see `test/helpers/db.ts`.

Before running integration tests locally: `docker compose up -d postgres` and `pnpm db:push`.

## Architecture

One Node process, one Hono app, **two HTTP personalities** on the same port:

- **`POST /`** — legacy AG-UI SSE bridge for `ai-remark`. Stateless; each request carries full history. Implemented in `src/ollama-agent.ts` + the `app.post('/')` handler in `src/server.ts`. Do not add persistence here — AG-UI clients expect the thin bridge behavior.
- **`/api/v1/*`** — full chat-product backend for `chat-box`. Stateful, persisted in Postgres via Prisma, streamed over named-event SSE. This is where feature work happens.

The two surfaces share Postgres and the Ollama runtime but have **different event envelopes** (AG-UI `BaseEvent` vs. yap's `BusEvent`) and **must not share middleware** — only `/api/v1/*` gets auth/idempotency/rate-limit.

### `/api/v1` request flow

```
bearerAuth → rateLimit → idempotency → apiV1 router → queries.ts → Prisma → Postgres
                                                   ↓
                                            events/bus.publish
                                                   ↓
                                       insertEvent (persist) → emit (live)
                                                   ↓
                                         stream.ts SSE subscribers
```

Key invariants to preserve when editing:

- **Persist-then-publish.** `events/bus.ts#publish` writes to the `events` table *before* emitting to live subscribers. Never emit without persisting — `?since_event=<id>` replay depends on the DB being the source of truth.
- **Subscribe-first replay in `src/api/stream.ts`.** The stream handler: (1) subscribes to the bus into a buffer, (2) replays persisted events to the wire recording ids, (3) flushes the buffer with id-dedupe, (4) switches to live pump. This closes a race where events emitted between replay-end and subscribe-active would be lost. Don't "simplify" this sequence.
- **Named-event SSE vs. data-only SSE.** `/api/v1` uses named events (`event: node.created\ndata: {...}`) via `src/events/encoder.ts`. The AG-UI surface uses `@ag-ui/encoder`'s data-only frames. They are not interchangeable.

### Runtime agent loop (`src/runtime/run.ts`)

`runAssistantTurn` is an `AsyncGenerator<BusEvent>` that drives the model ⇄ tool loop, bounded by `config.maxToolRounds`. Coordination with HTTP handlers happens through two in-memory coordinators, both implemented as "insert DB row → await promise → HTTP handler resolves":

- `runtime/approvals.ts` — `awaitDecision(approvalId)` blocks until `POST /approvals/:id/decide` resolves it. Three-layer permission model: per-call approval → per-conversation grant (`ApprovalGrant`) → agent-level `auto` flag.
- `runtime/clarifications.ts` — `awaitAnswer(clarifyId)` blocks until `POST /clarify/:id/answer` resolves it. Triggered by the `ask_clarification` pseudo-tool.

Because these coordinators hold promises **in-process**, the server is single-instance by design. Don't introduce multi-process/worker assumptions without also persisting the coordinator state.

### Think-splitter

`runtime/think-splitter.ts` is a streaming state machine that splits Ollama text on `<think>…</think>` boundaries and emits `reasoning.delta` vs. `content.delta` events. Tags can arrive mid-chunk — the splitter buffers partial tag matches. When adding reasoning-model support, route chunks through the splitter; don't regex-on-concat.

### Tools

`src/registry/tools.ts` is the single source of truth for tool definitions AND the `executeTool` dispatcher. The shapes mirror chat-box's `SAMPLE_TOOLS` exactly (id/name/desc/enabled/auto) — keep them in sync. `write_file` is sandboxed to `config.artifactsDir`; the path-traversal check lives in the executor and has unit tests in `test/unit/tools.test.ts` — preserve it.

### Database layer

All Prisma access goes through **typed wrappers in `src/db/queries.ts`** — one function per logical op. API handlers and the runtime should not call `getPrisma()` directly except in narrow cases (the runtime has one documented façade for clarify JSON). This convention is what makes the DB integration test in `test/integration/db.test.ts` a meaningful contract.

Schema is 15 models in `prisma/schema.prisma`. The tree model: `Conversation` has many `Node`s forming a DAG (`parent_id`) with a pointer to `activeLeaf`; edits create branches rather than mutating.

### Schemas (`src/schemas/`)

Zod schemas mirror `chat-box/src/types.ts` wire types. The `BusEvent` union in `src/events/types.ts` is discriminated on `type` and every variant has round-trip coverage in `test/unit/schemas.test.ts`. When adding a new event type: add the Zod variant, re-export through `events/types.ts`, add a fixture to the schema test, and add the encoder-name mapping in `events/encoder.ts`.

## Conventions

- ESM-only (`"type": "module"`); imports use `.js` extensions even for `.ts` sources (bundler moduleResolution).
- Prisma runs on `postinstall`, so `@prisma/client` types are always generated after `pnpm install`.
- Commit message style: short imperative headline with a category prefix (`Testing:`, `API:`, `Runtime:`, `Docs:`, etc.) — follow `git log` for examples. Do not mention Claude/Claude Code in commit messages.
- `src/ollama-agent.ts` is explicitly labeled "legacy" — it powers the AG-UI `POST /` surface and is stable. Feature work belongs in `src/api/` + `src/runtime/`, not here.

## Documentation

- `README.md` — quick start, smoke tests, env vars, phase inventory.
- `INTEGRATION.md` — authoritative guide for AG-UI (`ai-remark`) clients hitting `POST /`.
- `docs/chat-box-integration.md` — authoritative API/SSE/types guide for the chat-box frontend consuming `/api/v1/*`. Update this when changing any wire contract.
- `docs/server-upgrade-plan.md` — historical phased design doc; the shipped surface now matches what's listed here. Treat as reference, not a todo list.
