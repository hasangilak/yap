# chat-box → yap: integration guide

**For the team building the `chat-box` frontend at
`/Users/hassangilak/Work/chat-box/`. This document is the authoritative
read on the server side of the wire: every endpoint, every event, every
wire shape, every happy path, every error path. Read this before writing
a single fetch.**

---

## 0. TL;DR

- The yap server implements every endpoint and event described in
  `chat-box/docs/server-spec.md` plus a few operational extras
  (`/api/v1/dev/seed`, `/api/v1/agents/:id/full`, `X-Idempotent-Replay`
  header).
- Transport is plain HTTP + JSON + one SSE stream per live
  conversation. No WebSocket.
- Base URL is `http://localhost:3001/api/v1` (configurable).
- Optional bearer-token auth gate: set `YAP_API_TOKEN` on the server →
  every request must carry `Authorization: Bearer <token>`.
- All mutating POSTs (including `POST /messages`, prompt responses, agent
  PATCH, etc.) accept an `Idempotency-Key` header; the server
  de-duplicates retries for 24h.
- A shared Postgres DB is the durable state of record. Every BusEvent
  is persisted before publication, so `GET /stream?since_event=<id>`
  always replays a clean tail after reconnect.
- **⚠️ BREAKING: approvals and clarifications are now one "prompt"
  concept** — `prompt.requested` / `prompt.responded` and a single
  `POST /prompts/:id/respond`. Four event kinds and two endpoints are
  gone. **Start at §0.5**, which has the migration checklist.
- **Pauses for human input are durable.** A prompt can be answered
  minutes later, or after a server restart, and the turn still resumes.
  Users can also **edit a proposed tool call's arguments** before
  approving it.
- **A running turn can be stopped or steered** —
  `POST /conversations/:id/cancel` (the stop button: aborts and ends the
  turn) and `POST /conversations/:id/interject` (aborts and continues
  with new guidance). See §0.5.8; they are easy to confuse.

---

## 0.5 BREAKING: durable prompts replace approvals + clarifications

Two changes shipped together. The first is invisible to you; the second
requires code changes in chat-box.

1. The turn runtime is a **LangGraph state graph checkpointed to
   Postgres**, so a pause for human input survives a server restart.
2. **Approvals and clarifications are now one thing: a *prompt*.** One
   table, one event pair, one endpoint. This breaks the wire.

Read §0.5.3 for the migration checklist. Everything in this section is
verified against a running server, not inferred from the code.

### 0.5.1 Why the collapse

An approval and a clarification were always the same mechanic — persist a
row, pause the turn, resume when a human answers. They were separate only
because they were built in different phases. Keeping them separate meant
two endpoints, four event kinds, two DB tables and two client code paths
for one concept, and every new capability (editable args, several open at
once, steering) had to be built twice.

They are now one `prompt` with a `prompt_kind` discriminator.

The durability half fixes a worse problem: a paused turn used to live in
an **in-process promise**. A restart while an approval was on screen
destroyed the turn permanently — the row stayed undecided, the node
stayed `streaming: true`, and nothing ever revisited it. The user saw a
card that never resolved and a spinner that never stopped. Now a decision
resumes the turn from any request, in any process, at any later time.

### 0.5.2 The full breaking list

**Events** — four kinds become two:

| Removed | Replaced by |
|---|---|
| `approval.requested` | `prompt.requested` with `request.prompt_kind: 'approval'` |
| `clarify.requested` | `prompt.requested` with `request.prompt_kind: 'clarify'` |
| `approval.decided` | `prompt.responded` with `response.prompt_kind: 'approval'` |
| `clarify.answered` | `prompt.responded` with `response.prompt_kind: 'clarify'` |

```jsonc
// prompt.requested — approval
{
  "kind": "prompt.requested",
  "id": "f9742f26-…", "at": 1785100735157, "conversation_id": "c-dd3cb1ee",
  "node_id": "n-0cc9eace",
  "prompt_id": "pr-f015ff0b",
  "tool": "write_file",
  "request": {
    "prompt_kind": "approval",
    "approval": { "tool": "write_file", "title": "Run write_file",
                  "body": "Write or edit a file. Requires approval.",
                  "preview": "{\"content\":\"original text\",\"path\":\"draft.txt\"}" }
  }
}

// prompt.requested — clarify
{
  "kind": "prompt.requested", "node_id": "n-e5348474",
  "prompt_id": "pr-0e3ac2cb", "tool": "ask_clarification",
  "request": {
    "prompt_kind": "clarify",
    "clarify": { "question": "Which format do you prefer for the summary?",
                 "chips": [ { "id": "c-0", "label": "Bullet points" },
                            { "id": "c-1", "label": "Paragraph" } ],
                 "input": "" }
  }
}

// prompt.responded — approval, with the user's edit
{
  "kind": "prompt.responded", "node_id": "n-0cc9eace",
  "prompt_id": "pr-f015ff0b", "tool": "write_file",
  "response": {
    "prompt_kind": "approval",
    "decision": "allow",
    "edited_args": { "path": "edited-by-human.txt", "content": "the human rewrote this" }
  }
}

// prompt.responded — clarify
{
  "kind": "prompt.responded", "node_id": "n-e5348474",
  "prompt_id": "pr-0e3ac2cb", "tool": "ask_clarification",
  "response": {
    "prompt_kind": "clarify",
    "answer": { "selected_chip_ids": ["c-0"], "text": "bullets, five max" }
  }
}
```

The kind-specific data is **nested** under `request` / `response` rather
than sitting as sibling optional fields. That is deliberate: it narrows
in TypeScript (`ev.request.prompt_kind === 'approval'` proves
`ev.request.approval` exists) and it makes a mismatched pair fail
validation instead of parsing into a half-populated object.

**Endpoints** — two become one:

| Removed (now 404) | Replaced by |
|---|---|
| `POST /approvals/:id/decide` | `POST /prompts/:id/respond` |
| `POST /clarify/:id/answer` | `POST /prompts/:id/respond` |

`GET /approvals/grants` and `DELETE /approvals/grants/:key` are
**unchanged** — a grant is a standing permission keyed by (agent, tool),
not a per-pause record, so it outlives the turn and kept its own routes.

**New endpoints:**

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/prompts/:id` | One prompt with its request and response state |
| `GET` | `/conversations/:id/prompts?pending=true` | Every open prompt, newest first |

**Ids:** prompt ids are `pr-<8 hex>`. The old `ap-…` and `cl-…` prefixes
are gone.

**Response-field renames from the durability work** (these would have
broken a client that read them; chat-box did not):
`runtime_awake` → `resumed` on both former endpoints.

### 0.5.3 chat-box migration checklist

Concrete, against the files we read in your repo:

- [ ] **`src/api/approvals.ts`** — replace `decideApproval(id, decision)`
      with `respondToPrompt(id, body)` hitting
      `POST /prompts/:id/respond`. Keep the grants functions as they are.
- [ ] **`src/api/clarify.ts`** — delete; it becomes the same call with a
      different body.
- [ ] **`src/state/threadReducer.ts`** — the `approval.decided` (line
      153) and `clarify.answered` (line 166) no-op cases become one
      `prompt.responded` case, and `approval.requested` /
      `clarify.requested` become one `prompt.requested`. **Do not leave
      `prompt.responded` a no-op** — see the reload bug below.
- [ ] **`ApprovalCard.tsx`** — stop holding decided state in
      `useState`. Drive it from the reducer, and treat `409` as settled.
- [ ] **Key prompt UI by `prompt_id`**, not by "the turn's one
      approval". Several prompts will be open at once.
- [ ] **Add an `edited_args` affordance** — the user can now rewrite a
      proposed tool call's arguments before allowing it.

**The reload bug this fixes.** `ApprovalCard` currently does:

```tsx
const [decision, setDecision] = useState<Decision | null>(null);
await decideApproval(approval.id, d);
setDecision(d);
```

That was survivable when a pause could not outlive the page. Now a pause
outlives both the page and the server, so on reload the card rebuilds
from the request event — which nothing clears — and renders **live
buttons for an already-answered prompt**. Clicking returns `409`. Handle
`prompt.responded` in the reducer and the problem disappears, including
across tabs.

**Or skip replay entirely.** New in this change:
`GET /conversations/:id/prompts?pending=true` returns exactly what the
conversation is waiting on. Previously a client could *only* learn this by
replaying the event log — the node row is no help, because `node.approval`
is never written by the runtime at all and `node.clarify` is only filled in
*after* the answer (see the caveat in §5.2). One request on mount now
rebuilds every open prompt.

### 0.5.4 `edited_args` — what it means for the UI

An approval response may carry `edited_args`, and if it does, **the tool
ran with those arguments, not the ones the model proposed**. Anything
rendering history from the event stream must show the edited values or it
misreports what happened. `toolcall.started` also carries the edited args,
so the two agree.

Verified end-to-end: the model proposed `draft.txt`, the user submitted
`edited-by-human.txt`, the tool wrote `edited-by-human.txt`, and
`draft.txt` was never created.

Two things to know:

- `edited_args` is **dropped when `decision` is `deny`** — a denial has
  nothing to edit, and storing args would imply the call ran.
- Editing is **not** a way around tool restrictions. `write_file` is
  sandboxed at *execution* time, so an edited path escapes nothing; a
  `../../escaped.txt` edit comes back as `toolcall.ended` with
  `status: 'err'`. Feel free to let users edit freely — the server is the
  one enforcing.

### 0.5.5 `POST /prompts/:id/respond`

Body depends on the prompt's kind — **you do not restate the kind**, the
server reads it from the stored row:

```jsonc
// kind: 'approval'
{ "decision": "allow" | "always" | "deny",
  "edited_args": { … }?  }          // optional; ignored on deny

