# Design doc: upgrade `yap` into a chat-box–compatible conversation server

This doc is the phased design for turning yap into the backend that
`chat-box` (`/Users/hassangilak/Work/chat-box/`) expects. It is written
so a future implementer can pick up Phase 1 and execute without
re-deriving the design.

## Context

`chat-box` is today a hardcoded design artifact — every screen reads
from `src/data/sample.ts` (`SAMPLE_TREE`, `SAMPLE_CONVERSATIONS`, etc.);
there are no network calls. `docs/server-spec.md` in that repo
describes the aspirational backend: conversations as message trees,
streamed content and reasoning, tool calls gated by approvals,
clarifications, agents with versions, artifacts, notes, tags, search,
timeline.

`yap` is today ~60 lines: `POST /` speaks AG-UI and bridges to Ollama;
`GET /health` returns config. It is consumed by `ai-remark` and must
keep working.

Goal: grow `yap` into the server `chat-box` expects, without breaking
the AG-UI surface, in independently-shippable phases.

## Strategy

Two HTTP surfaces on one port, one shared Ollama + tool runtime
underneath:

- `POST /` — unchanged AG-UI for `ai-remark`.
- `/api/v1/*` — new chat-box router, different event envelope, full
  persistence.

Storage: SQLite via Node 22's built-in `node:sqlite` (no native deps,
no build step). Requires bumping the Dockerfile base from
`node:20-bookworm-slim` to `node:22-bookworm-slim`.

Seed data is loaded via `POST /api/v1/dev/seed`, never automatically.

Reasoning events are emitted only for thinking models
(`deepseek-r1:*`, `qwq:*`). `qwen2.5:14b` is not one — Phase 1 leaves
the reasoning array empty; a `<think>` tag parser lands in Phase 5b.

## Architecture (Phase 1)

```
chat-box UI ──REST + SSE──►  /api/v1/*  router
ai-remark   ──AG-UI SSE──►  POST /      router
                              │
                              ▼
                        runtime/run.ts (agent loop, pure)
                        │       │       │
                ┌───────┘       │       └─────────┐
                ▼               ▼                 ▼
           Ollama          registry/tools.ts   SQLite (node:sqlite)
                                                   │
                                                   ▼
                                            events/bus.ts (EventEmitter)
                                                   │
                                                   ▼
                                  events/encoder.ts (named-event SSE)
                                            │
                                            └── since_event replay from DB
```

Key properties:

- `runtime/run.ts` is pure (no HTTP); it writes to DB + bus. HTTP
  handlers are thin.
- Every event is persisted before being published, so
  `?since_event=<id>` replay works from day one.
- Bus is process-local; a later phase can swap for Redis pub/sub.

## Phase roadmap

| Phase | Scope                                                                    |
|-------|--------------------------------------------------------------------------|
| 1     | Conversation + node CRUD, linear stream, one read-only tool, stub agents |
| 2     | Tool approvals + permission grants + auto-approve rules                  |
| 3     | Editing (branch), regenerate, ripple, prune, ripple-preview              |
| 4     | Agents CRUD + versions + templates + optimizer/eval stubs                |
| 5a    | Clarifications                                                           |
| 5b    | Reasoning for thinking models (`<think>` parse)                          |
| 6     | Artifacts + version history + diff                                       |
| 7     | Tags, notes, pinned snippets, timeline, search, export, share            |
| 8     | Auth, idempotency, reconnect replay hardening, rate limit, token budget  |

Each phase is independently useful: after Phase 1 a non-stubbed thread
renders end-to-end; after Phase 2 side-effect tools can execute; and
so on.

## Client ↔ server field gotchas

Verified against `chat-box/src/types.ts` on 2026-04-19. These are the
things that will bite an implementer who reads the spec but not the
client types:

- `Role` is `"user" | "asst"` — **not** `"assistant"`.
- `Conversation.agent` is a **display name string** (`"Code Reviewer"`),
  not an ID. The spec calls this field `agent_id`; the client does not.
  Server must keep `agent_id` internally as the FK and translate to the
  display name at the wire boundary.
- `Conversation.updated` is a **display string** (`"11:42"`, `"Today"`),
  not a timestamp. Server stores epoch ms under `updated_at` and
  serializes `updated` per-request.
- `Conversation` on the wire has exactly: `id, title, snippet, agent,
  tag, pinned?, updated, folder`. No timestamps, no ownership, no
  budgets. Server keeps those internally.
- `MessageNode.parent` is the literal field name — not `parent_id` —
  and is `string | null`.
- `MessageNode.time` is a display string (`"11:28"`). Store epoch ms
  under a separate field; serialize `time` per-node.
- `MessageNode.branch` is a string label (`"main"`, `"alt-1"`), not a
  hash or numeric version.
