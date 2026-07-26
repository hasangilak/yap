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

```bash
docker compose up -d postgres            # just the DB — what local dev needs
docker compose up                        # postgres + db-init + yap, pointed at a HOST Ollama
docker compose -f docker-compose.yml up  # self-contained: adds containerized ollama + model pull
```

`docker-compose.override.yml` is committed, so **it applies by default and changes which services exist**: it assigns `ollama` and `model-init` to a `skip` profile (excluding them) and points `yap` at `host.docker.internal:11434`. So a bare `docker compose up` starts only postgres/db-init/yap and *requires* Ollama already running on the host — it does not pull a model. Naming the base file explicitly (`-f docker-compose.yml`) drops the override and gives you the self-contained stack with a containerized Ollama on `ollama:11434`. Verify with `docker compose config --services` before debugging a "missing" container. `db-init` runs `pnpm db:push` on every `up` (no migrations yet).

The Dockerfile pre-builds `chrome-less` in a builder stage — a plain `pnpm install` inside the image will not produce a working browser tool. See the browser-tool section for the `--no-sandbox` build arg.

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

### Runtime agent loop (`src/runtime/graph/`)

The turn is a **LangGraph `StateGraph` checkpointed to Postgres**. `src/runtime/run.ts` is only a façade: `runAgent` / `runAssistantTurn` keep their `AsyncGenerator<BusEvent>` signatures and re-yield events the graph pushes onto its `custom` stream channel.

```
        ┌── steering ──┐
        ▼              │
prepare → callModel → gate → wait → resolvePrompt → execute
              ▲         │                  │           │
              │         └── auto-approved ─┴───────────┤
              └───────────── next round ──────────────┘
                                │
                             finalize → END
```

**Rules that dictate this shape — violating any of them breaks pauses silently:**

- **A node containing `interrupt()` re-executes from the top on resume.** So `gate` holds every side effect (persist the row, emit `prompt.requested`) and `wait` contains *only* `interrupt()`. Never move side effects into `wait`.
- **`interrupt()` propagates by throwing `GraphInterrupt`.** Never wrap `wait` in `try/catch`, or re-throw. The pre-graph loop wrapped a whole round in one `try/catch` that converted throws into `error` events; reintroducing that pattern around a pause turns every approval into a failed turn.
- **Never call `interrupt()` in a loop over a dynamic list** — LangGraph matches interrupts by index, and the docs describe this as exponential re-execution. Tool calls are gated one per `gate`/`wait` pass with a conditional edge looping back.
- **`durability: 'sync'`** on every graph call (`turnConfig`). The default `'async'` can lose a checkpoint if the process dies mid-execution — exactly the failure the graph exists to prevent.
- The façade generator now **ends when the turn pauses**, not only when it completes, because a LangGraph stream terminates at an interrupt. "Generator finished" ≠ "turn finished". The continuation is a separate `resumeTurn()` from whichever endpoint received the answer.

Human input is durable and unified: **every pause is a `Prompt` row**, answered through the single `POST /api/v1/prompts/:id/respond`, which persists the response *then* resumes the graph thread. **`thread_id` is the assistant node id**, so a response finds its paused turn from a database row alone — across requests and across restarts. `src/runtime/recovery.ts` runs before `serve()` and reconciles anything left mid-flight, in this order: **cancelled** is finalized without replaying, waiting-on-human is left alone, crashed-between-supersteps is replayed with `null` input, and no-checkpoint gets `streaming` cleared plus a terminal `error`.

Three invariants in that endpoint, all load-bearing:

- **Persist before resume.** A response written after the resume could be lost to a crash in between.
- **The write is a compare-and-set** on `response IS NULL` (`recordPromptResponse` returns whether it claimed the row). A read-then-write check let two concurrent responses both resume the same turn.
- **The body is validated against the *stored* kind**, so clients don't restate it and a clarify answer posted to an approval prompt is a 400. This is the one endpoint that returns a real 400 on a malformed body — everywhere else `Schema.parse()` throws into Hono and becomes a 500. Don't copy the `.parse()` pattern here.