// kind: 'clarify'
{ "selected_chip_ids": ["c-0"],     // optional, defaults []
  "text": "bullets, five max" }     // optional, defaults ""
```

Responses:

```jsonc
200 { "ok": true, "prompt_id": "pr-f015ff0b", "kind": "approval", "resumed": true }
200 { "ok": true, "prompt_id": "pr-f015ff0b", "kind": "approval", "resumed": false }
400 { "error": "invalid body for an approval prompt", "expected": {…}, "issues": [...] }
404 { "error": "not found" }
409 { "error": "already responded", "response": { "prompt_kind": "approval", "decision": "allow", … } }
```

- **`resumed: false` is not an error.** It means there was no paused turn
  to continue — already finished, or a checkpoint that predates the graph
  runtime. The response is still recorded and the event still published.
- **`409` carries the winning response.** Render it instead of an error;
  the prompt is settled, just not by this click.
- **`400` means the body did not match the prompt's kind** — e.g. a
  clarify answer sent to an approval prompt. `issues` is the raw Zod
  issue list. (Note: this endpoint returns a proper 400; most other
  endpoints in this API still return 500 on a malformed body. That is a
  known wart, not a contract.)

Concurrency is safe: the response write is a compare-and-set, so two
simultaneous responses resolve to exactly one `200` and one `409`, never
two resumes.

### 0.5.6 One new message you may see

Boot recovery reconciles turns that were mid-flight when the server
stopped. A turn with no usable checkpoint gets a terminal `error`:

```
turn was interrupted by a server restart and cannot be resumed
```

This is an existing kind (`error`), so it already routes to `lastError`.
Worth special-casing: it is not a model failure, and the right affordance
is "regenerate", not "retry request". Recoverable turns produce no such
event — they just continue.


### 0.5.7 Behaviour that is now genuinely different

- **A pause has no timeout.** It survives indefinitely. Don't build UI
  that assumes a pending prompt is fresh — show when it was requested
  (`created_at` on the prompt row).
- **Reconnect mid-pause works.** `?since_event=<id>` replays the turn up
  to the pause and then sits live. Verified across a `SIGKILL`: no gaps,
  no duplicates.
- **`prompt.responded` arrives after the HTTP 200**, emitted by the graph
  so it stays ordered with the rest of the turn. Don't treat the HTTP
  response as the signal that the event has been published.
- **Turns outlive the request that started them.** Already true, now more
  visible: `POST /messages` returns once the user node exists, and
  everything after arrives on the stream.

### 0.5.8 Interrupting a running turn: two different verbs

Both additive — nothing breaks. But **pick the right one**, because they
do opposite things to the turn:

| | `POST /:id/cancel` | `POST /:id/interject` |
|---|---|---|
| Model call | aborted | aborted |
| The turn | **ends** | **keeps running** |
| Next step | waits for the user's next message | runs another round with your text |
| Body | none | `{ text }` |
| Use for | the **stop button** | "actually, do it this way instead" |

**`cancel` is the one a chat UI needs first.** It is the stop button: the
assistant stops, the node finalizes, and nothing else happens until the
user sends a new message. `interject` is the more unusual verb — it keeps
one assistant turn alive and redirects it.

```jsonc
POST /api/v1/conversations/c-1/cancel      // no body

200 { "ok": true, "node_id": "n-d1ad6797",
      "aborted": true,      // a live model call was cut off
      "finalized": false }  // the graph will emit node.finalized
409 { "error": "no turn in flight for this conversation" }
```

You then receive, in this order:

```
turn.cancelled        ← always first, so you can label what follows
content.delta         ← the splitter flush; partial text is kept
node.finalized
active_leaf.changed
```

`turn.cancelled` is a new additive event:

```jsonc
{ "kind": "turn.cancelled", "node_id": "n-d1ad6797",
  "aborted": true, "finalized": false }
```

Render it as **"stopped"**, not "complete" — the assistant text ends
mid-sentence and that should look deliberate. It always arrives *before*
`node.finalized`, in both the generating and the parked case, so you can
label the finalization without knowing which path it took.

Three things worth knowing:

- **Partial output is kept.** Verified live: 14 deltas of essay, stop,
  and the node keeps `"To write an extensive essay on the history of
  Amsterdam, I will first conduct"`. Tokens the user already watched
  arrive are not thrown away.
- **Cancel outranks a proposed tool call.** If the model asked for
  `write_file` in the round you cancelled, the tool does **not** run and
  no approval prompt appears. Stop means stop.
- **You can cancel a turn parked on an approval**, and you should offer
  that — otherwise a user who doesn't want to decide has no way out. The
  response comes back `aborted: false, finalized: true` (there was no
  live call; the server closed the node itself). If they then click
  Allow anyway, `POST /prompts/:id/respond` returns
  `{ resumed: false, cancelled: true }` — the turn stays ended. Treat
  that as success, not an error.
- **Cancelling survives a restart.** The flag is persisted, so boot
  recovery finalizes a cancelled turn rather than resurrecting it.

`cancel` is idempotent while the turn is still live; once it has
finalized, a second call returns 409.

#### Mid-turn steering (`interject`)

`POST /api/v1/conversations/:id/interject` pushes text into a turn that
is **already running**, without cancelling it. Think "actually, stop and
just summarise" while the assistant is three paragraphs into an essay.

```jsonc
POST /api/v1/conversations/c-1/interject
{ "text": "Stop the essay. Reply with only: I was steered." }

200 { "ok": true, "interjection_id": "ij-972aaaa8",
      "node_id": "n-624fb540", "aborted": true }
409 { "error": "no turn in flight for this conversation" }
400 { "error": "invalid body", "expected": { "text": "non-empty string" }, ... }
```

One new event kind, `interjection.received` — **additive**, so a client
that ignores unknown kinds is unaffected:

```jsonc
{
  "kind": "interjection.received",
  "node_id": "n-624fb540",
  "interjection_id": "ij-972aaaa8",
  "text": "Stop the essay. Reply with only: I was steered.",
  "aborted": true
}
```

**What `aborted` means, and why you want it in the UI.** `true` means the
model was genuinely cut off mid-sentence, so the `content.delta`s that
came before it end in a half-finished thought. `false` means there was no
live model call to interrupt — the turn was paused on a prompt, between
rounds, or running in another process — and the text is queued for the
next round instead. **`false` is not an error**; the interjection is
recorded either way.

Verified end-to-end against a live model: 11 deltas of essay, interject,
`aborted: true`, then the turn continued into a new round and finished
with `"To write an essay on the history of Dutch windmills,I was steered
mid-turn."` Note the shape of that string — the partial text is
**kept**, not discarded, and the steered reply is appended to it. If you
render `node.content` you will see the seam. That is deliberate: throwing
away tokens the user already watched arrive would be worse.

Three things to design for:

- **The turn does not end.** It keeps streaming, so don't tear down the
  live UI on a 200. If you want it to end, that is `cancel` above.
- **The text is durable, the abort is not.** The row is written before the
  response, so an interjection survives a restart — tested by killing the
  server mid-round and watching boot recovery replay it and apply it. The
  abort is best-effort on top.
- **Steering rounds are capped** by `MAX_TOOL_ROUNDS`, the same budget as
  tool loops. A user cannot keep a turn alive forever by interjecting.

### 0.5.9 Still coming

Not shipped, not yet breaking:

- **Several prompts open at once**, answerable in any order. The wire is
  already shaped for it (`prompt_id`-keyed, `?pending=true` returns a
  list) — the runtime still gates one tool call at a time, so today you
  will only ever see one open. Build for the list anyway.

---

## 1. Mental model

### 1.1 What chat-box needs from a server

`chat-box/src/types.ts` and the six-panel UI boil down to:

1. **A conversation list** that renders in a sidebar, grouped by
   folder bucket + tag.
2. **A message tree** per conversation, rendered linearly along the
   active leaf, with visible branch-siblings as an affordance.
3. **Streamed assistant turns** — reasoning steps as they're thought,
   content as it's typed, tool calls as they run, artifacts as they
   get written.
4. **Structured interruption primitives** — approvals and
   clarifications that pause the turn until the user reacts.
5. **An inspector** that surfaces a timeline, the current agent, and
   thread notes.
6. **An agent builder** where the user names, prompts, and tunes
   agents with a version history.
7. **A canvas** for artifacts the assistant writes.
8. **A share/export path** to let a thread travel.

### 1.2 What yap provides

One Node process (see `docker-compose.yml`) running three things:

- **Postgres 17** as the data store (Prisma-managed).
- **Ollama** for the LLM runtime (default `qwen2.5:14b`, swap for
  `deepseek-r1:14b` to activate reasoning events).