- `MessageNode` on the wire has exactly: `id, parent, role, time,
  branch, content, reasoning?, toolCall?, clarify?, approval?,
  streaming?, status?, edited?`. **No `edited_from_id` on the wire** —
  server records it internally for Phase 3 ripple logic but never
  sends it.
- The tree shape on the wire is flat:
  `MessageTree { rootId, activeLeaf, nodes: Record<string, MessageNode> }`.
- `ToolCallData` is `{ name, args, status, elapsed?, result? }` —
  no `approval_id`. Approvals hang off the node (`node.approval`), not
  the tool call.
- `ApprovalData` in the client is only `{ tool, title, body, preview? }`.
  Decision and grant state from spec §2.5 is server-side; the client
  learns about it via events.
- `ClarifyData` is `{ question, chips, input }` — no `response` field.
  Users answer clarifications by sending a user message.
- `Agent` on the wire is `{ id, name, initial, desc, model, tools, temp }`
  — exactly 7 fields. `tools` is a **count (number)**, not an array.
  `system_prompt`, `variables`, `permission_default`, `top_p`,
  `max_tokens` are builder-form state kept server-side and not sent in
  this shape.
- `Conversation.folder` is sent by the server; the client trusts it.
- `StatusState` is `"thinking" | "pondering" | "tool" | "approval" | "streaming"`
  — five values, spelled exactly.
- `ToolStatus` is `"ok" | "pending" | "err" | "done"`.

---

# Phase 1 — detailed design

Phase 1 delivers: the chat-box main view rendering a real server-backed
thread.

## 1.1 Data model (SQLite)

Schema at `src/db/schema.sql`, applied at boot via a tiny migration
runner that runs `.sql` files in order and tracks them in
`schema_migrations`.

```sql
-- 001_init.sql
CREATE TABLE conversations (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  snippet        TEXT NOT NULL DEFAULT '',
  agent_id       TEXT NOT NULL,
  tag            TEXT,
  pinned         INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  root_node_id   TEXT,
  active_leaf_id TEXT,
  token_budget   INTEGER NOT NULL DEFAULT 200000,
  tokens_used    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE nodes (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  parent_id        TEXT,
  role             TEXT NOT NULL CHECK (role IN ('user','asst')),
  branch           TEXT NOT NULL DEFAULT 'main',
  content          TEXT NOT NULL DEFAULT '',
  reasoning_json   TEXT,
  tool_call_json   TEXT,
  clarify_json     TEXT,
  approval_json    TEXT,
  streaming        INTEGER NOT NULL DEFAULT 0,
  status           TEXT,
  edited           INTEGER NOT NULL DEFAULT 0,
  edited_from_id   TEXT,
  created_at       INTEGER NOT NULL
);
CREATE INDEX idx_nodes_conv_branch_time
  ON nodes(conversation_id, branch, created_at);

CREATE TABLE agents (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  initial        TEXT NOT NULL,
  desc           TEXT NOT NULL DEFAULT '',
  model          TEXT NOT NULL,
  temperature    REAL NOT NULL DEFAULT 0.5,
  top_p          REAL NOT NULL DEFAULT 1.0,
  max_tokens     INTEGER NOT NULL DEFAULT 4096,
  system_prompt  TEXT NOT NULL DEFAULT '',
  tool_ids_json  TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE events (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  id              TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  node_id         TEXT,
  kind            TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  at              INTEGER NOT NULL
);
CREATE INDEX idx_events_conv_seq ON events(conversation_id, seq);
```

Rationale:

- Flat `nodes` table mirrors `MessageTree.nodes` directly.
- `events` is the source of truth for both the live stream and
  `since_event` replay.
- No `tools` table — registry is a static constant in
  `src/registry/tools.ts`; the client treats tools as immutable.
- Internal field names (`agent_id`, `parent_id`, `updated_at`,
  `edited_from_id`) diverge from wire names; translation happens in
  the API layer.

## 1.2 HTTP surface

| Method | Path                                                 | Purpose                                  |
|--------|------------------------------------------------------|------------------------------------------|
| GET    | `/api/v1/conversations`                              | List, pinned desc then updated_at desc   |
| POST   | `/api/v1/conversations`                              | Create `{ agent?, title? }` (agent is display name) |
| GET    | `/api/v1/conversations/:id`                          | `{ conversation, tree }`                 |
| GET    | `/api/v1/conversations/:id/tree`                     | `{ rootId, activeLeaf, nodes }`          |
| POST   | `/api/v1/conversations/:id/messages`                 | Append user node, start asst stream      |
| GET    | `/api/v1/conversations/:id/stream?since_event=<id>`  | SSE (replay + live)                      |
| GET    | `/api/v1/agents`                                     | Seeded agents                            |
| GET    | `/api/v1/agents/:id`                                 | Single agent                             |
| GET    | `/api/v1/tools`                                      | Static registry                          |
| POST   | `/api/v1/dev/seed`                                   | Load `SAMPLE_*` fixtures                 |

