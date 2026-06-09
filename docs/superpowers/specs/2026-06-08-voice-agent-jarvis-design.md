---
title: Voice Agent ("Jarvis") — Design
status: spec
cycle: 17
created: 2026-06-08
supersedes_note: Subsumes and extends the planned Cycle 14 (in-app AI chat). The shared agent core built here is the same core a future text-chat page would use.
---

# Voice Agent ("Jarvis") — Design Spec

A voice-first assistant page where Tony talks to MyMind. A self-hosted **Unmute** instance
(192.168.2.25) provides STT + TTS with semantic-VAD barge-in. A **MyMind Nitro agent loop**
is the brain: it runs a tool-calling loop over MyMind's existing services and streams spoken
replies back. A **Three.js reactor** visualizes the conversation.

The defining constraints:
- **Streaming + barge-in are non-negotiable** and must match today's Unmute UX.
- **One transport-agnostic agent core** — voice, a future text-chat UI, and the existing MCP
  server all consume the same tool registry and loop. No per-surface duplication.

---

## 1. Architecture

The key move: **Unmute's configured LLM URL is re-pointed at a MyMind Nitro endpoint, and that
endpoint *is* the agent loop.** Unmute remains ears + mouth; Nitro is the brain. Unmute never
needs to know tools exist — it sends a message list to an OpenAI-spec `/v1/chat/completions`
URL and receives streamed text. Our endpoint does the tool work internally and streams back the
final (and interim "filler") text, which Unmute speaks.

```
┌─ Client: /jarvis page ────────────────────────────────────────┐
│  (A) WebSocket  ⇄  Unmute /api/v1/realtime                     │
│        ↑ mic Opus up   ↓ assistant Opus + transcripts down     │
│        → feeds the Three.js reactor (audio) + transcript pane  │
│  (B) SSE        ←  MyMind /api/agent/activity                  │
│        ↓ tool-call chips, undo tokens, agent state             │
└────────────────────────────────────────────────────────────────┘
            │ (A)                                  ↑ (B)
            ▼                                      │
┌─ Unmute backend (192.168.2.25) ─┐      ┌─ MyMind Nitro ─────────────────┐
│  STT → [LLM] → TTS              │      │  /api/agent/llm  (the brain)    │
│         │                       │      │   • OpenAI /v1/chat/completions │
│         └── HTTP, OpenAI spec ──┼─────▶│     shape, streaming SSE        │
│            (re-pointed here)    │      │   • runs AGENT CORE             │
└─────────────────────────────────┘      │   • emits tool-activity → bus ─┼──▶ (B)
                                         │   • calls reasoning model+tools │
                                         └─────────────┬───────────────────┘
                                                       ▼
                                         server/services/* (tasks, memory,
                                         docs, projects, capture) — unchanged
```

### Why two client connections
Unmute already streams audio **and** transcripts over (A) — free, per the integration wiki. But
tool actions happen inside the Nitro brain, invisible to Unmute. (B) is a thin side-channel that
pushes "called search_tasks", undo tokens, and agent state to the page. MyMind is single-user, so
the bus is a global in-process broadcast — the same pattern the **clipboard SSE** already uses; no
session correlation needed.

### Latency / barge-in properties
- **Non-tool turns:** Nitro is a pass-through proxy — receives Unmute's request, forwards to the
  reasoning model, streams token deltas straight back. One sub-ms LAN hop; streaming + barge-in are
  identical to today.
- **Tool turns:** added latency is the tool round-trip itself (`model picks tool → tool runs →
  model writes answer`), inherent to any voice tool-agent — **not** a cost of this architecture.
  Masked by streaming an instant spoken **filler** ("let me check…") as the first deltas while the
  tool runs under it.
- **Barge-in:** owned by Unmute's semantic VAD as today. On interrupt, Unmute aborts the HTTP call
  to `/api/agent/llm`; our endpoint must propagate that `AbortSignal` to the reasoning model and any
  in-flight tool. Honoring cancellation is the entire cost of preserving barge-in.

---

## 2. The shared agent core (server/lib/agent)

Transport-agnostic; this is what makes the feature reusable.