- **yap** itself, a Hono server exposing two HTTP surfaces:
  - `POST /` — legacy AG-UI protocol (unrelated to chat-box; consumed
    by the `ai-remark` project).
  - `/api/v1/*` — **this is the surface chat-box uses**, described in
    full below.

The yap server owns the conversation tree, publishes every event to
the `events` table before emitting it on SSE, gates tool calls behind
an approval model, and writes artifacts to a sandboxed directory.

### 1.3 Runtime flow (sketch)

```
┌──────────────────┐   POST /messages    ┌──────────────────────────┐
│ chat-box client  │ ───────────────────▶│ LangGraph turn graph     │
│                  │                     │                          │
│ fetch stream     │◀── SSE events ──────│  prepare → callModel     │
│ /stream          │                     │  gate → wait(pause!)     │
│                  │                     │  execute → finalize      │
│ POST /prompts/   │                     │                          │
│   :id/respond ───┼── resume ──────────▶│                          │
└──────────────────┘                     └───────────┬──────────────┘
                                                     │
                                                     ▼
                                       ┌──────────────────────────┐
                                       │ Postgres                 │
                                       │  public: nodes, events,  │
                                       │    prompts, …            │
                                       │  langgraph: checkpoints  │
                                       └──────────────────────────┘
```

- A user message creates a user node + fires an assistant turn.
- The runtime streams content/reasoning/tool calls, persisting each
  event and publishing it onto the in-process bus.
- One SSE channel per conversation carries those events to any open
  client. The stream follows the **conversation**, not whoever is
  producing — so it keeps working when a turn resumes in a later
  request or a different process.
- When a prompt is raised the graph **checkpoints and stops**. A
  `POST /prompts/:id/respond` resumes it from that checkpoint. This is the
  part that used to be an in-process promise; see §0.5.
- Every mutation is durable in Postgres; reconnects replay from the
  `events` table.

---

## 2. Running the server

### 2.1 From the chat-box repo's perspective

The yap server and chat-box are separate projects. In a typical dev
loop:

```bash
# One terminal (yap):
cd /Users/hassangilak/Work/simplest-llm
docker compose up -d postgres
pnpm install
pnpm db:push
pnpm dev
# → yap listening on http://localhost:3001

# Another terminal (chat-box):
cd /Users/hassangilak/Work/chat-box
npm install
npm run dev
# → Vite on http://localhost:5173
```

Or the full container stack for an integration test:

```bash
cd /Users/hassangilak/Work/simplest-llm
MODEL=qwen2.5:14b docker compose up --build
# starts postgres, ollama (pulls the model on first run), yap on :3001
```

### 2.2 Environment variables yap reads

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `3001` | yap listen port |
| `DATABASE_URL` | `postgres://yap:yap@localhost:5432/yap` | Prisma DSN |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama server |
| `MODEL` | `qwen2.5:14b` | Default model |
| `ARTIFACTS_DIR` | `../artifacts` relative to repo | `write_file` sandbox root |
| `YAP_API_TOKEN` | *(empty)* | If set, required as `Authorization: Bearer <token>` on `/api/v1` |
| `MAX_TOOL_ROUNDS` | `8` | Hard stop on model → tool → model loops |
| `TOOL_DEADLINE_MS` | `30000` | Per-round Ollama stream deadline |
| `RATE_LIMIT_RPM` | `60` | Per-identity rpm cap |

### 2.3 Health check

```
GET /health → { "ok": true, "model": "...", "ollamaHost": "..." }
```

No auth, no rate limit. Use it as a liveness probe.

---

## 3. HTTP API reference

Every route below is rooted at `/api/v1`. All request + response
bodies are JSON unless noted. When auth is on, add
`Authorization: Bearer <token>` to every request except
`GET /api/v1/shared/:token` which is intentionally public.

### 3.1 Conversations

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/conversations` | List, pinned desc then `updated_at` desc |
| `POST` | `/conversations` | Create `{ agent?, title? }` |
| `GET` | `/conversations/:id` | `{ conversation, tree }` — both shapes in one hit |
| `GET` | `/conversations/:id/tree` | `{ rootId, activeLeaf, nodes }` only |
| `POST` | `/conversations/:id/messages` | Append user node, start asst turn. Returns the user node synchronously. |
| `GET` | `/conversations/:id/stream?since_event=<id>` | SSE stream of BusEvents for this conversation |
| `GET` | `/conversations/:id/artifacts` | Artifact[] |
| `POST` | `/conversations/:id/tags` | `{ tag_id }` or `{ name }` — attach |
| `DELETE` | `/conversations/:id/tags/:tagId` | Detach |
| `GET` | `/conversations/:id/timeline` | `TimelineEvent[]` synthesized from raw events |
| `GET` | `/conversations/:id/notes` | `{ conversation_id, body, updated_at }` |
| `PUT` | `/conversations/:id/notes` | Upsert `{ body }` |
| `GET` | `/conversations/:id/pinned-snippets` | `PinnedSnippet[]` |
| `POST` | `/conversations/:id/pinned-snippets` | Create `{ source_node_id, label, excerpt }` |
| `GET` | `/conversations/:id/export?format=md\|json` | Human-readable markdown or full JSON |
| `POST` | `/conversations/:id/share` | Mint (or reuse) share token — `{ share_token, public_url }` |
| `DELETE` | `/conversations/:id/share` | Revoke the token |

#### POST body shapes

```ts
// POST /conversations
interface CreateConversationRequest {
  agent?: string;   // display name (e.g. "Code Reviewer") OR agent id (e.g. "a-01").
                    // If omitted → first seeded agent.
  title?: string;
}

// POST /conversations/:id/messages
interface PostMessageRequest {
  parent?: string | null;   // optional; defaults to current active_leaf_id
  content: string;          // required, non-empty
}
// Response: the new user node (MessageNode), with status 201.

// POST /conversations/:id/tags
interface AttachTagRequest {
  tag_id?: string;
  name?: string;            // one of the two is required
}

// PUT /conversations/:id/notes
interface PutNoteRequest { body: string; }

// POST /conversations/:id/pinned-snippets
interface CreatePinnedSnippetRequest {
  source_node_id: string;
  label: string;
  excerpt: string;
}
```

### 3.2 Nodes (tree operations)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/nodes/:id/edit` | Create sibling user node on fresh `alt-N` branch with new content. `{ content, ripple?: boolean }`. If `ripple:true`, runs a fresh assistant reply under the new user node. |
| `POST` | `/nodes/:id/branch` | Create empty user sibling on new `alt-N`; composer opens. |
| `POST` | `/nodes/:id/regenerate` | Given an assistant node, create a new asst reply under the same parent user node on a new `alt-N`. |
| `DELETE` | `/nodes/:id?subtree=true[&fallback_leaf=<id>]` | Prune subtree. If `active_leaf` is inside, a fallback is required. Returns `{ ok, removed }`. |
| `GET` | `/nodes/:id/ripple-preview` | `{ descendant_count, tool_calls_to_replay, approvals_required }` |

### 3.3 Agents

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/agents` | List thin 7-field `Agent` shape |
| `POST` | `/agents` | Create — returns `AgentFull` |
| `GET` | `/agents/:id` | Thin shape |
| `GET` | `/agents/:id/full` | Full editable shape |
| `PATCH` | `/agents/:id` | Apply patch + auto-create new `AgentVersion` |
| `DELETE` | `/agents/:id` | Soft-delete (versions survive) |
| `GET` | `/agents/:id/versions` | `AgentVersion[]`, newest-first |
| `GET` | `/agents/:id/versions/:v` | Single `AgentVersion` |
| `POST` | `/agents/:id/versions/:v/restore` | Append new version with the historical snapshot — `{ agent, version }` |
| `GET` | `/agents/:id/versions/:v/diff?against=:w` | `{ a, b, changed_fields }` |
| `POST` | `/agents/:id/optimize` | Stub — `{ agent_id, suggestion: OptimizerSuggestion }` |
| `POST` | `/agents/:id/eval/run` | Stub — `{ agent_id, job_id, status }` |
| `GET` | `/agents/:id/eval/runs/:jobId` | Stub — `EvalResult` |
| `GET` | `/agent-templates` | Starter catalog |
| `POST` | `/agents/from-template/:tpl` | Instantiate — returns `AgentFull` |

#### PATCH semantics

```ts
// PATCH /agents/:id
interface PatchAgentRequest {
  name?: string;
  initial?: string;
  desc?: string;
  model?: string;
  temperature?: number;       // 0..2
  top_p?: number;             // 0..1
  max_tokens?: number;        // >=1
  system_prompt?: string;
  variables?: AgentVariable[];
  tool_ids?: string[];
  permission_default?: 'ask_every_time' | 'auto_allow_read' | 'auto_allow_all';
  message?: string;           // commit-style message stored on the new version
}
// Response:
interface PatchAgentResponse {
  agent: AgentFull;           // post-patch state
  version: AgentVersion;      // the row just written (monotonic version)
}
```

### 3.4 Tools

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/tools` | Static registry — `ToolDef[]` (the 7 client-shaped defs) |

