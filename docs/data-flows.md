# Data flows

Sequence diagrams for the flows that matter — the ones where timing or ordering carries load-bearing invariants. Pairs with `docs/architecture.md` (structure) and `docs/user-stories.md` (motivation).

---

## 1. Send a message → stream an assistant turn (golden path)

The core loop of the product. Shows how one client POSTs while another (or the same one) reads the stream, and how the persist-then-publish pattern ties them together.

```mermaid
sequenceDiagram
    autonumber
    actor U as chat-box user
    participant MSG as POST /messages
    participant RT as runtime/run.ts
    participant BUS as events/bus
    participant DB as Postgres
    participant OL as Ollama
    participant STR as GET /stream
    actor U2 as (same user,<br/>streaming connection)

    U2->>STR: GET /stream (already open)
    STR->>BUS: subscribe(conv_id)

    U->>MSG: POST /conversations/:id/messages {content}
    MSG->>DB: getConversationRaw(id)
    DB-->>MSG: conv
    MSG->>RT: runAgent({parent, content})

    RT->>DB: insertNode(user)
    RT-->>MSG: yield node.created(user)
    MSG->>BUS: publish(node.created user)
    BUS->>DB: insertEvent
    BUS-->>STR: emit
    STR->>U2: data: node.created (user)

    MSG-->>U: 201 {user node}
    Note over MSG: return; runtime continues<br/>in background

    RT->>DB: insertNode(asst placeholder)
    RT-->>BUS: publish(node.created asst)
    BUS-->>STR: emit
    STR->>U2: data: node.created (asst)

    RT-->>BUS: publish(status.update thinking)
    BUS-->>STR: emit
    STR->>U2: data: status.update (thinking)

    RT->>OL: ollama.chat({stream: true})
    loop each chunk
        OL-->>RT: chunk
        Note over RT: ThinkSplitter feeds<br/>content vs reasoning
        RT-->>BUS: publish(content.delta)
        BUS-->>STR: emit
        STR->>U2: data: content.delta
    end

    RT->>DB: updateNode(asst, streaming=false)
    RT-->>BUS: publish(node.finalized)
    BUS-->>STR: emit
    STR->>U2: data: node.finalized

    RT->>DB: updateConversationPointers(active_leaf=asst)
    RT-->>BUS: publish(active_leaf.changed)
    BUS-->>STR: emit
    STR->>U2: data: active_leaf.changed
```

**Invariants:**

- The POST returns the user node **synchronously** (step 8) — the client can render its own message immediately. Everything after is decoupled from the POST.
- Every `publish` is persist-then-publish (see §5). The stream never hears an event that isn't already in the DB.
- If `U2` connected *after* the POST started, it would catch up via `?since_event=…` replay (see §2).

---

## 2. Reconnect with `?since_event` — race-free catch-up

The invariant that took the most work to get right. Any "simplification" that reorders steps 3 and 4 reintroduces a dropped-event window.

```mermaid
sequenceDiagram
    autonumber
    actor C as Client (reconnect)
    participant STR as stream.ts
    participant BUS as events/bus
    participant DB as events table
    participant P as in-flight publishers

    C->>STR: GET /stream?since_event=X
    STR->>BUS: subscribe(conv_id, ev -> preReplayBuffer)
    Note over STR,BUS: SUBSCRIBE FIRST. Any<br/>publish from here lands<br/>in the buffer, not the wire.

    par concurrent publishes
        P->>BUS: publish(ev_n+1)
        BUS->>DB: insertEvent
        BUS-->>STR: emit ⇒ preReplayBuffer
    end

    STR->>DB: listEventsSince(conv_id, X)
    DB-->>STR: [ev_X+1 … ev_n]
    loop replay
        STR->>C: data: ev_X+1 … ev_n
        Note over STR: seen.add(id) for each
    end

    STR->>STR: flush preReplayBuffer,<br/>drop ids already in `seen`
    loop live pump
        BUS-->>STR: ev_n+1 / ev_n+2 / …
        STR->>C: data: ev (if !seen)
    end

    C-->>STR: disconnect
    STR->>BUS: unsubscribe
```

**Why the subscribe must come first.** If the handler replayed from the DB first and *then* subscribed, any event published during the interval between "DB read committed" and "subscription active" would be missed — it's too new for the replay query and the subscriber wasn't registered yet. Subscribing first makes that window empty.

---

## 3. Tool call with approval (user says "allow")

Hits the three-layer permission check, sends an `approval.required` event, waits for the user's decision, then resumes.