### 2.1 Tool registry — `tools.ts` (single source of truth)
Each tool is one object:
```ts
interface AgentTool {
  name: string
  description: string
  schema: ZodRawShape           // → OpenAI tool JSON schema AND MCP registration
  kind: 'read' | 'create' | 'destructive'
  handler: (args, ctx) => Promise<unknown>
  inverse?: (result, args) => Promise<void>   // for undo (create/destructive)
}
```
Tools (reuse existing services 1:1, plus capture):

| Tool | kind | service | inverse |
|---|---|---|---|
| `search_memories` | read | memory.searchMemories | — |
| `get_recent_memories` | read | memory.listMemories | — |
| `save_memory` | create | memory.createMemory | delete memory |
| `search_docs` | read | documents.searchDocs | — |
| `search_projects` | read | projects.listProjects | — |
| `create_project` | create | projects.createProject | delete/deactivate project |
| `edit_project` | destructive | projects.updateProject | restore prior fields |
| `search_tasks` | read | tasks.listTasks | — |
| `create_task` | create | tasks.createTask | delete task |
| `edit_task` | destructive | tasks.updateTask | restore prior fields |
| `quick_capture` | create | capture service (note/todo) | delete capture |

`edit_*` inverses snapshot the prior row before mutating so undo can restore it.

### 2.2 Agent loop — `loop.ts`
Transport-agnostic async generator: takes `messages` + an `AbortSignal`, calls the streaming model
with the registry's tool schemas, executes returned `tool_calls` via handlers, feeds results back,
and loops until the model emits a final answer. Yields a stream of events: `text-delta`,
`tool-start`, `tool-result`, `done`. Honors the `AbortSignal` (cancels model + tools on barge-in).

**Filler behavior:** when the first model pass returns tool calls (no content), the loop emits a
short, rotated spoken filler as `text-delta`s *before* running tools, so the user hears speech
immediately. (v1: small templated rotation; refine to model-generated later.)

### 2.3 Streaming model client — `server/lib/ai/chat-stream.ts`
Extends today's non-streaming `chat.ts`: OpenAI-spec `/v1/chat/completions` with `stream: true`,
`tools`, and incremental `tool_calls` delta assembly. Uses the `reasoning` role (default = local
qwen 27B; env-swappable to a hosted model if local function-calling proves unreliable).

### 2.4 Event bus — `bus.ts`
Single-user in-process `EventEmitter`. The loop publishes tool-activity + state; the activity SSE
route subscribes and forwards to the page. Mirrors the existing clipboard SSE.

### 2.5 Undo — `undo.ts`
On each `create`/`destructive` execution, register `{ token, inverse }` in a short-TTL in-memory
map and emit the token on the activity bus. `/api/agent/undo` runs the inverse and clears the token.

### 2.6 MCP refactor — `server/lib/mcp/server.ts`
Re-registers from `tools.ts` instead of inlining 10 tools, so MCP and the voice agent cannot drift.
Behavior-preserving for existing MCP clients.

---

## 3. Endpoints (server/api/agent)

| Route | Auth | Purpose |
|---|---|---|
| `llm.post.ts` | **none** (LAN-only at the proxy) | OpenAI `/v1/chat/completions` shape; Unmute points here. Runs the loop, streams SSE text deltas, emits activity. |
| `activity.get.ts` | web session | SSE of tool chips / undo tokens / agent state to the page. |
| `undo.post.ts` | web session | Runs the inverse for an undo token. |
| `chat.post.ts` | web session | Text-only adapter over the **same loop** (no TTS) → typed fallback + future chat page. |

**Security:** the app is internet-exposed, and `/api/agent/llm` is unauthenticated **and** mutating.
It MUST be restricted to the private network (allow `192.168.2.25` / RFC1918, deny external) at the
reverse proxy. This honors "no key on Unmute" without a public mutation hole. The other three routes
go through the existing dual-auth web-session middleware.

---

## 4. Write-safety policy

Chosen behavior: **act + confirm + undo** (creates) / **confirm-first** (destructive), universal undo.

- `read` → run freely.
- `create` → execute immediately, speak what was done ("added 'buy milk' to todo"), show an **Undo**
  chip. Undo = `inverse` (delete the created row).