### 3.5 Prompts (approvals + clarifications)

Every pause awaiting a human is a *prompt*. See §0.5 for the full
breaking-change story and body shapes.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/prompts/:id/respond` | Answer a prompt and resume the paused turn |
| `GET` | `/prompts/:id` | One prompt: request payload + response state |
| `GET` | `/conversations/:id/prompts` | All prompts for a conversation, newest first |
| `GET` | `/conversations/:id/prompts?pending=true` | Only the unanswered ones |

`PromptRow` wire shape:

```jsonc
{
  "id": "pr-f015ff0b",
  "conversation_id": "c-dd3cb1ee",
  "node_id": "n-0cc9eace",
  "kind": "approval",              // 'approval' | 'clarify'
  "tool": "write_file",            // 'ask_clarification' for clarify prompts
  "request":  { "prompt_kind": "approval", "approval": { … } },
  "response": null,                // PromptResponse once answered
  "responded_at": null,
  "created_at": "2026-07-26T21:18:55.154Z"
}
```

The response is persisted **before** the turn is resumed, so an answer is
never lost to a failure in between — and the write is a compare-and-set,
so concurrent responses cannot both resume the turn.

`GET /conversations/:id/prompts?pending=true` is the reconnect path: one
request rebuilds every open prompt. Prefer it to replaying events.

### 3.5b Interrupting a running turn

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/conversations/:id/cancel` | **Stop button** — abort and end the turn. No body |
| `POST` | `/conversations/:id/interject` | `{ text }` — abort and continue with new guidance |

Both 409 when no turn is in flight. See §0.5.8 — they are easy to confuse
and do opposite things to the turn.

### 3.6 Grants

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/approvals/grants` | List active `"allow always"` grants |
| `DELETE` | `/approvals/grants/:key` | Revoke a grant; `key = tool:<tool>:agent:<agent_id>` |

Unchanged by the prompt collapse. A grant is a standing permission keyed
by (agent, tool) — it outlives the turn that created it, which is why it
kept its own routes. Responding `always` to an approval prompt writes one.

### 3.7 Artifacts

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/artifacts/:id` | `{ artifact, current_version }` |
| `GET` | `/artifacts/:id/versions` | `ArtifactVersion[]`, newest-first |
| `GET` | `/artifacts/:id/versions/:v` | Single version |
| `GET` | `/artifacts/:id/diff?from=:a&to=:b` | `{ from, to, unified, hunks }` (jsdiff Myers) |

### 3.8 Tags

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/tags` | All workspace tags alphabetically |
| `POST` | `/tags` | `{ name, color? }` — 409 on duplicate name |
| `PATCH` | `/tags/:id` | Update name/color |
| `DELETE` | `/tags/:id` | Hard-delete — also drops every `ConversationTag` row |

### 3.9 Pinned snippets (global delete)

| Method | Path | Purpose |
|---|---|---|
| `DELETE` | `/pinned-snippets/:id` | Remove a single pin |

### 3.10 Search

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/search?q=&scope=all\|conversations\|messages\|agents` | ILIKE-based hits with bold-wrapped highlights |

Returns:

```ts
interface SearchResponse {
  query: string;
  scope: string;
  hits: Array<{
    scope: 'conversations' | 'messages' | 'agents';
    id: string;
    title: string;
    snippet: string;      // plain
    highlight: string;    // markdown with **needle** wrapped
  }>;
}
```

### 3.11 Public share read

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/shared/:token` | Public read-only linear thread — **no auth required**, strips tree/approval/agent-internals |

Returns:

```ts
interface PublicSharedThread {
  title: string;
  agent: string;                // display name
  chain: Array<{
    role: 'user' | 'asst';
    time: string;
    content: string;
    reasoning?: string[];
    tool?: { name: string; status: string };
  }>;
}
```

### 3.12 Dev utilities

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/dev/seed` | Idempotently load `SAMPLE_*` fixtures (7 agents, 9 conversations, 9 tree nodes on `c-01`). |

---

## 4. SSE event protocol

### 4.1 Opening a stream

```js
const es = new EventSource(
  `http://localhost:3001/api/v1/conversations/${convId}/stream`,
  { withCredentials: false }
);

// Optional reconnect cursor (Last-Event-ID is NOT honored yet; use the
// explicit query param):
//   `/stream?since_event=${lastEventId}`
// After you open, remember the id of the last event you processed so
// a reconnect can resume from there without gaps.

es.addEventListener('node.created', (e) => { ... });
es.addEventListener('content.delta', (e) => { ... });
// ... one listener per kind you care about
```

### 4.2 Envelope

Every frame is one SSE event with three lines plus a blank line:

```
event: <kind>
id: <uuid>
data: {"kind":"<kind>","id":"<uuid>","at":<epoch_ms>,"conversation_id":"c-..."...}

```

`kind`, `id`, `at`, `conversation_id` are present on every event. Kind-
specific fields live alongside them in the JSON payload.

The HTTP response also contains an occasional `: keep-alive` comment
every 15s — ignore it; `EventSource` already does.

### 4.3 Event kinds and payloads

All fifteen kinds the runtime can emit. `node_id` is present on every
node-scoped kind.

```ts
type BusEvent =
  | NodeCreatedEvent
  | StatusUpdateEvent
  | ContentDeltaEvent
  | ReasoningDeltaEvent
  | ReasoningStepEndEvent
  | ToolCallProposedEvent
  | ToolCallStartedEvent
  | ToolCallEndedEvent
  | ApprovalRequestedEvent
  | ApprovalDecidedEvent
  | ClarifyRequestedEvent
  | ClarifyAnsweredEvent
  | ArtifactUpdatedEvent
  | NodeFinalizedEvent
  | ActiveLeafChangedEvent
  | ErrorEvent;

interface BaseEvent {
  id: string;                 // monotonic (UUIDv4 today, ULID candidate)
  at: number;                 // epoch ms
  conversation_id: string;
}

interface NodeCreatedEvent extends BaseEvent {
  kind: 'node.created';
  node: MessageNode;          // full client-shape — see §5.2
}

interface StatusUpdateEvent extends BaseEvent {
  kind: 'status.update';
  node_id: string;
  state: 'thinking' | 'pondering' | 'tool' | 'approval' | 'streaming';
  elapsed_ms: number;
  tool?: string;              // present when state='tool' or 'approval'
}

interface ContentDeltaEvent extends BaseEvent {
  kind: 'content.delta';
  node_id: string;
  delta: string;              // append to node.content
}

interface ReasoningDeltaEvent extends BaseEvent {
  kind: 'reasoning.delta';
  node_id: string;
  step_index: number;         // 0-based; increments per `</think>` block
  delta: string;
}

interface ReasoningStepEndEvent extends BaseEvent {
  kind: 'reasoning.step.end';
  node_id: string;
  step_index: number;
  final_text: string;         // complete text for that step
}

interface ToolCallProposedEvent extends BaseEvent {
  kind: 'toolcall.proposed';
  node_id: string;
  tool_call: ToolCallData;    // status: 'pending'
}

interface ToolCallStartedEvent extends BaseEvent {
  kind: 'toolcall.started';
  node_id: string;
  tool: string;
  args: Record<string, unknown>;
}

interface ToolCallEndedEvent extends BaseEvent {
  kind: 'toolcall.ended';
  node_id: string;
  status: 'ok' | 'err' | 'done';
  elapsed_ms: number;
  result?: string;
  error?: string;
}

// The nested unions below are what make a mismatched pair — say
// prompt_kind 'approval' carrying clarify data — fail validation rather
// than parse into a half-populated object. They also narrow: checking
// prompt_kind proves which sibling field is present.

type PromptRequest =
  | { prompt_kind: 'approval'; approval: ApprovalData }   // { tool, title, body, preview? }
  | { prompt_kind: 'clarify';  clarify:  ClarifyData };   // { question, chips, input }

type PromptResponse =
  | { prompt_kind: 'approval';
      decision: 'allow' | 'always' | 'deny';
      /** Present only if the user rewrote the args. The tool ran with THESE. */
      edited_args?: Record<string, unknown>; }
  | { prompt_kind: 'clarify';
      answer: { selected_chip_ids: string[]; text: string }; };

interface PromptRequestedEvent extends BaseEvent {
  kind: 'prompt.requested';
  node_id: string;
  prompt_id: string;          // POST this id back to /prompts/:id/respond
  tool: string;               // 'ask_clarification' for clarify prompts
  request: PromptRequest;
}

interface PromptRespondedEvent extends BaseEvent {
  kind: 'prompt.responded';
  node_id: string;
  prompt_id: string;
  tool: string;
  response: PromptResponse;
}

interface InterjectionReceivedEvent extends BaseEvent {
  kind: 'interjection.received';
  node_id: string;
  interjection_id: string;
  text: string;
  /** true = a live model call was cut off; false = queued for the next round. */
  aborted: boolean;
}

interface TurnCancelledEvent extends BaseEvent {
  kind: 'turn.cancelled';
  node_id: string;
  /** true = a live model call was cut off. */
  aborted: boolean;
  /** true = the cancel endpoint closed the node itself (turn was parked). */
  finalized: boolean;
}