```mermaid
sequenceDiagram
    autonumber
    actor U as chat-box user
    participant RT as runtime/run.ts
    participant DB as Postgres
    participant BUS as events/bus
    participant STR as stream
    participant APV as runtime/approvals
    participant API as POST /approvals/:id/decide

    Note over RT: Ollama returned a tool_call<br/>for `write_file`.
    RT->>RT: isAutoApproved(agent, tool)?
    Note over RT: L1 grant: no. L2 agent perm:<br/>ask. L3 auto flag: false.<br/>⇒ must ask.

    RT->>DB: insertApproval{tool, args, node_id}
    RT-->>BUS: publish(approval.required)
    BUS->>STR: emit
    STR->>U: data: approval.required {approval_id, preview}

    RT->>APV: awaitDecision(approval_id)
    Note over RT,APV: runtime suspends on<br/>a Promise. Turn is paused.

    U->>API: POST /approvals/:id/decide {decision: "allow"}
    API->>DB: recordApprovalDecision
    API-->>BUS: publish(approval.decided)
    BUS->>STR: emit
    STR->>U: data: approval.decided
    API->>APV: resolveApproval(id, "allow")
    APV-->>RT: resume with "allow"
    API-->>U: 200 {ok, runtime_awake: true}

    RT->>RT: executeTool("write_file", args)
    RT->>DB: recordArtifactWrite
    RT-->>BUS: publish(tool_call with result)
    BUS->>STR: emit
    STR->>U: data: tool_call (completed)

    Note over RT: Feed tool result back into<br/>Ollama, continue the loop.
```

**"Always" variant.** If the user says `always`, `recordApprovalDecision` also inserts an `ApprovalGrant` row. Next time the same tool is invoked on the same agent, `isAutoApproved` returns true at L1 and the whole approval dance is skipped.

**Runtime-died variant.** If the runtime process crashed between inserting the approval and the user's decision, `resolveApproval` returns `false` (no promise to resolve) — but the `approval.decided` event is still published so the timeline records the decision. A later run that re-reads the approval sees `decision != null` and acts on it.

---

## 4. Tool call (auto-approved via grant)

Happy path with no UI involvement — the fast case.

```mermaid
sequenceDiagram
    participant RT as runtime/run.ts
    participant DB as Postgres
    participant BUS as events/bus
    participant STR as stream
    actor U as user

    Note over RT: Ollama returned a tool_call.
    RT->>DB: hasGrant(agent, tool)
    DB-->>RT: true
    RT->>RT: executeTool(tool, args)
    RT-->>BUS: publish(tool_call event)
    BUS->>STR: emit
    STR->>U: data: tool_call
    Note over RT: Continue loop with<br/>tool result.
```

---

## 5. Persist-then-publish (the bus invariant)

The smallest but most important flow.

```mermaid
sequenceDiagram
    participant C as caller (handler or runtime)
    participant BUS as events/bus.publish
    participant DB as events table
    participant EE as EventEmitter
    participant SUB as subscribers

    C->>BUS: publish(BusEvent)
    BUS->>DB: insertEvent(ev)
    activate DB
    DB-->>BUS: row inserted
    deactivate DB
    Note over BUS: Only after the DB write<br/>succeeds do we emit.
    BUS->>EE: emit(conversation_id, ev)
    EE->>SUB: handler(ev) × N
```

If the DB write fails, `emit` never runs. The caller sees the exception; the stream sees nothing. A retry that succeeds is the only way an event reaches the wire.

---

## 6. Edit with ripple (create a branch + stream a fresh turn)

Editing a user message creates a sibling on a new `alt-N` branch. `ripple=true` then kicks off an assistant reply under the new user node.

```mermaid
sequenceDiagram
    autonumber
    actor U as user
    participant EDIT as POST /nodes/:id/edit
    participant DB as Postgres
    participant BUS as bus
    participant STR as stream
    participant RT as runtime (background)

    U->>EDIT: POST {content, ripple: true}
    EDIT->>DB: findNode(:id)
    DB-->>EDIT: orig (role=user)
    EDIT->>DB: nextBranchName(conv) → "alt-2"
    EDIT->>DB: insertNode(new user, parent=orig.parent,<br/>branch=alt-2, edited=true,<br/>edited_from_id=orig.id)
    EDIT-->>BUS: publish(node.created)
    BUS->>STR: emit
    STR->>U: data: node.created (new user)
    EDIT->>DB: updateConversationPointers(active_leaf=new)
    EDIT-->>BUS: publish(active_leaf.changed)
    BUS->>STR: emit
    STR->>U: data: active_leaf.changed
    EDIT-->>U: 201 {new user node}

    Note over EDIT,RT: ripple=true ⇒ background runAssistantTurn

    RT->>DB: insertNode(asst placeholder, branch=alt-2)
    RT-->>BUS: publish(node.created asst)
    BUS->>STR: emit
    STR->>U: data: node.created (asst)

    loop chunks
        RT-->>BUS: publish(content.delta)
        BUS->>STR: emit
        STR->>U: data: content.delta
    end

    RT-->>BUS: publish(node.finalized + active_leaf.changed)
    BUS->>STR: emit × 2
    STR->>U: data × 2
```

**Key invariant:** `orig` is never mutated. The new node has `edited_from_id = orig.id`, which the client uses to show the edited-from backref. Both branches stay reachable; switching between them is just moving `active_leaf_id`.

---

## 7. Clarification