All JSON except `/stream` which is `text/event-stream`. CORS wide-open
for localhost, matching the existing AG-UI setup.

## 1.3 Event envelope (spec §4)

Named-event SSE — **different** from AG-UI's type-in-payload form.
Custom encoder at `src/events/encoder.ts`:

```
event: <kind>
id: <event_id>
data: {"at": ..., "node_id": ..., ...payload}

```

Phase 1 kinds (subset of spec §4.2):

- `node.created` — user node, or placeholder asst node before streaming
- `status.update` — `{ state, elapsed_ms, tool? }`; state ∈
  `thinking|streaming|tool`
- `content.delta` — `{ delta }`
- `reasoning.delta` / `reasoning.step.end` — no-op for non-thinking
  models in Phase 1
- `toolcall.proposed` — `{ tool_call }` with `status: "pending"`
  (auto-approved in Phase 1 for read-only tools only)
- `toolcall.started` — `{ tool, args }`
- `toolcall.ended` — `{ status, elapsed_ms, result?, error? }`
- `node.finalized` — final `MessageNode`
- `active_leaf.changed` — `{ conversation_id, active_leaf_id }`
- `error` — `{ message, recoverable }`

Persist-then-publish: every event is written to `events` before going
on the wire. Reconnect with `?since_event=<id>` streams rows
`WHERE seq > :seq` then attaches to the live bus.

## 1.4 Runtime (the agent loop)

`src/runtime/run.ts` — pure function, `AsyncGenerator<BusEvent>`, no
HTTP awareness.

```
1. Insert user node; emit node.created(user)
2. Update conversation.active_leaf_id; emit active_leaf.changed
3. Insert placeholder asst node (streaming=true); emit node.created(asst)
4. Emit status.update(thinking)
5. ollama.chat({ model, messages: walkChain(active_leaf), tools, stream: true })
     - text chunk → append to node.content,
                    emit content.delta + status.update(streaming)
     - tool_call  → persist; emit toolcall.proposed
                    (auto-approve for read-only);
                    emit toolcall.started; dispatch to src/tools/*;
                    emit toolcall.ended; append tool message;
                    continue loop (cap: config.maxToolRounds)
6. Stream end: node.streaming=false; persist final
   content/reasoning/tool_call; emit node.finalized;
   set conversation.active_leaf_id = asst node id;
   emit active_leaf.changed.
7. Any error: emit error; mark node streaming=false; stop.
```

Two consumers:

- `POST /conversations/:id/messages` returns the user node
  synchronously, then kicks off the runtime in a fire-and-forget that
  writes to both DB and bus.
- `GET /conversations/:id/stream` subscribes to the bus (filtered by
  `conversation_id`), encodes to SSE.

Bus = `EventEmitter` keyed by `conversation_id`. Process-local — good
enough until multi-node.

## 1.5 Tools in Phase 1

Registry matches the client's 7 `SAMPLE_TOOLS`, but only
**`web_search`** has a real implementation in Phase 1. It reuses the
existing yap `src/tools/browser.ts` DuckDuckGo helper — no new code.
All others return `{ status: "err", error: "not implemented in Phase 1" }`.

`write_file`, `run_tests`, `send_email` are side-effect tools that
MUST route through approvals (Phase 2), so they remain disabled.

## 1.6 Schema validation

`src/schemas/` — zod schemas mirroring `chat-box/src/types.ts` exactly,
in particular:

- `role = z.enum(['user', 'asst'])`
- `MessageNodeSchema` — `time: string`, `branch: string`,
  `parent: string | null`, flat tree
- `ConversationSchema` — `agent: string` (display name), `updated: string`
- `AgentSchema`, `ToolCallDataSchema`, `ApprovalDataSchema`, etc.

Every route boundary runs `zod .parse`. Server internals use the
parsed types so any drift from the client surfaces immediately.

## 1.7 File layout (additions only)

```
simplest-llm/
├── src/
│   ├── server.ts                 (extend: mount /api/v1 router)
│   ├── config.ts                 (extend: add dbPath)
│   ├── ollama-agent.ts           (existing, keep for /)
│   ├── system-prompt.ts          (existing)
│   ├── tools/
│   │   ├── browser.ts            (existing, reused)
│   │   └── schemas.ts            (existing, AG-UI tool schemas)
│   ├── api/                      NEW
│   │   ├── index.ts              (Hono sub-app)
│   │   ├── conversations.ts
│   │   ├── messages.ts
│   │   ├── stream.ts
│   │   ├── agents.ts
│   │   ├── tools.ts
│   │   └── dev.ts                (seed endpoint)
│   ├── db/                       NEW
│   │   ├── index.ts
│   │   ├── schema.sql
│   │   └── queries.ts
│   ├── events/                   NEW
│   │   ├── bus.ts
│   │   ├── encoder.ts
│   │   └── types.ts              (BusEvent union)
│   ├── runtime/                  NEW
│   │   └── run.ts
│   ├── registry/                 NEW
│   │   └── tools.ts              (7 tools matching client SAMPLE_TOOLS)
│   ├── schemas/                  NEW
│   │   ├── conversation.ts
│   │   ├── node.ts
│   │   ├── agent.ts
│   │   └── events.ts
│   └── seed/                     NEW
│       └── samples.ts
├── Dockerfile                    (bump: node:20 → node:22)
└── package.json                  (add zod; use built-in node:sqlite)
```