interface ArtifactUpdatedEvent extends BaseEvent {
  kind: 'artifact.updated';
  artifact_id: string;
  version_id: string;
  version: number;
  title: string;
}

interface NodeFinalizedEvent extends BaseEvent {
  kind: 'node.finalized';
  node_id: string;
  node: MessageNode;          // full persisted snapshot
}

interface ActiveLeafChangedEvent extends BaseEvent {
  kind: 'active_leaf.changed';
  active_leaf_id: string;     // no node_id field on this one
}

interface ConversationTitleUpdatedEvent extends BaseEvent {
  kind: 'conversation.title.updated';
  title: string;              // generated once from the first user message
}

interface ErrorEvent extends BaseEvent {
  kind: 'error';
  node_id?: string;
  message: string;
  recoverable: boolean;
}
```

### 4.4 Canonical event sequences

**Plain text turn (no tools, no reasoning):**

```
node.created(user)
active_leaf.changed
node.created(asst, streaming=true, status='thinking')
status.update(thinking)
content.delta × N     ← stream these into the node's content
node.finalized(asst)
active_leaf.changed   ← moved onto the asst node
```

**Turn with an auto-approved tool (web_search):**

```
node.created(user)
active_leaf.changed
node.created(asst)
status.update(thinking)
(optional content.delta × N if model pre-writes before tool call)
toolcall.proposed
toolcall.started
status.update(state='tool', tool='web_search')
toolcall.ended(ok, result=…)
content.delta × N     ← model's conclusion after the tool result
node.finalized(asst)
active_leaf.changed
```

**Turn that requires approval (write_file, no existing grant):**

```
...                   (same prefix)
toolcall.proposed
prompt.requested      ← request.prompt_kind='approval'; render ApprovalCard
status.update(approval)
  ⏸  the turn is now parked in Postgres. It survives a restart.
      Nothing arrives until a human answers — there is no timeout.
— client POSTs /prompts/:id/respond {decision} —
prompt.responded      ← response.prompt_kind='approval'
# if allow|always:
toolcall.started      ← args = edited_args if the user rewrote them
status.update(tool)
toolcall.ended(ok)
artifact.updated      ← for write_file specifically
content.delta × N
node.finalized(asst)
active_leaf.changed
# if deny:
toolcall.ended(err, error='Denied by user')
content.delta × N     ← assistant recovers, acknowledges denial
node.finalized
active_leaf.changed
```

**Turn with a clarify (model calls `ask_clarification`):**

```
...                   (same prefix)
toolcall.proposed(ask_clarification)
prompt.requested      ← request.prompt_kind='clarify'; chips + input
status.update(approval) ← yes, 'approval' state reused for clarify
  ⏸  same durable pause as above