`edited_args` on an approval response replaces the proposed tool args before `execute` runs (`resolvePromptNode`). It is **not** a trust boundary: `executeTool` validates at execution time, so `write_file`'s sandbox check applies to a human's edit exactly as to a model's proposal — `test/integration/runtime.test.ts` asserts both directions. The in-turn `messages` history deliberately keeps the *original* tool_calls; the node row and event stream carry what actually ran.

The three-layer permission model is unchanged, now in `graph/nodes.ts#isAutoApproved`: session grant (`ApprovalGrant`) → agent `permission_default` → `TOOL_DEFS.auto`.

`graph/checkpointer.ts` owns its own **`langgraph` Postgres schema** (`config.langgraphSchema`) so its four tables never register as drift against Prisma. `test/helpers/db.ts#truncateCheckpoints` clears them; `truncateAll` cannot reach another schema.

### Interrupting a turn — two verbs, don't conflate them

`POST /conversations/:id/cancel` aborts the model call and **ends** the turn; `POST /conversations/:id/interject` aborts it and **continues** with the user's text folded into the next round. Same abort plumbing, opposite effect on the turn.

`graph/steering.ts` is deliberately **in-memory** — it holds only the `AbortController` for the in-flight model call, which cannot outlive the process anyway. Don't "fix" this by persisting it, and never derive that signal from an HTTP request: a client disconnect would kill a turn meant to outlive the request. Everything *else* about both verbs is durable, and that split is the design:

- **Interjected text is a row** (`interjections`). The endpoint returns 200 once it exists, so the user has been told we accepted it; a `Map` would let a restart discard it silently — the same failure the clarify path used to have. `callModel` **peeks** before the round and **consumes after** it finishes streaming, making delivery at-least-once: a crash mid-round re-injects rather than swallowing user input.
- **Cancellation is `Node.cancel_requested`.** Durable because boot recovery replays unfinished turns — an in-memory flag would let a restart resurrect a stopped turn. It also makes a late `POST /prompts/:id/respond` return `cancelled: true` instead of resuming.

Two routing rules in `afterCallModel`, both learned from bugs found against a live Ollama:

- **The round budget is checked first**, so it bounds the `callModel` self-edge as well as the tool loop. Without that a user could keep a turn alive forever by interjecting.
- **`cancelRequested` outranks pending tool calls**; `pendingSteering` sends the loop back to `callModel`. An aborted round is indistinguishable from a finished one by tool calls alone, so without `pendingSteering` a steered turn finalized having accepted the steering and never applied it — and without cancel's precedence, "stop" meant "stop after one more `write_file`".

**A turn parked at an `interrupt()` will never finalize itself**, so `api/cancel.ts` finalizes the node directly in that case. Derive "is a round live?" from the checkpoint (`getPendingInterrupts`), not from the controller map — a stale controller once made `cancel` report `aborted: true` for a parked turn, which skipped that finalize and stranded the node as `streaming` forever. Always clear the controller when a round ends.

The model call lives in `graph/model.ts` via `ChatOllama`. Streaming *and* tool-calling together is load-bearing and fragile upstream (the Python `langchain_ollama` has an open bug where `bindTools` silently collapses streaming into one chunk). `test/integration/runtime.test.ts` mocks `@langchain/ollama` with stringified `tool_call_chunks` to keep that path honest. Aborts are caught, never thrown, so the graph still checkpoints and partial output survives.

### Think-splitter

`runtime/think-splitter.ts` is a streaming state machine that splits Ollama text on `<think>…</think>` boundaries and emits `reasoning.delta` vs. `content.delta` events. Tags can arrive mid-chunk — the splitter buffers partial tag matches. When adding reasoning-model support, route chunks through the splitter; don't regex-on-concat.

### Tools

`src/registry/tools.ts` holds **three lists that must be reconciled by hand** — this is the most common source of confusion:

1. `TOOL_DEFS` — 7 entries, the *display* catalog served to chat-box. Shapes mirror chat-box's `SAMPLE_TOOLS` exactly (id/name/desc/enabled/auto); `enabled: false` renders but isn't selectable.
2. `OLLAMA_TOOLS` — 3 function-calling schemas actually injected into `chat()`: `web_search`, `write_file`, `ask_clarification`. A tool absent here is invisible to the model no matter what `TOOL_DEFS` says.
3. `executeTool` — implements only `web_search` and `write_file`; everything else returns `tool '<name>' is not implemented yet` so the model can recover rather than hang. `ask_clarification` never reaches here — it's a pseudo-tool intercepted by `runtime/run.ts`.