The `ask_clarification` pseudo-tool pauses the turn on a `clarify.requested` event. Symmetric to approvals.

```mermaid
sequenceDiagram
    autonumber
    actor U as user
    participant RT as runtime
    participant DB as Postgres
    participant BUS as bus
    participant STR as stream
    participant CLC as runtime/clarifications
    participant API as POST /clarify/:id/answer

    Note over RT: Model invokes<br/>ask_clarification tool.
    RT->>DB: insertClarify{question, options?}
    RT-->>BUS: publish(clarify.requested)
    BUS->>STR: emit
    STR->>U: data: clarify.requested
    RT->>CLC: awaitAnswer(clarify_id)
    Note over RT: turn paused

    U->>API: POST /clarify/:id/answer {answer}
    API->>DB: recordClarifyResponse
    API-->>BUS: publish(clarify.answered)
    BUS->>STR: emit
    STR->>U: data: clarify.answered
    API->>CLC: resolveAnswer(id, answer)
    CLC-->>RT: resume with answer
    API-->>U: 200

    RT->>RT: feed answer as tool result,<br/>continue loop
```

---

## 8. AG-UI surface — `POST /` (ai-remark)

Legacy thin bridge. Stateless, no DB, no tools. Entirely separate from `/api/v1`.

```mermaid
sequenceDiagram
    autonumber
    actor AR as ai-remark (HttpAgent)
    participant H as POST /
    participant ENC as @ag-ui/encoder
    participant OLA as ollama-agent.ts
    participant OL as Ollama

    AR->>H: POST / RunAgentInput<br/>(threadId, runId, messages[])
    H->>OLA: runAgent(body, model)
    H->>AR: SSE headers (open stream)
    OLA-->>H: yield RUN_STARTED
    H->>ENC: encodeSSE(RUN_STARTED)
    H->>AR: data: RUN_STARTED
    OLA-->>H: yield TEXT_MESSAGE_START
    H->>AR: data: TEXT_MESSAGE_START

    OLA->>OL: ollama.chat(stream: true)
    loop chunks
        OL-->>OLA: chunk
        OLA-->>H: yield TEXT_MESSAGE_CONTENT {delta}
        H->>AR: data: TEXT_MESSAGE_CONTENT
    end

    OLA-->>H: yield TEXT_MESSAGE_END
    H->>AR: data: TEXT_MESSAGE_END
    OLA-->>H: yield RUN_FINISHED
    H->>AR: data: RUN_FINISHED
```

**Error path:** on any Ollama failure, `ollama-agent.ts` yields `RUN_ERROR {message}` and terminates — there is no `RUN_FINISHED` after an error.

---

## 9. Idempotency replay

Second POST with the same `Idempotency-Key` returns the first response verbatim without re-running the handler.

```mermaid
sequenceDiagram
    actor C as client
    participant IM as idempotency middleware
    participant DB as idempotency_records
    participant H as handler

    C->>IM: POST /… Idempotency-Key: K
    IM->>DB: findRecord(identity, K)
    DB-->>IM: miss
    IM->>H: next()
    H-->>IM: response
    IM->>DB: insertRecord(identity, K, response body)
    IM-->>C: 2xx response

    Note over C: network retry

    C->>IM: POST /… Idempotency-Key: K (same)
    IM->>DB: findRecord(identity, K)
    DB-->>IM: hit
    IM-->>C: 2xx cached response<br/>(handler NOT invoked)
```

Identity is the bearer token if set, else the client IP. Two clients can use the same key without colliding.

---

## 10. Event map — which code emits what

Minimal index; use this when tracing a wire event back to its source.

| Event `kind` | Emitted by | Context |
|---|---|---|
| `node.created` | `runtime/run.ts`, `api/nodes.ts` | New user or asst node inserted |
| `node.finalized` | `runtime/run.ts` | Asst turn complete, `streaming=false` |
| `active_leaf.changed` | `runtime/run.ts`, `api/nodes.ts` | Conversation's active leaf moved |
| `status.update` | `runtime/run.ts` | `thinking` / `streaming` / `tool_use` |
| `content.delta` | `runtime/run.ts` | Token chunk appended to asst content |
| `reasoning.delta` | `runtime/run.ts` (via `ThinkSplitter`) | Token chunk inside `<think>` |
| `approval.required` | `runtime/run.ts` | Tool needs user decision |
| `approval.decided` | `api/approvals.ts` (also runtime) | Decision recorded; runtime may still be asleep |
| `clarify.requested` | `runtime/run.ts` | `ask_clarification` tool invoked |
| `clarify.answered` | `api/clarify.ts` | User answered |
| `tool_call` | `runtime/run.ts` | Side-effectful tool executed |
| `artifact.written` | `runtime/run.ts` | `write_file` produced a new version |
| `error` | `runtime/run.ts` | Budget/deadline/conversation-missing failures |

All BusEvents share the envelope `{ id, at, conversation_id, kind, ... }` (see `src/events/types.ts`).