— client POSTs /prompts/:id/respond {selected_chip_ids, text} —
prompt.responded      ← response.prompt_kind='clarify'
content.delta × N     ← assistant continues with the structured answer
node.finalized
active_leaf.changed
```

Note there is **no `toolcall.started`/`toolcall.ended` pair** for a
clarify: `ask_clarification` is a pause mechanic, not an executable tool.
The answer is folded into the model's context and the turn continues.

**Turn with a reasoning model (deepseek-r1, qwq, etc.):**

```
...                   (same prefix)
reasoning.delta × N   ← contents of the <think>...</think> block
reasoning.step.end    ← one per closed </think>
content.delta × N     ← visible response text
node.finalized        ← node.reasoning: string[] carries the step texts
active_leaf.changed
```

**Turn that exhausts the token budget before starting:**

```
node.created(user)
active_leaf.changed
error(recoverable=false, message='token budget exhausted (X / Y)')
```

No `node.created(asst)` appears — the assistant never started. UI
should show a banner and offer to bump `token_budget` (server API for
this is Phase 4+ via `PATCH /conversations/:id`, not yet implemented —
for now, a direct DB update is the escape hatch).

### 4.5 Ordering guarantees

- Events for a given `node_id` are causally ordered.
- Across a conversation, `id` monotonicity is guaranteed (events are
  written through a SERIAL primary key in Postgres).
- `reasoning.delta` may interleave with `content.delta` in theory, but
  the current splitter emits all segments in stream-arrival order,
  which for any model we've seen means: reasoning first, then content.
- **`prompt.responded` arrives after the HTTP 200, not before it.** It is
  emitted by the graph as it resumes, which is what keeps it correctly
  ordered against the `toolcall.started` / `toolcall.ended` events that
  follow. Don't await the event inside the click handler; treat the 200 as
  "recorded" and let the stream drive UI.
- There is no ordering guarantee *between* a response's HTTP result and
  its stream event. Either can land first.

### 4.6 Reconnect with `since_event`

Save the `id` of the last event you processed. On reconnect:

```
GET /conversations/:id/stream?since_event=<id>
```

The server replays every persisted event with `seq > :seq_of_id`, then
switches to a live subscription. Internally it subscribes first and
dedupes by event id, so no event between replay-end and subscribe-
active is lost.

If the last event you have isn't in the DB (unknown id), the server
streams from the beginning — the client should dedupe client-side.

---

## 5. Wire data shapes

Pasted verbatim from `src/schemas/*.ts`. These match
`chat-box/src/types.ts` exactly for the names the client already uses;
new fields are additive.

### 5.1 Conversation

```ts
interface Conversation {
  id: string;
  title: string;
  snippet: string;
  agent: string;          // DISPLAY NAME (e.g. "Code Reviewer"),
                          // NOT agent_id. Server translates at the
                          // boundary.
  tag: string;            // empty string when unset
  pinned?: boolean;
  updated: string;        // display string: "11:42" | "Today" | "Apr 14"
  folder: string;         // "Pinned" | "Today" | "This week" | "Earlier"
}
```

### 5.2 MessageNode

```ts
type Role = 'user' | 'asst';  // NOT 'assistant'. One of the oldest
                              // footguns — the sample types explicitly
                              // abbreviate.

type ToolStatus = 'ok' | 'pending' | 'err' | 'done';

type StatusState =
  | 'thinking'
  | 'pondering'
  | 'tool'
  | 'approval'
  | 'streaming';

interface ToolCallData {
  name: string;
  args: Record<string, unknown>;
  status: ToolStatus;
  elapsed?: string;
  result?: string;
}

interface ClarifyChip { id: string; label: string; selected?: boolean; }

interface ClarifyData {
  question: string;
  chips: ClarifyChip[];
  input: string;           // placeholder text, NOT the user's answer
}

interface ApprovalData {
  tool: string;
  title: string;
  body: string;
  preview?: string;
}

interface MessageNode {
  id: string;
  parent: string | null;   // the field is literally `parent`,
                           // NOT `parent_id`.
  role: Role;
  time: string;            // display string: "11:28"
  branch: string;          // "main" | "alt-1" | "alt-2" | ...
  content: string;
  reasoning?: string[];    // one string per closed <think> block
  toolCall?: ToolCallData;
  clarify?: ClarifyData;   // see caveat below
  approval?: ApprovalData; // see caveat below
  streaming?: boolean;
  status?: StatusState;
  edited?: boolean;        // true if the node is a branch-via-edit
                           // created by POST /nodes/:id/edit
}

interface MessageTree {
  rootId: string;
  activeLeaf: string;
  nodes: Record<string, MessageNode>;  // flat map, not nested
}
```

**Caveat on `approval` / `clarify` — a tree fetch tells you nothing about
an open prompt.** Verified against a live turn:

- **`approval` is never written by the runtime.** It exists in the schema
  and `insertNode` accepts it, but no code path sets it — it is `null`
  while a prompt is open *and* after it is answered. Only `POST /dev/seed`
  fixtures populate it, which is why it looks real in sample data.
- **`clarify` is written only *after* the answer**, rewritten with
  `selected: true|false` on each chip. While the prompt is open it is
  `null`.

So in both cases the node row is empty at exactly the moment you'd want
to render a card. **Get prompt state from
`GET /conversations/:id/prompts?pending=true` or from the
`prompt.requested` / `prompt.responded` events** — never by inferring it
from `node.approval`.

### 5.3 Agent (wire vs. full)

```ts
// The list / card shape.
interface Agent {
  id: string;
  name: string;
  initial: string;
  desc: string;
  model: string;
  tools: number;          // COUNT — not an array. `toolIds.length`.
  temp: number;
}

// The AgentBuilder form shape (GET /agents/:id/full + PATCH body).
interface AgentVariable {
  name: string;           // ^[a-z][a-z0-9_]*$
  default: string;
  description: string;
}

interface AgentFull {
  id: string;
  name: string;
  initial: string;
  desc: string;
  model: string;
  temperature: number;
  top_p: number;
  max_tokens: number;
  system_prompt: string;
  variables: AgentVariable[];
  tool_ids: string[];
  permission_default:
    | 'ask_every_time'
    | 'auto_allow_read'
    | 'auto_allow_all';
  current_version_id: string | null;
}

interface AgentVersion {
  id: string;
  agent_id: string;
  version: number;         // monotonic per-agent, starts at 1
  message: string;         // commit-style
  snapshot: Omit<AgentFull, 'id' | 'current_version_id'>;
  eval_score: number | null;
  parent_version_id: string | null;
  created_at: string;      // ISO 8601
}
```

### 5.4 Tool registry

```ts
interface ToolDef {
  id: string;              // 'read_file' | 'write_file' | ...
  name: string;
  desc: string;
  enabled: boolean;        // displayed but not selectable when false
  auto: boolean;           // "auto-approve" hint, agent-level override
                           // not yet wired (Phase 4.5)
}
```

Current catalog returned by `GET /tools`:

```
id           enabled  auto  side-effect
read_file      ✓       ✗      no
write_file     ✓       ✗      yes  ← approval gated
run_tests      ✓       ✓      yes  ← approval gated despite auto flag
web_search     ✓       ✓      no   ← auto-approved by default
web_fetch      ✗       ✗      no
sql_query      ✗       ✗      no
send_email     ✗       ✗      yes
```

### 5.5 Artifact

```ts
interface Artifact {
  id: string;
  conversation_id: string;
  title: string;            // == the `path` arg from write_file
  mime: string;             // inferred from extension
  current_version_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ArtifactVersion {
  id: string;
  artifact_id: string;
  version: number;
  content: string;
  diff_from: string | null; // previous version's id
  message: string;
  author: 'user' | 'asst';
  produced_by_node_id: string | null;
  created_at: string;
}

// GET /artifacts/:id/diff?from=&to=
interface ArtifactDiffResponse {
  from: { version: number; id: string; created_at: string };
  to:   { version: number; id: string; created_at: string };
  unified: string;          // `--- +++ @@` unified diff
  hunks: Array<{
    oldStart: number; oldLines: number;
    newStart: number; newLines: number;
    lines: string[];        // each line starts with ' ', '+', or '-'
  }>;
}
```

### 5.6 Tags, notes, pinned snippets

```ts
interface Tag {
  id: string;
  name: string;
  color: string | null;
}

interface ThreadNote {
  conversation_id: string;
  body: string;
  updated_at: string;       // ISO
}

interface PinnedSnippet {
  id: string;
  conversation_id: string;
  source_node_id: string;
  label: string;
  excerpt: string;
  created_at: string;
}
```

### 5.7 Timeline

```ts
type TimelineEventKind =
  | 'user' | 'reason' | 'tool'
  | 'clar' | 'perm' | 'stream'
  | 'error';

interface TimelineEvent {
  id: string;
  conversation_id: string;
  node_id: string | null;
  kind: TimelineEventKind;
  label: string;            // truncated headline
  sub: string;              // secondary line
  status: 'ok' | 'pending' | 'err' | null;
  at: number;               // epoch ms
}
```

The server synthesizes these from the raw `events` table at request
time — no backing storage. So timeline rows on seeded (not-live)
conversations can be empty if no events were ever published.

### 5.8 Grants listing

```ts
interface Grant {
  key: string;              // `tool:<tool>:agent:<agentId>` — URL-safe
  agent_id: string;
  tool_id: string;
  created_at: string;
}
```

### 5.8b Prompt

```ts
interface PromptRow {
  id: string;                        // "pr-f015ff0b"
  conversation_id: string;
  node_id: string;                   // the assistant node that paused
  kind: 'approval' | 'clarify';
  tool: string;                      // 'ask_clarification' for clarify
  request: PromptRequest;            // §4.3
  response: PromptResponse | null;   // null while open
  responded_at: string | null;       // ISO
  created_at: string;                // ISO — use this to age the card
}
```

### 5.9 Optimizer + eval stubs

```ts
interface OptimizerSuggestion {
  suggestion_text: string;
  rationale: string;
  predicted_delta_pct: number;
  applies_to: 'system_prompt';
  patch: { before: string; after: string };
}

interface EvalResult {
  job_id: string;
  status: 'queued' | 'running' | 'done' | 'error';
  pass_rate: number | null;
  cases: Array<{
    input: string;
    expected_behavior: string;
    passed: boolean;
  }>;
  delta_vs_previous_pct: number | null;
}
```

---

## 6. Common client flows

### 6.1 Boot

```ts
const base = 'http://localhost:3001/api/v1';
const token = import.meta.env.VITE_YAP_TOKEN ?? '';
const hdr = token ? { Authorization: `Bearer ${token}` } : {};

// 1. Load the sidebar
const conversations: Conversation[] = await fetch(
  `${base}/conversations`, { headers: hdr },
).then((r) => r.json());

// 2. Load the agent gallery
const agents: Agent[] = await fetch(
  `${base}/agents`, { headers: hdr },
).then((r) => r.json());
```

### 6.2 Open a conversation

```ts
async function openConversation(id: string) {
  const { conversation, tree } = await fetch(
    `${base}/conversations/${id}`, { headers: hdr },
  ).then((r) => r.json());
  return { conversation, tree };
}
```

### 6.3 Live stream + send message

```ts
type Handler = (ev: BusEvent) => void;

function subscribe(convId: string, lastEventId: string | null, onEvent: Handler) {
  const qs = lastEventId ? `?since_event=${encodeURIComponent(lastEventId)}` : '';
  // IMPORTANT: EventSource cannot send custom headers, so auth must go
  // in a query param or via cookie, OR you replace this with a fetch
  // streamed reader (see §6.7).
  const es = new EventSource(`${base}/conversations/${convId}/stream${qs}`);
  const kinds: BusEvent['kind'][] = [
    'node.created', 'status.update', 'content.delta',
    'reasoning.delta', 'reasoning.step.end',
    'toolcall.proposed', 'toolcall.started', 'toolcall.ended',
    'prompt.requested', 'prompt.responded',
    'interjection.received', 'turn.cancelled',
    'artifact.updated',
    'node.finalized', 'active_leaf.changed', 'error',
  ];
  for (const k of kinds) {
    es.addEventListener(k, (e) => onEvent(JSON.parse((e as MessageEvent).data)));
  }
  return () => es.close();
}

async function sendMessage(convId: string, content: string, parent?: string | null) {
  const res = await fetch(`${base}/conversations/${convId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': crypto.randomUUID(),
      ...hdr,
    },
    body: JSON.stringify({ content, parent: parent ?? null }),
  });
  return res.json();   // the new user MessageNode
}
```

### 6.4 Reducer sketch (applying events to local state)

```ts
function reduce(state: MessageTree, ev: BusEvent): MessageTree {
  switch (ev.kind) {
    case 'node.created':
    case 'node.finalized':
      return {
        ...state,
        nodes: { ...state.nodes, [ev.node.id]: ev.node },
        rootId: state.rootId ?? ev.node.id,
      };

    case 'content.delta':
      return {
        ...state,
        nodes: {
          ...state.nodes,
          [ev.node_id]: {
            ...state.nodes[ev.node_id]!,
            content: (state.nodes[ev.node_id]?.content ?? '') + ev.delta,
          },
        },
      };

    case 'reasoning.delta': {
      const node = state.nodes[ev.node_id]!;
      const reasoning = (node.reasoning ?? []).slice();
      reasoning[ev.step_index] = (reasoning[ev.step_index] ?? '') + ev.delta;
      return {
        ...state,
        nodes: {
          ...state.nodes,
          [ev.node_id]: { ...node, reasoning },
        },
      };
    }

    case 'toolcall.ended': {
      const node = state.nodes[ev.node_id]!;
      return {
        ...state,
        nodes: {
          ...state.nodes,
          [ev.node_id]: {
            ...node,
            toolCall: {
              ...(node.toolCall ?? { name: '', args: {}, status: 'err' }),
              status: ev.status,
              elapsed: `${(ev.elapsed_ms / 1000).toFixed(1)}s`,
              ...(ev.result ? { result: ev.result } : {}),
            },
          },
        },
      };
    }

    case 'active_leaf.changed':
      return { ...state, activeLeaf: ev.active_leaf_id };

    case 'status.update': {
      const node = state.nodes[ev.node_id];
      if (!node) return state;
      return {
        ...state,
        nodes: {
          ...state.nodes,
          [ev.node_id]: { ...node, status: ev.state, streaming: ev.state !== 'approval' },
        },
      };
    }

    // One case for both pause kinds. Note it keys the open prompt by
    // prompt_id — several can be open at once, so a single
    // `node.approval` slot is the wrong shape to grow into.
    case 'prompt.requested': {
      const node = state.nodes[ev.node_id]!;
      const patch =
        ev.request.prompt_kind === 'approval'
          ? { approval: ev.request.approval }
          : { clarify: ev.request.clarify };
      return {
        ...state,
        openPrompts: { ...state.openPrompts, [ev.prompt_id]: ev },
        nodes: {
          ...state.nodes,
          [ev.node_id]: { ...node, ...patch, status: 'approval' },
        },
      };
    }

    // Do NOT leave this a no-op. It is what stops an already-answered
    // prompt from rendering live buttons after a reload.
    case 'prompt.responded': {
      const { [ev.prompt_id]: _answered, ...rest } = state.openPrompts;
      return {
        ...state,
        openPrompts: rest,
        answeredPrompts: { ...state.answeredPrompts, [ev.prompt_id]: ev.response },
      };
    }

    default:
      return state;
  }
}
```

A clean drop-in: maintain a `lastEventId` alongside the tree and pass
it to `subscribe()` on mount. Every reducer call should also update
`lastEventId = ev.id`.

### 6.5 Prompt round-trip (approvals and clarifications)

One call for both kinds. The body differs; the endpoint does not.

```ts
type RespondBody =
  | { decision: 'allow' | 'always' | 'deny'; edited_args?: Record<string, unknown> }
  | { selected_chip_ids?: string[]; text?: string };

async function respondToPrompt(promptId: string, body: RespondBody) {
  const res = await fetch(`${base}/prompts/${promptId}/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...hdr },
    body: JSON.stringify(body),
  });
  // 409 means someone (or another tab) already answered it. That is a
  // settled prompt, not a failure — render the winning response.
  if (res.status === 409) {
    const { response } = await res.json();
    return { ok: true, settled: true, response };
  }
  if (!res.ok) throw new Error(`respond failed: ${res.status}`);
  return res.json();
}

// Approve, but rewrite what the model proposed:
await respondToPrompt('pr-f015ff0b', {
  decision: 'allow',
  edited_args: { path: 'edited-by-human.txt', content: 'the human rewrote this' },
});

// Answer a clarify:
await respondToPrompt('pr-0e3ac2cb', {
  selected_chip_ids: ['c-0'],
  text: 'bullets, five max',
});
```

The server persists the response, then resumes the paused turn from its
checkpoint. `prompt.responded` arrives on the stream as the graph resumes,
followed by `toolcall.started` / `toolcall.ended` / `content.delta` /
`node.finalized`.

Four consequences worth designing for:

- **The gap can be arbitrarily long.** The pause is a checkpoint, not a
  waiting promise, so this works after the user closes the laptop or the
  server restarts. Nothing expires.
- **`resumed: false` is not a failure.** It means there was no paused
  turn to continue; the response is still recorded.
- **Don't derive decided-state from this call succeeding.** On reload the
  card rebuilds from the request event and will show live buttons for an
  already-answered prompt. Drive it from `prompt.responded`, or fetch
  `GET /conversations/:id/prompts?pending=true` on mount — §0.5.3.
- **If you sent `edited_args`, the tool ran with those**, not with what
  the model proposed. Render the edited values in history.

### 6.6 Rebuilding open prompts after a reload

Cheaper and more direct than replaying the event log:

```ts
const pending = await fetch(
  `${base}/conversations/${convId}/prompts?pending=true`, { headers: hdr },
).then((r) => r.json());
// → PromptRow[] — render one card per row, keyed by row.id
```

This is the only way to learn about an open prompt from a plain tree
fetch: `GET /conversations/:id` does not carry prompt state.

### 6.7 Auth-friendly alternative to `EventSource`

`EventSource` can't send custom headers. If `YAP_API_TOKEN` is set,
either:

**(a)** Put the token in a cookie set by your SSR layer / an auth
endpoint.

**(b)** Use `fetch` with a manual SSE parser:

```ts
async function streamFetch(convId: string, since: string | null, onEvent: Handler) {
  const qs = since ? `?since_event=${encodeURIComponent(since)}` : '';
  const res = await fetch(`${base}/conversations/${convId}/stream${qs}`, { headers: hdr });
  if (!res.body) throw new Error('no body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split('\n\n');
    buf = frames.pop() ?? '';
    for (const frame of frames) {
      const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!dataLine) continue;
      onEvent(JSON.parse(dataLine.slice(5).trim()));
    }
  }
}
```

### 6.8 Optimistic UI rules of thumb

- When calling `POST /messages`, insert the user node into local state
  immediately (optimistic) — the server's returned node will overwrite
  it when the `node.created` event arrives. Match on parent + content,
  or use the returned id to reconcile.
- Tool calls: while `toolcall.proposed` is pending, render the chip
  with `status='pending'`; `toolcall.started` adds the "Running…"
  state; `toolcall.ended` flips to ok/err.
- `node.finalized` is the only authoritative "this node is done"
  signal. If you want a "streaming…" indicator, key off `streaming:
  true` on the node (set on `node.created`, cleared on
  `node.finalized`).
- On disconnect, keep rendering last known state. On reconnect with
  `since_event`, the dedupe happens server-side; your reducer can
  idempotently re-apply without harm.

---

## 7. Non-functional behaviour

### 7.1 Auth (Phase 8)

If the server was started with `YAP_API_TOKEN=...`:

- Every `/api/v1/*` request must send `Authorization: Bearer <token>`.
- `/api/v1/shared/:token` is public by design (the URL itself is the
  credential).
- 401 responses carry `{ "error": "unauthorized" }`.

### 7.2 Idempotency-Key header

- Supported on `POST`, `PATCH`, `DELETE`.
- Server caches the first 2xx/3xx response for 24h keyed by
  `(key, method, path)`.
- Replays get an `X-Idempotent-Replay: true` response header with the
  original body + status byte-for-byte.
- SSE responses are deliberately NOT cached.
- Different keys or different paths → run fresh. Mix the same key
  across paths safely.
- Client recommendation: mint `crypto.randomUUID()` once per logical
  intent (send, edit, regenerate, approval decide) and re-use on retry.

### 7.3 Rate limits

- 60 requests / rolling minute / identity by default
  (`RATE_LIMIT_RPM`).
- Identity is the bearer-token prefix if present, else
  `X-Forwarded-For`, else `anon`.
- Breach returns 429 with `Retry-After: <s>` and
  `X-RateLimit-Remaining: 0`.
- `/api/v1/shared/:token` bypasses the limit (CDN the share links if
  needed).

### 7.4 Token budget

- Each conversation has `token_budget` (default 200_000) and
  `tokens_used`.
- Runtime refuses to start a turn if `tokens_used >= token_budget` —
  emits `error(recoverable:false)` and returns.
- `tokens_used` is a `chars/4` approximation bumped after every round.
- There's no `PATCH /conversations/:id` to bump the budget yet —
  Phase 4.5. For now, raise directly via Postgres if testing.

### 7.5 Tool deadlines

- Each round of `ollama.chat(...)` has a 30s deadline
  (`TOOL_DEADLINE_MS`).
- Overrun aborts the stream; the turn ends with an `error` event.

---

## 8. Recommended client architecture

### 8.1 File-by-file map into chat-box

The chat-box repo currently stubs everything in `src/data/sample.ts`.
Here's how each UI surface maps to a yap endpoint:

| chat-box file | Replace stub with |
|---|---|
| `src/App.tsx` (conversations list, active conv) | `GET /conversations`, `GET /conversations/:id` |
| `src/components/Sidebar.tsx` | Above + `GET /tags` (for the Sort by tag filter) |
| `src/components/Message.tsx` edit action | `POST /nodes/:id/edit` |
| Message component "Regenerate" | `POST /nodes/:id/regenerate` |
| TreeView "Branch from here" | `POST /nodes/:id/branch` |
| TreeView "Prune" | `DELETE /nodes/:id?subtree=true[&fallback_leaf=…]` |
| TreeView ripple-toggle preview | `GET /nodes/:id/ripple-preview` |
| Composer Send | `POST /conversations/:id/messages` + subscribe |
| StatusLine | Reduce `status.update` events |
| ApprovalCard | Render `request.approval` + `prompt_id` from `prompt.requested`. On click → `POST /prompts/:id/respond` with `{decision, edited_args?}`. Clear on `prompt.responded`. |
| Clarify | Same component pattern, same endpoint: `prompt.requested` with `request.prompt_kind: 'clarify'` → `POST /prompts/:id/respond` with `{selected_chip_ids, text}` |
| Either card, after reload | `GET /conversations/:id/prompts?pending=true` |
| Stop button | `POST /conversations/:id/cancel` → render `turn.cancelled` as "stopped" |
| "Change direction" affordance | `POST /conversations/:id/interject` with `{ text }` |
| ReasoningBlock | Render `MessageNode.reasoning: string[]` |
| ToolCall | Render `MessageNode.toolCall` |
| CanvasPane (preview) | `GET /artifacts/:id` |
| CanvasPane (diff) | `GET /artifacts/:id/diff?from=&to=` |
| CanvasPane (history) | `GET /artifacts/:id/versions` |
| AgentGallery | `GET /agents` + `GET /agent-templates` + `POST /agents/from-template/:tpl` |
| AgentBuilder | `GET /agents/:id/full` + `PATCH /agents/:id` + `GET /agents/:id/versions` + `POST /agents/:id/versions/:v/restore` |
| AgentBuilder IMPROVE button | `POST /agents/:id/optimize` |
| AgentBuilder Run Eval | `POST /agents/:id/eval/run` + `GET /agents/:id/eval/runs/:jobId` |
| AgentPanel (Inspector) | `GET /agents/:id` + conversation's current agent id from the Conversation row |
| Timeline | `GET /conversations/:id/timeline` |
| NotesPanel | `GET/PUT /conversations/:id/notes` + `GET/POST /conversations/:id/pinned-snippets` + `DELETE /pinned-snippets/:id` |
| Share / Export buttons in thread head | `POST /conversations/:id/share` / `GET /conversations/:id/export?format=md\|json` |
| `⌘K` search | `GET /search?q=&scope=` |

### 8.2 State management

Two stores feel natural:

1. **Workspace store**: conversations, tags, agents. Populated on boot
   from three GETs. Mutated through the CRUD endpoints; invalidate +
   refetch on success. React-Query, SWR, or a small Zustand slice are
   all fine.

2. **Thread store** (per open conversation): `{ conversation, tree,
   lastEventId, streaming: boolean }`. Populated by `GET
   /conversations/:id`. Mutated by the reducer in §6.4 as events
   arrive. The store also holds the unsubscribe handle; flushed when
   the user navigates away.

Artifacts can live in a third store keyed by conversation id, bumped
on `artifact.updated` events by re-fetching the affected artifact.

### 8.3 Reconnect strategy

- On page load with a conversation id in the URL: fetch the tree, then
  open the stream with `since_event = null` (fresh).
- On visible-tab-becomes-visible after a long sleep: re-open the
  stream with `since_event = lastEventId` to backfill.
- On network error: exponential backoff, same resume pattern.

### 8.4 Handling the `branch` affordance

Trees in practice have at most 3-5 branches per conversation. The
client can render the active chain from `activeLeaf` walking up
`parent` links; a dropdown on each node exposes sibling branches via
`nodes` scanned for `parent == node.parent`.

When the user picks a branch, update `activeLeaf` locally **and**
call… actually, yap doesn't have an endpoint to set `active_leaf_id`
directly. Today the server updates it automatically on `POST
/messages`, `POST /nodes/:id/edit`, `POST /nodes/:id/regenerate`, and
`POST /nodes/:id/branch`. If you want pure visual branch-switching
without generating anything, you have two options:

- Keep the branch switch client-only (most UX-natural — the
  conversation's `activeLeaf` on disk diverges from what the UI
  shows, but that's harmless because the next send will propagate).
- Or request a new server endpoint `PATCH /conversations/:id
  { active_leaf_id }` — easy addition, flagged below.

---

## 9. Expansion / design-space

These are the seams deliberately left open. Each is a small additive
PR on the server.

### 9.1 Per-agent tool overrides

Spec §7.15 envisions per-agent `AgentTool { tool_id, enabled,
auto_approve }` rows. Currently all auto-approval decisions route
through the global `TOOL_DEFS` + `isSideEffectful()` logic. Adding
per-agent overrides would let a "Code Reviewer" skip `read_file`
approvals while a "Data Analyst" keeps them. Open in:
`src/runtime/run.ts::isAutoApproved`.

### 9.2 Real prompt optimizer

`POST /agents/:id/optimize` ships a canned suggestion. A real pass
would prompt a secondary Ollama call with the agent's eval set, score
variants, and return the winner. Interface shape
(`OptimizerSuggestion`) is stable — the client can wire UI today.

### 9.3 Async eval runs

`POST /eval/run` synthesizes a result inline today. For production,
the endpoint would return `202 { status: 'queued', job_id }` and a
worker process would write real results. The client already polls
`GET /eval/runs/:jobId` — just keep polling until `status === 'done'`.

### 9.4 Branch switching without generation

Add `PATCH /conversations/:id` accepting `active_leaf_id` + tree
integrity checks. ~20 lines of server code.

### 9.5 Artifact edits from the UI

Current artifacts are written exclusively by `write_file` tool calls.
To let the user edit an artifact in the Canvas preview and save back:
add `POST /artifacts/:id/versions` with `{ content, message,
author: 'user' }`. The `author` field in the model is already
polymorphic; backend is a one-file change.

### 9.6 Conversation-level agent override

Inspector AgentPanel has tool toggles that are spec'd as
"per-conversation overrides" (§7.19). Not in the current server.
Suggested surface: `PATCH /conversations/:id/agent-overrides
{ temperature?, top_p?, max_tokens?, tool_ids? }`. The runtime would
merge these on top of the agent's base config.

### 9.7 Real full-text search

Swap the `ILIKE %q%` in `src/api/search.ts` for a `tsvector` column +
GIN index. No surface change.

### 9.8 tsvector / pg_trgm for search highlighting

Current search just wraps the literal needle in `**`. A token-aware
highlighter would ship multi-word matches + stemming.

### 9.9 Reasoning for non-`<think>` models

The `ThinkSplitter` only recognizes `<think>…</think>`. Claude models
use a different format (`<reasoning>…</reasoning>`), OpenAI's
reasoning models don't surface the trace at all via the API. If you
expand model support, add recognized markers to
`src/runtime/think-splitter.ts::OPEN_TAG / CLOSE_TAG`.

### 9.10 Multi-user workspaces

Today:
- No `User` or `Workspace` model.
- Grants use a fixed `userId = 'local'`.
- Auth is a single shared secret.

For multi-user:
- Add `User` + `Workspace` + foreign keys on every relevant row.
- Swap `YAP_API_TOKEN` for per-user bearer tokens (or OAuth).
- `ApprovalGrant` already has `user_id`; just start writing real ids.
- Scope every listing by `workspace_id`.

### 9.11 Attachments (repo/file context)

Composer's repo/file chip (spec §7.22) isn't backed yet. Shape would
be an `Attachment` model with polymorphic `kind: 'repo' | 'file'` +
lazy content loading. The runtime would inject attachment content into
the system prompt.

### 9.12 Reasoning depth control

Composer's reasoning-depth chip (low/medium/high) currently does
nothing on the server. Map it to an Ollama `num_predict` or
`num_ctx` override and persist per conversation.

### 9.13 Full-chain ripple regenerate

`POST /nodes/:id/edit { ripple: true }` today regenerates ONE
assistant reply under the new user node. The spec's §3.2 wants EVERY
descendant replayed along the new branch. The scaffolding (branch
naming, new user insert, runAssistantTurn) is already in place — the
missing piece is a depth-first walker in `src/api/nodes.ts::edit` that
iterates descendants by `created_at`, clones user nodes with
`edited=true`, and invokes `runAssistantTurn` per assistant
descendant.

### 9.14 Client-side budget UI

`conversation.token_budget` is already in the data model but isn't in
the wire `Conversation` shape. Add `token_budget + tokens_used` as
optional fields — the Composer's "8 132 / 200k" chip will work out of
the box.

---

## 10. Verification recipe

Here's a scripted smoke test hitting every major flow. Run against a
freshly-seeded server.

```bash
BASE=http://localhost:3001/api/v1
TOKEN_HDR=""   # if YAP_API_TOKEN is set, add '-H "Authorization: Bearer $TOKEN"'

curl -sX POST $BASE/dev/seed $TOKEN_HDR
curl -s $BASE/conversations $TOKEN_HDR | jq 'length'            # → 9
curl -s $BASE/conversations/c-01 $TOKEN_HDR | jq '.tree.rootId' # → "n-01"
curl -s $BASE/agents $TOKEN_HDR | jq 'length'                    # → 7 (including Assistant)
curl -s $BASE/agent-templates $TOKEN_HDR | jq 'length'           # → 4
curl -s $BASE/tools $TOKEN_HDR | jq 'length'                     # → 7
curl -s "$BASE/search?q=idempotency&scope=messages" $TOKEN_HDR | jq '.hits|length'  # → ≥1
curl -s $BASE/conversations/c-01/timeline $TOKEN_HDR | jq 'length'  # → 0 (no live events on seed)
curl -s "$BASE/conversations/c-01/export?format=md" $TOKEN_HDR | head -3  # → "# Refactoring…"

# End-to-end stream:
CONV=$(curl -sX POST $BASE/conversations $TOKEN_HDR -H 'Content-Type: application/json' -d '{}' | jq -r .id)
(curl -N "$BASE/conversations/$CONV/stream" $TOKEN_HDR &) && sleep 1
curl -sX POST "$BASE/conversations/$CONV/messages" $TOKEN_HDR \
     -H 'Content-Type: application/json' \
     -d '{"content":"What is 2+2?"}'
# Stream emits: node.created(user), active_leaf.changed, node.created(asst),
# content.delta × N, node.finalized, active_leaf.changed
```

Every box should be green.

---

## 11. Where to go from here

If you're a developer (or an agent) about to wire chat-box:

1. Put the base URL and optional `YAP_API_TOKEN` behind a single
   `src/api/client.ts` module in chat-box. Every component imports
   from there.
2. Replace the stubs in `src/data/sample.ts` with typed fetch calls
   that hit the endpoints in §3, starting with `GET /conversations`.
3. Write the reducer from §6.4 into a `src/state/thread.ts` store (or
   reducer hook). Unit-test the reducer against fixtures shaped
   exactly like the events in §4.3 — no server needed.
4. Open a stream on the active conversation and watch the Sidebar +
   main view come alive.
5. Build the prompt flow next — one endpoint covers both approvals and
   clarifications (§3.5) and the events arrive with all the context you
   need. Key it by `prompt_id` from the start.
6. Wire the CanvasPane last; it's the most self-contained of the
   panels (single artifact id → three endpoints).

The yap server has 163 tests in `test/` that exercise every one of the
wire shapes documented here. If anything in this doc seems wrong
against what the server actually does, `pnpm test` will catch the
drift; the schemas in `src/schemas/*.ts` are the ground truth and
round-trip every SAMPLE_* fixture used by chat-box. Keep them in
sync and you're fine.