`isSideEffectful()` (`write_file`, `run_tests`, `send_email`) is what routes a call into the approval round-trip. `write_file` is sandboxed to `config.artifactsDir` with a two-layer check (reject `..`/absolute/`~` in the raw arg, then re-verify the *resolved* path is still under the sandbox); unit tests in `test/unit/tools.test.ts` cover it — preserve both layers.

### Browser tool (`src/tools/browser.ts`)

`web_search` is not an HTTP client. Each call `spawn`s `node <chrome-less>/dist/cli.js` as a **subprocess** (resolved via `require.resolve`, overridable with `config.chromeLessBin`), which drives a real Chromium over CDP and prints the page as a numbered accessibility tree. The exported verbs (`webSearch`/`webGoto`/`webClick`/`webType`/`webBack`) all end by running `text` and returning the current page, so the model sees element ids it can click or type into. Searches go through `lite.duckduckgo.com/lite/`.

Consequences: the tool needs a working Chromium on the host, is slow relative to everything else (hence `TOOL_DEADLINE_MS`), and non-zero exit codes throw with stderr folded into the message. Only `web_search` is currently wired into `executeTool` — the other verbs are implemented but unexposed.

**This subprocess renders untrusted third-party pages, so treat it as the least-trusted thing in the process tree.** Two consequences to preserve:

- `browser.ts` hands the child an **allowlisted env** (`PATH`, `HOME`, `TMPDIR`, `CHROME_LESS_CHROME`) rather than `{...process.env}`. Don't widen this back out — the full env carries `DATABASE_URL` and `YAP_API_TOKEN`, which a compromised renderer would otherwise inherit.
- Chromium's own sandbox needs an unprivileged user namespace, which some Docker seccomp profiles deny; the Dockerfile's `CHROME_NO_SANDBOX` build arg (default `1`) injects `--no-sandbox` into chrome-less's hardcoded `CHROME_FLAGS`. Build with `--build-arg CHROME_NO_SANDBOX=0` on a host that permits userns to keep the renderer sandbox.

The `--no-sandbox` patch is applied by `sed` against the vendored fork's build output, so it only exists **inside the image** — a host `pnpm install` gets an unpatched chrome-less, and sandbox-related behavior can differ between the two. The real fix is upstream in `hasangilak/chrome-cli` (a `CHROME_FLAGS` env hook); until then the `sed` is followed by a `grep -q` guard so a pin bump that moves the pattern fails the build instead of silently shipping a broken browser.

All of the above is build-verified: `docker build --check` reports no warnings, both `CHROME_NO_SANDBOX=1` (patch present in `dist/chrome.js`) and `=0` (absent) build clean, and the resulting image boots and serves both HTTP surfaces against a host Postgres and Ollama. Note the build log carries a benign `WARN Failed to create bin at node_modules/.bin/chrome-less` — stage-1 deletes the npm-installed copy before the builder's copy is layered in, so the warning is expected and not a broken install.

### Database layer

All Prisma access goes through **typed wrappers in `src/db/queries.ts`** — one function per logical op. API handlers and the runtime should not call `getPrisma()` directly except in narrow cases (the runtime has one documented façade for clarify JSON). This convention is what makes the DB integration test in `test/integration/db.test.ts` a meaningful contract.

Schema is 15 models in `prisma/schema.prisma`. The tree model: `Conversation` has many `Node`s forming a DAG (`parent_id`) with a pointer to `activeLeaf`; edits create branches rather than mutating.

`Prompt` is one row per human pause, replacing the former `Approval` + `Clarify` pair — same mechanic, discriminated by `kind` with the request/response in JSON. `ApprovalGrant` is deliberately *not* folded in: it is a standing permission keyed by (agent, tool) that outlives the turn, not a per-pause record. Note `Node.approval` is vestigial — nothing in the runtime writes it, and only `dev/seed` fixtures populate it; `Node.clarify` is written only *after* an answer. Neither can tell you a prompt is open, which is what `GET /conversations/:id/prompts?pending=true` is for.