- `destructive` → the system prompt instructs the model to **speak a confirmation and only act on
  the user's "yes"** the following turn. **Honest limitation:** the endpoint is stateless per turn,
  so this is *prompt-driven*, not structurally enforced. **Universal undo is the real safety net.**
  (A structural cross-turn confirmation gate is a deliberate later hardening.)

---

## 5. Frontend (app)

| File | Purpose |
|---|---|
| `pages/jarvis.vue` | Layout: central reactor, transcript pane, composer, connection state. |
| `composables/useUnmute.ts` | Ported Unmute audio plumbing: WS (`subprotocol "realtime"`), opus-recorder encode/decode per wiki §6, event loop, two `AnalyserNode`s (mic + playback), transcript stream, barge-in flush. |
| `composables/useAgentActivity.ts` | Subscribes to `/api/agent/activity` SSE → tool chips, undo, agent state. |
| `components/jarvis/Reactor.client.vue` | Three.js 3D reactor: rotating core + orbiting node particles; amplitude → scale/emissive/displacement; state → palette. |
| `components/jarvis/Transcript.vue` | Live transcript (you + assistant) + tool-action chips + undo buttons. |
| `components/jarvis/Composer.vue` | Typed fallback input (posts to `/api/agent/chat`). |

**Visualizer state machine** (drives palette + motion):
```
idle ─speech_started→ listening ─speech_stopped→ thinking ─audio.delta→ speaking
  ▲    (tool running: bus event → faster spin / amber)                    │
  └──────────── response.done / interrupted_by_vad ──────────────────────┘
```
Audio reactivity: the mic `AnalyserNode` feeds `listening`; the playback `AnalyserNode` feeds
`speaking`; the reactor reads whichever stream is active.

**Deps:** `three`, `opus-recorder`. **Nav:** add `/jarvis` to the sidebar.
**Env:** `NUXT_PUBLIC_UNMUTE_URL` (client WS target). **Secure context:** mic needs HTTPS or
localhost (prod serves HTTPS; dev uses a localhost tunnel) — per the integration wiki §9.

---

## 6. Unmute backend reconfig (one-time, documented)

Via SSH to `tony@192.168.2.25`: set Unmute's LLM `base_url` to `http://<mymind-host>/api/agent/llm`
(and leave its API key empty / dummy — endpoint is unauthenticated, proxy-restricted). Document the
exact config key + restart in the spec's deploy notes and `docs/DEPLOYMENT.md`. The client's Unmute
`session.update` carries a minimal persona (real persona/tools live in our loop's system prompt) and
a default voice.

---

## 7. Testing

- **Unit/integration (high-value, no audio):**
  - Agent loop with a **mock model**: tool selection, execution, abort propagation, streaming
    deltas, filler emission, undo inverses.
  - Registry ↔ MCP parity (same tools, same schemas).
  - `/api/agent/llm`: POST an OpenAI-style request → assert SSE deltas + tool side-effects + activity
    events (the brain's smoke test, mirroring the wiki's no-audio connection test but for tools).
- **E2E (`playwright-cli`):** `/jarvis` renders, reactor canvas mounts, a simulated tool action
  yields a chip, undo works.
- **Manual:** full voice loop after the Unmute reconfig — barge-in, filler timing, a tool turn.
  (The one thing automation can't cover.)

---

## 8. Scope / YAGNI (v1 cuts, revisit later)

- No persisted conversation history (Unmute holds voice context; typed is ephemeral).
- Typed fallback runs a **separate** lightweight context from voice (no merged history v1).
- Single default voice (no picker).
- No gallery/clipboard tools (chosen scope: existing 10 MCP tools + quick-capture).
- Destructive-confirm is prompt-driven, backed by universal undo (no structural gate yet).
- Reasoning model defaults to local qwen 27B; hosted fallback is an env swap, not new code.

---

## 9. Unit boundaries (what depends on what)

- `tools.ts` depends only on `server/services/*` → consumed by `loop.ts` **and** MCP server.
- `loop.ts` depends on `tools.ts` + `chat-stream.ts` + `bus.ts`; transport-agnostic.
- `llm.post.ts` / `chat.post.ts` are thin HTTP adapters over `loop.ts`.
- `useUnmute.ts` owns all audio/WS; the page and reactor consume its analysers + events.
- The reactor depends only on an `AnalyserNode` + a state enum — swappable/testable in isolation.