## 1.8 Files to modify

- `src/server.ts` — mount `/api/v1` alongside `POST /` and `GET /health`.
- `src/config.ts` — add `dbPath` (default `./data/yap.db`); mkdir
  parent on boot.
- `Dockerfile` — base image `node:22-bookworm-slim` (no extra system
  packages needed).
- `docker-compose.yml` — named volume for the SQLite file.
- `package.json` — add `zod`; bump `engines.node` to `>=22`.

## 1.9 Reuse (no new code needed)

- `src/tools/browser.ts::webSearch()` returns the DuckDuckGo result
  tree as-is — Phase 1 dispatcher calls it directly.
- `src/ollama-agent.ts` — message-history walking + Ollama streaming
  loop is the reference for `src/runtime/run.ts`; most of it transplants
  with AG-UI event emission swapped for `BusEvent`s.
- `src/system-prompt.ts` — default agent's prompt until agents are
  editable (Phase 4).
- `@ag-ui/encoder` remains for the legacy `/` endpoint; the new
  encoder is distinct because the envelope differs.

## 1.10 Phase-N markers

Each deferred hook gets a `// PHASE-N:` comment at the exact call site
so later PRs are mechanical:

- `// PHASE-2:` approval gate inside the tool dispatcher.
- `// PHASE-3:` ripple regeneration on `POST /nodes/:id/edit`.
- `// PHASE-5b:` `<think>` tag parser in the content handler.

## 1.11 Verification (end-to-end)

Every step is `curl`-assertable.

1. Clean boot: `docker compose up --build`;
   `GET /api/v1/conversations` returns `[]`.
2. `POST /api/v1/dev/seed` returns
   `{ ok: true, conversations: 8, agents: 6 }`.
3. `GET /api/v1/conversations` returns 8 entries, pinned first, then
   by `updated_at` desc.
4. `GET /api/v1/conversations/c-01` returns `{ conversation, tree }`
   with tree nodes `n-01..n-07, n-03b, n-04b`.
5. Streaming round-trip:
   - Listener: `curl -N http://localhost:3001/api/v1/conversations/c-01/stream`
   - Sender: `curl -X POST .../c-01/messages -d '{"content":"hello"}'`
   - Listener must receive, in order: `node.created(user)`,
     `active_leaf.changed`, `node.created(asst)`,
     `status.update(thinking)`, ≥1× `content.delta`, `node.finalized`,
     `active_leaf.changed`.
6. Tool round-trip: prompt `"search the web for rust async book"`.
   Expect `toolcall.proposed` → `toolcall.started` →
   `toolcall.ended(status=ok, result=<md tree>)`, and the final
   `node.finalized` carries that tool call.
7. Reconnect replay: note last `id:` seen, kill listener, re-open with
   `?since_event=<id>` — events emitted during the gap must be
   replayed, then live.
8. Schema drift guard: a `vitest` test round-trips `SAMPLE_TREE` from
   the client through the server zod schemas; all sample nodes parse.
9. AG-UI regression: the existing `POST /` still streams AG-UI events
   for a `RunAgentInput` from the current README.
10. Client smoke: in chat-box `App.tsx`, replace `SAMPLE_TREE` with a
    fetch to `GET /api/v1/conversations/c-01`. Thread renders
    identically.

## 1.12 Defaults (revisit when implementing, not blockers)

1. `POST /conversations` with no `agent`: default to first seeded
   agent (`a-01`, name `"Code Reviewer"`).
2. ID style: prefix-ulid (`c-<ulid>`, `n-<ulid>`, `a-<ulid>`).
3. `time` / `updated` format: `HH:MM` for today, `Mon 14:03` for
   older; client may reformat.
4. Per-conversation model: agent's `model`; fall back to
   `config.defaultModel` if Ollama doesn't have it pulled, and emit a
   status event annotating the fallback. Seeded agents all use
   `qwen2.5:14b`.
5. DB location: `./data/yap.db`, gitignored, Docker-volume persisted.
6. Token counting: Phase 1 returns `tokens_used = 0`. Real counting
   lands in Phase 8.