`Interjection` holds mid-turn steering text (see above). `Node.cancel_requested` is the stop flag.

`POST /api/v1/dev/seed` (`src/api/dev.ts` + `src/seed/`) idempotently loads the chat-box `SAMPLE_*` fixtures — agents, conversations, and a branched node tree — to bring a fresh DB to a recognizable state. Safe to re-run; every insert is upsert-no-update.

The seeder deliberately **overrides `streaming`/`status` to falsy** regardless of the fixture. In chat-box's sample data those fields are display hints ("draw a caret"); as DB rows they are a claim that a turn is mid-flight, which boot recovery acts on — `n-07` used to make every restart after a seed report a stranded turn and emit a bogus `error` on `c-01`. Keep the override in `dev.ts` rather than editing `SAMPLE_TREE_NODES`, which mirrors the client fixture.

### Schemas (`src/schemas/`)

Zod schemas mirror `chat-box/src/types.ts` wire types. The `BusEvent` union in `src/events/types.ts` is discriminated on **`kind`** and every variant has round-trip coverage in `test/unit/schemas.test.ts`. When adding a new event type: add the Zod variant, re-export through `events/types.ts`, and add a fixture to the schema test. No encoder change is needed — `encodeSSE` reads `ev.kind` directly, so there is no name mapping to maintain.

Where a variant carries kind-specific sub-payloads (`prompt.requested`/`prompt.responded`), nest them under one field as a **discriminated union on an inner tag** rather than as sibling optional fields. Optionals would let a mismatched pair — `prompt_kind: 'approval'` carrying clarify data — parse into a half-populated object; the nested union rejects it and narrows properly in TS. `test/unit/schemas.test.ts` asserts both directions.

## Conventions

- ESM-only (`"type": "module"`); imports use `.js` extensions even for `.ts` sources (bundler moduleResolution).
- Prisma runs on `postinstall`, so `@prisma/client` types are always generated after `pnpm install`.
- Commit message style: short imperative headline with a category prefix (`Testing:`, `API:`, `Runtime:`, `Docs:`, etc.) — follow `git log` for examples. Do not mention Claude/Claude Code in commit messages.
- `src/ollama-agent.ts` is explicitly labeled "legacy" — it powers the AG-UI `POST /` surface and is stable. Feature work belongs in `src/api/` + `src/runtime/`, not here.
- **`Phase N` / `PHASE-N:` comments are stale scaffolding, not a roadmap.** They describe work that has since shipped (approvals gate through the `gate`/`wait` nodes in `runtime/graph/nodes.ts`; prompts are unified). Trust the code and this file over those markers; delete them when you touch the surrounding lines.
- All tunables funnel through `src/config.ts` (env with defaults) — read config there rather than `process.env` at use sites, and document each one in `.env.example`. The only sanctioned exceptions are process-level plumbing that isn't a product knob (`PATH`/`HOME`/`TMPDIR` when building the browser subprocess env) and `test/setup.ts`.
  

## Git

Commit gradually: one small, logical commit per coherent unit of work, conventional-commit prefix (`docs:`, `feat:`, `fix:`, `chore:`). Commit messages must not mention Claude, Claude Code, or any AI authorship — no `Co-Authored-By` trailer.

## Documentation

- `README.md` — quick start, smoke tests, env vars, phase inventory.
- `INTEGRATION.md` — authoritative guide for AG-UI (`ai-remark`) clients hitting `POST /`.
- `docs/chat-box-integration.md` — authoritative API/SSE/types guide for the chat-box frontend consuming `/api/v1/*`. Update this when changing any wire contract.
- `docs/architecture.md` — Mermaid diagrams of system context, module layout, and the two HTTP surfaces. Start here for structure.
- `docs/data-flows.md` — sequence diagrams for the load-bearing flows (message → stream, approval round-trip, replay).
- `docs/user-stories.md` — the three caller personas (chat-box user, ai-remark user, operator) mapped to endpoints and code paths. Start here for *why* a surface exists.
- `docs/server-upgrade-plan.md` — historical phased design doc; the shipped surface now matches what's listed here. Treat as reference, not a todo list.

Note: `package.json` still names the project `simplest-llm` from its AG-UI-bridge origin. The product is `yap`.
