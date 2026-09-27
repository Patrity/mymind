---
title: "Bridget runtime — server-owned sessions, a main thread, a turn queue, and one headless wake entry point (cycle 73)"
cycle: 73
date: 2026-09-27
status: spec
supersedes: null
mymind_task: 8fdc0fe7
---

# Bridget runtime (cycle 73)

Tony wants Bridget to stop being "an AI chat" and become a proactive, always-on, always-improving
agent — the thing OpenClaw, Hermes Agent and pi are. Research (2026-09-26, recorded on the MyMind
task) found that every one of those systems has the same shape: **one long-lived process owning a
small hand-rolled loop, a per-session run lock + inbound queue, many wake sources funnelling into
that one loop, a silent-by-default contract, bounded memory + compaction, and self-improvement in a
separate restricted pass.** None uses a graph framework. LangGraph was considered and rejected: its
features that matter here (cron, double-texting, Agent Inbox) are paid-Platform features, its
checkpointer duplicates our Postgres tables, and our inner loop (`runAgent` on AI SDK `streamText`
with `stopWhen` + `prepareStep`) is already sound.

The gap is **everything outside the loop**. This cycle builds the runtime every later proactive
feature stands on. It deliberately ships no heartbeat, no cron, no push — see [Roadmap](#9-roadmap-this-cycle-unlocks).

## 1. What is wrong today

Measured against `origin/master` @ 979ca71.

1. **A turn only exists inside a browser WebSocket.** `server/api/voice/ws.ts` owns the turn
   (`s.lock`, `s.history`, `s.ac`), persistence (`:271-459`, including rescue), and rendering.
   `close(peer)` aborts the running turn. Close the tab mid-reply and the reply dies.
2. **Nothing but a user message can run the agent.** No Nitro task calls `runAgent`.
   `server/api/agent/chat.post.ts` is stateless, unpersisted, and has no caller. The wiki's claim
   that the loop is "shared by voice + chat + cron" (`docs/wiki/voice-agent.md`) is false.
3. **No home thread, and history is unbounded.** Threads are many and equal. `assembleContext`'s
   sole caller passes no `turns` (cycle-70 Ruling 20) and `conversations.summary` has no writer, so
   a single long-lived thread would grow without limit.
4. **Runtime state is in-memory.** Deploy/restart kills in-flight turns; the promise-chain lock is
   per-socket, so two tabs on one conversation can run concurrent turns (the unlocked
   `appendMessages` read-modify-write, task `1dba07af`).
5. **Approval requires a live socket.** Headless = auto-deny. And only `exec` is `dangerous`, so
   in the interactive path *nothing else* is gated — `delete_task`, `edit_task`, `forget_memory` run
   immediately behind undo. That is acceptable when Tony is watching; it is not when he isn't.

## 2. Decisions (from the brainstorm, 2026-09-26/27)

| # | Decision | Rejected |
|---|---|---|
| D1 | **A dedicated `main` thread** for Bridget (all proactive output lands here; Tony can chat in it) **plus** ordinary side threads for focused work. Both serve different purposes. | one-thread-only; inbox with no thread |
| D2 | **Summaries flow up.** Side threads summarize when idle; main carries a small `recent-threads` tier; side threads carry a small `main-state` tier. | isolation with memory as the only bridge; manual hand-off |
| D3 | **Deny → propose → continue** for gated tools in headless runs; approval replays the stored call deterministically. | park-and-resume (needs durable execution); read-only headless |
| D4 | **In-process runtime module** with Postgres run + inbox tables. The interface is narrow enough that a later move to a separate worker process is a transport swap. | separate `bridget-agent` process now; Vercel Workflow SDK durable execution |
| D5 | Cycle-70 follow-ups (turn tier, summary writer) are **folded into this cycle** — the main thread is impossible without them. | doing them as a separate cycle first |

All four of Tony's target behaviours — dev-loop companion, chief of staff, standing errands,
self-tending brain — are the same shape (**trigger → run → deliver**) and differ only in trigger.
They are the acceptance scenarios of cycles 74–76, all of which call this cycle's `wake()`.

## 3. Architecture

New module `server/lib/agent/runtime/`. It is the **only** way a turn runs.

| Unit | Responsibility | Depends on |
|---|---|---|
| `runner.ts` | `runTurn(run)`: load history (bounded, §5), assemble context, call `handleTurn`/`runAgent`, persist with rescue. The body of `ws.ts:271-459` **moved, not rewritten**. | orchestrator, conversations service |
| `queue.ts` | `enqueue(sessionKey, input) → runId`; per-conversation worker; DB claim; steer vs follow-up drain. | `agent_runs`, `agent_inbox` |
| `sessions.ts` | `resolveSession(key)`: `main` → the main conversation (created lazily); `thread:<id>` → that conversation; `isolated:<slug>` → a fresh conversation. | conversations |
| `stream.ts` | `subscribe(conversationId, sink) → unsubscribe`; fans a running turn's `VoiceEvent`s to every attached sink via an in-process bus. A run with zero subscribers still completes. | live-bus |
| `wake.ts` | `wake({ reason, sessionKey?, prompt, model?, origin })`: the single entry point for anything that is not Tony typing. | queue |
| `summarize.ts` | Incremental thread summary writer (§5.2). | ai `chat()`, embeddings |
| `gate.ts` | Headless tool policy (§6.2). | tool registry `kind` |
| `recover.ts` | Boot recovery of orphaned runs (§7). | `agent_runs` |

### 3.1 What `ws.ts` becomes

It keeps: session auth in `upgrade`, STT, voice presets, model picker, the approval **UI protocol**,
`load` / `new` / `clear` frames. It loses: `s.lock`, `s.history`, turn execution, persistence.

- Typed or spoken turn → `enqueue(sessionKey, input)` then `subscribe(conversationId, sink)`.
- `load` → `subscribe` to that conversation (attaches to a turn already in flight — opening a thread
  mid-run shows the stream).
- **Closing the socket unsubscribes. It no longer aborts.** A turn outlives the tab.
- **Stop** is an explicit `abort(runId)` frame (fixes task `26fc248c`: stop/new left server-side
  turn state running).
- **TTS becomes a per-subscriber sink.** The runner emits text; the socket that initiated a voice
  turn synthesises audio from the events it receives. Tab closed mid-reply → text completes and
  persists, audio is dropped. Voice degrades to "no audio", never to "no turn" (existing invariant).
- `requestApproval` for **interactive** runs still round-trips the originating socket; if that
  socket has gone, the call falls through to the headless gate (§6.2) rather than blocking 120 s.

Expected size after the move: ~150 lines, from 463.

### 3.2 What does not change

`runAgent`, the tool registry and handlers, `assembleContext` internals, branching (`active_leaf_id`
walk — the "model and UI walk the same path" invariant holds because both still go through
`loadActivePath`), the MCP surface, the approval request/response frame shapes.

## 4. Data model — migration 0054, additive only

### 4.1 `conversations`

- `kind text not null default 'thread'` — `'thread' | 'main'`. Partial unique index
  `conversations_one_main` on `(kind) where kind = 'main'`.
- `summarized_through timestamptz` — the summary covers every message with `created_at` ≤ this.
  Null = no summary yet. (Postgres clock only — cycle 70's `/clear` bug was an app-clock/DB-clock
  mismatch; every timestamp here is written with `now()` in SQL.)

`summary` and `summary_embedding` already exist; this cycle is their first writer.

### 4.2 `conversation_messages`

- `role` gains the value `'event'` (text column, no enum change).
- `origin text` nullable — for `event` rows and wake-produced assistant rows, e.g.
  `wake:admin`, `wake:cc-session-end`. Null for everything Tony-initiated.

### 4.3 `agent_runs` (new)

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `conversation_id` | uuid fk → conversations, cascade | |
| `session_key` | text | as passed to `enqueue` |
| `trigger` | text | `'user' \| 'wake'` |
| `wake_reason` | text null | |
| `profile` | text | `'interactive' \| 'headless'` |
| `model_def_id` | text null | requested model; null = default chain |
| `status` | text | `queued \| running \| done \| failed \| interrupted \| aborted` |
| `suppressed` | boolean default false | `NO_REPLY` outcome (§6.1) |
| `input` | jsonb | text, attachments, skill, speak flag, modality |
| `claimed_at`, `alive_at`, `finished_at` | timestamptz | `alive_at` bumped every 10 s while running |
| `error` | text null | |
| `usage` | jsonb null | |
| `user_message_id`, `assistant_message_id` | uuid null | rows it produced |
| `created_at` | timestamptz default now() | |

Indexes: `(conversation_id, status)`, `(status, created_at)`.

**Claim** (one statement, in a transaction):

```sql
select r.* from agent_runs r
where r.status = 'queued'
  and not exists (select 1 from agent_runs x
                  where x.conversation_id = r.conversation_id and x.status = 'running')
order by r.created_at
limit 1
for update skip locked;
-- then: update … set status='running', claimed_at=now(), alive_at=now()
```

The `not exists` + a partial unique index `agent_runs_one_running` on `(conversation_id) where
status = 'running'` make two concurrent runs on one conversation **impossible**, not merely
unlikely — the unique index is the guarantee, the `not exists` just avoids the constraint error on
the happy path. This closes task `1dba07af`.

### 4.4 `agent_inbox` (new)

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `conversation_id` | uuid fk | |
| `mode` | text | `'steer' \| 'followup'` |
| `content` | text | |
| `attachments` | jsonb null | |
| `source` | text | `'user' \| 'wake'` |
| `created_at` | timestamptz default now() | |
| `consumed_by_run` | uuid null | set when drained |

Semantics:

- **Tony types while a run is active on that conversation → `steer`.** The runner's `prepareStep`
  drains unconsumed steer rows at the next step boundary and appends them as user content to the
  step's messages; the in-flight tool call completes first. The steer text is persisted as its own
  user message row in the branch, in order, so the transcript and the model agree.
- **Tony types when no run is active → a new `queued` run** (no inbox row).
- **A wake arrives while a run is active on the target conversation → a `queued` run** (follow-up
  is simply the next queued run; `agent_inbox` `followup` mode is reserved for cycle 74's
  collect/debounce and is not written this cycle).
- **Stop** → `aborted`, and any unconsumed steer rows for that run become a new queued run (Tony's
  words are never silently dropped).

### 4.5 `review_queue` — no schema change

Headless proposals (§6.2) insert `kind = 'agent-action'`, `target_kind = 'agent_run'`,
`target_id = <run id>`, payload `{ tool, args, rationale, conversationId, callId }`. Cycle 70 made
the table polymorphic. One run may propose several actions, so `agent-action` rows are exempted
from `review_queue_one_pending_per_target` (its `where` clause gains `and kind <> 'agent-action'`);
the migration drops and recreates that index. Approve/reject go through the existing
`server/api/review/[id]/resolve.post.ts`, with a new `agent-action` branch.

## 5. Context: bounded history, summaries, summaries flowing up

### 5.1 Every thread's model input

- **Verbatim tail:** messages after `summarized_through` on the active path (respecting
  `context_epoch_at`), passed to `assembleContext` as the `turns` tier — the wiring cycle 70
  deferred (task `7372f495`). Budget eviction now actually runs.
- **`summary` tier:** everything before `summarized_through`, as prose. Already rendered by
  `assembleContext` (`Earlier in this conversation:`); it simply finally has content.
- `getAgentHistory` gains `sinceSummary: true` for the runner; `getConversation` (UI) does **not** —
  same deliberate asymmetry as `/clear`: the UI shows everything, the model reads tail + summary.

### 5.2 Summary writer (`summarize.ts`)

- Runs **after a run finishes**, fire-and-forget, never on the hot path.
- Triggers: unsummarized tail > **12k tokens** (estimated with `budget.ts`'s `tier()`), or a
  side thread idle ≥ **30 min** with an unsummarized tail (checked by a new `*/10` Nitro task
  `summarize-threads`, which only calls the writer — no agent runs).
- Folds everything except the **last 6 turns** into `summary` (previous summary + newly-folded
  turns → new summary; incremental), advances `summarized_through` to the last folded message's
  `created_at`, re-embeds `summary_embedding`.
- Model: `chat('bulk', …)`, the same usage role `session-summarize.ts` uses for CC sessions. Failure is logged and harmless — the
  tail stays longer and the next trigger retries.
- **No pre-compaction memory flush is needed:** `enrichConversations` (cycle 70) already mines the
  full transcript into memories, and compaction deletes nothing.

### 5.3 Summaries flow up (D2)

- **Main** gets a fixed tier `recent-threads`, ≤ **600 tokens**: summaries of side threads with
  `last_message_at` in the last **48 h**, newest first, each prefixed by title; truncated to fit.
- **Side threads** get a fixed tier `main-state`, ≤ **300 tokens**: the first paragraph of main's
  summary. Absent until main has a summary.
- Both are new fixed tiers in `assembleContext`, capped at the source (the cycle-71 lesson: an
  unbounded fixed tier drops *every* fixed tier when it overflows `fitBudget`).

## 6. Headless runs

### 6.1 The wake contract

`wake({ reason, sessionKey = 'main', prompt, model?, origin })`:

1. Resolves the session; appends an **`event` row** (`role='event'`, `origin`, content = `prompt`)
   to the active path.
2. Enqueues a run with `trigger='wake'`, `profile='headless'`.
3. The runner builds the system prompt with a **wake section** in place of the reply-to-Tony
   framing: *"You were woken by: {reason}. Tony is not watching this turn. Do what is useful. If
   nothing merits his attention, reply with exactly NO_REPLY."*
4. Retrieval query: `synthesiseQuery(summary, liveState)` (cycle 70 §4.2) when the prompt is
   short/generic; otherwise the prompt.
5. **Suppression:** a final reply that is `NO_REPLY`, or begins/ends with it and has ≤ 300 chars
   remaining, is dropped — no assistant row, the `event` row is kept, run `done` with
   `suppressed=true`. Tool effects that happened during the run are real and stay.

**Event rows in model history** become a plain user-role sentence (*"Background wake — {reason}:
{prompt}"*) with **no bracketed markers**. Past incidents (`[image]`, repeated tool markers) show
the model imitates whatever its history looks like; a test asserts no assistant reply in the
fixture echoes the wake phrasing.

Limits: 16 steps (current `maxSteps`), **5-minute wall clock** (abort → `failed`, partial output
rescued), **at most one headless run in flight globally** this cycle (a second waits as `queued`).
Model: `model` if given, else the reasoning chain head (local qwen — free).

### 6.2 Headless tool gate (D3)

The headless profile = `agentTools` + `research_web` + `search_brain`, **never `exec`**. Each tool
call passes `gate.ts`, keyed on the tool's existing `kind`:

| class | tools | headless behaviour |
|---|---|---|
| `read` | all `kind: 'read'` | run |
| append | `save_memory`, `create_task`, `create_project`, `quick_capture`, `generate_image`, `save_document` **to a path that does not exist** | run |
| mutate / destroy | every `kind: 'destructive'` (`forget_memory`, `delete_*`, `edit_task`, `edit_project`) + `edit_document`, `edit_section`, `update_document`, `move_document`, `sync_document`, `edit_image`, `save_document` to an existing path, `create_skill`, `edit_skill` | **propose** |

**Propose** = do not run the handler; insert the `agent-action` review row; return to the model
`{ proposed: true, reviewId, note: "Queued for Tony's approval in /review." }`. The run continues.

**Approve** in `/review` → `POST /api/review/[id]/resolve` with `approve` replays
`{ tool, args }` through `buildAiTools` with approval pre-granted (deterministic — no model turn),
records the result, and appends an `event` row to the originating conversation
(*"Approved: edit_task — …"*). **Reject** appends nothing but marks the row. The replay re-validates
args against the tool's current schema; a schema mismatch fails the approval visibly rather than
running a stale call.

Memories saved headlessly are written unreviewed with `source = 'agent:wake'` (they already default
unreviewed without a confidence) — web content read in a wake run can reach memory, but cannot
reach the reviewed set Bridget retrieves from without Tony.

### 6.3 Entry points this cycle

- `wake()` internal API.
- `POST /api/admin/agent/wake` (session-authed, admin) — `{ reason, prompt, sessionKey?, model? }`.
- `/wake <prompt>` as a `client` command in the composer (cycle-71 grammar) for manual testing.

Heartbeat, cron, CC-session-end and every other trigger arrive in cycle 74 as new callers of this.

## 7. Failure handling

| failure | behaviour |
|---|---|
| runner throws | run `failed`, `error` set; existing rescue persistence (moved verbatim) saves partial user + assistant text; subscribers get the error chunk |
| model start fails | existing start-only failover, unchanged |
| process dies mid-run | on boot `recover.ts` marks `running` rows with `alive_at < now() - 60 s` as `interrupted` and appends an `event` row ("interrupted by a restart"). **No automatic retry.** |
| wake fails | activity-log `warn`; never retried in a loop |
| summarizer fails | activity-log `warn`; harmless (§5.2) |
| socket send fails | swallowed per sink; one dead sink never affects the run or other sinks |
| approval replay fails | review row `failed` with the error; `event` row in the thread says so |

Runtime flag `agent_runtime` (settings, default **on**). Off → `ws.ts` keeps a private copy of the
old in-socket path for exactly one cycle as a rollback lever; cycle 74 deletes it.

## 8. UI

- **Main thread pinned** at the top of the thread rail as "Bridget"; `/agent` opens it by default.
  Side threads list below, unchanged.
- **`event` rows** render as a thin divider: icon + `origin`-derived label + prompt excerpt
  ("woken · admin: summarise yesterday"). Never styled as Tony's message.
- **Live everywhere:** any tab/device subscribed to a conversation receives its running turn;
  opening a thread mid-run attaches (`live-bus` already fans `conversation` changes to SSE).
- **Runs drawer** on the main thread: last 50 `agent_runs` — trigger, reason, status, suppressed,
  duration, link to the produced message. The "what did she do while I was away" view.
- **`/review`** renders `agent-action` cards: tool, args (pretty), rationale, originating thread
  link, Approve / Reject.

## 9. Also in scope

- **UMAP layout off the event loop.** `compute-graph-layout` (hourly) blocks the loop for seconds;
  with turns now server-owned and streaming to multiple subscribers, that stall is user-visible.
  Move the UMAP compute into a `worker_thread`; the task awaits its message.

## 10. Testing

**DB tests (`*.db.test.ts`):**
- claim exclusivity: two concurrent claimers, one conversation → exactly one `running`; the
  partial unique index rejects a forced second.
- steer rows drained at a step boundary, persisted in order, marked consumed.
- abort converts unconsumed steer rows into a queued run.
- boot recovery marks stale `running` → `interrupted` + event row; fresh `running` untouched.
- summary writer: threshold trigger, last-6-turns kept, `summarized_through` advances, tail read
  honours it, `getConversation` still returns everything.
- at most one `main` conversation.
- approval replay: approve runs the stored call exactly once; reject runs nothing; schema drift fails.

**Unit:** `NO_REPLY` suppression edge cases; headless gate table (every registry tool classified —
a test fails if a new tool lands unclassified); event-row → history mapping; wake-section prompt;
`recent-threads` / `main-state` caps.

**Every new test is mutation-checked** (break the branch, watch it go red) — cycles 70 and 72 each
shipped tests that could not fail.

**Browser (`playwright-cli`, the acceptance scenarios):**
1. Close the tab mid-reply → reopen → the full reply is persisted.
2. Send a message mid-run → the run absorbs it (steer) without restarting.
3. `/wake` with no tab open posts into main; a `NO_REPLY` wake leaves only a run row + event row.
4. A headless `edit_task` produces a `/review` card; approving applies the edit and posts an event row.
5. Main's context contains yesterday's side-thread summary (assert via `memory:assemble` telemetry, not the reply).
6. Two tabs stream the same turn.

## 11. Risks

- **The `ws.ts` move is the riskiest change.** 280 lines of hard-won ordering (persist-before-frame,
  rescue, leaf capture). Mitigation: move verbatim, keep the comments, and carry the existing ws
  tests across before changing any behaviour.
- **Steer text in a tree.** A steered message lands between an assistant's tool call and its final
  text. Branch-walk tests must cover it, or fork/regenerate on a steered turn will misbehave.
- **Headless injection.** Wake runs read the web and sessions. The gate stops destructive effects;
  unreviewed memory stops context poisoning; appends (tasks, captures) can still be spammed — cycle
  74's budgets address volume.
- **One global headless slot** is conservative; it is a constant, raised when cycle 74 has data.

## 12. Out of scope

- Heartbeat, cron/at/every, `schedule_wake`, event triggers (CC session end, due dates) — **cycle 74**.
- Push / Telegram / ntfy, and async approval *notification* — **cycle 75**.
- Background review fork, skill curator, agent-authored skill gating in interactive runs — **cycle 76**.
- Durable execution / resuming interrupted runs; a separate worker process.
- Intent routing before retrieval (cycle-72 audit finding) — separate memory-direction track (task `2d1c9f3b`).

## 13. Roadmap this cycle unlocks

| cycle | adds | calls |
|---|---|---|
| 74 | heartbeat (agent-editable HEARTBEAT skill doc, active hours, diff-first precheck), cron/at/every, `schedule_wake` tool, CC-session-end + task-due triggers; deletes the legacy ws path | `wake()` |
| 75 | outbound channel (ntfy / web push / Telegram), delivery targets, approval notifications | run results |
| 76 | post-run review fork (memory + skill tools only, capped, provenance), skill curator, interactive skill-write gating | `wake({ sessionKey: 'isolated:…' })` |
