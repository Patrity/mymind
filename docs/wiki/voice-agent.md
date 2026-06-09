---
title: Voice Agent
status: shipped
cycle: 17
updated: 2026-06-08
---

# Voice Agent

A `/voice` page where Tony talks to MyMind. Self-hosted [Unmute](https://github.com/kyutai-labs/unmute) (192.168.2.25) provides STT + TTS with semantic-VAD barge-in. A Nitro agent loop is the brain: it runs a tool-calling loop over MyMind's services and streams spoken replies back. A Three.js reactor visualizes the conversation.

## Two-connection architecture

The browser holds two simultaneous connections:

```
┌─ Client: /voice page ─────────────────────────────────────────┐
│  (A) WebSocket  ⇄  Unmute /api/v1/realtime (subprotocol       │
│       "realtime") — mic Opus up / assistant Opus + transcripts │
│       down; feeds the Three.js reactor + transcript pane       │
│  (B) SSE  ←  MyMind /api/agent/activity                        │
│       ↓ tool-action chips, undo tokens, agent state            │
└────────────────────────────────────────────────────────────────┘
          │ (A)                               ↑ (B)
          ▼                                   │
┌─ Unmute (192.168.2.25) ─┐      ┌─ MyMind Nitro ──────────────┐
│  STT → [LLM] → TTS      │      │  /api/agent/llm              │
│          │               │      │   • OpenAI /v1/chat/compl.   │
│          └── HTTP ───────┼─────▶│     shape, streaming SSE     │
│      (re-pointed here)   │      │   • runs agent loop          │
└──────────────────────────┘      │   • emits tool-activity→bus─┼─▶ (B)
                                  └─────────┬────────────────────┘
                                            ▼
                                  server/services/* (unchanged)
```

**The defining move:** Unmute's configured LLM URL is re-pointed at `/api/agent/llm` (OpenAI `/v1/chat/completions` shape). Unmute handles ears + mouth; Nitro handles reasoning + tools. Unmute never knows tools exist — it sends a message list and receives streamed text. Tool activity goes to an in-process bus → SSE (B), never into the Unmute text stream.

## `/api/agent/*` endpoints

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/agent/llm` | **none** — LAN-only via `isPrivateAddress` + proxy rules | OpenAI-compatible brain endpoint Unmute calls. Runs the agent loop, streams SSE text deltas, emits activity. |
| `GET /api/agent/activity` | web session | SSE side-channel: tool-call chips, undo tokens, agent state. |
| `POST /api/agent/undo` | web session | Execute an undo token (runs the `inverse` fn). |
| `POST /api/agent/chat` | web session | Text adapter over the same loop — typed fallback and future chat UI. |

`/api/agent/llm` is exempted from the auth middleware (`PUBLIC_PREFIXES`) and defended in-handler by `isPrivateAddress(getRequestIP(event, {xForwardedFor:true}))`. See DEPLOYMENT.md for the mandatory proxy rules — the XFF check is spoofable without them.

## Shared agent core (`server/lib/agent/`)

One transport-agnostic core shared by voice, the MCP server, and the text-chat endpoint. See [mcp.md](mcp.md) — the MCP server was refactored to register from this same registry; the tool list is identical.

| File | Purpose |
|---|---|
| `types.ts` | `AgentTool`, `ToolContext`, `ToolExecution`, `LoopEvent`, `ActivityEvent` |
| `tools.ts` | Registry of 11 tools (read/create/destructive) wrapping existing services |
| `bus.ts` | Single-user in-process EventEmitter; mirrors clipboard SSE pattern |
| `undo.ts` | TTL token store (10 min) mapping token → `inverse` fn |
| `prompt.ts` | System-prompt builder (confirm-before-destructive, filler policy) |
| `loop.ts` | Streaming tool-calling loop (DI for `streamChat`/`tools`; `MAX_ROUNDS=5`) |
| `openai-chunk.ts` | Helpers to frame text deltas as OpenAI SSE chunks |

### Tool registry (11 tools)

| Tool | Kind | Service |
|---|---|---|
| `search_memories` | read | memory.searchMemories |
| `get_recent_memories` | read | memory.listMemories |
| `save_memory` | create | memory.createMemory (optional `source`, defaults to 'voice') |
| `search_docs` | read | documents.searchDocs |
| `search_projects` | read | projects.listProjects |
| `create_project` | create | projects.createProject |
| `edit_project` | destructive | projects.updateProject |
| `search_tasks` | read | tasks.listTasks |
| `create_task` | create | tasks.createTask |
| `edit_task` | destructive | tasks.updateTask |
| `quick_capture` | create | documents.createDoc (`/input/<slug>.md`) |

## Write-safety

- `read` — run freely.
- `create` — execute immediately, speak the result, show an **Undo** chip. Undo runs the `inverse` fn (deletes the created row). `quick_capture` has no undo (no soft-delete service).
- `destructive` — the system prompt instructs the model to confirm with Tony before calling `edit_task` / `edit_project`. This is prompt-driven (not a structural cross-turn gate). Universal undo is the real safety net.

## Loop behavior

- `MAX_ROUNDS=5` then a forced spoken final answer (prevents infinite tool loops).
- **Filler before tools:** when the first model pass returns tool calls and no text, the loop immediately emits a short spoken filler (`"One sec…"`, `"Let me check…"`, …) so the user hears something while tools run.
- **Barge-in / abort:** Unmute aborts the HTTP call on interrupt; `event.node.req` `close` event fires → `AbortController.abort()` propagates `signal` to `streamChat` and tool handlers.

## Env var

| Var | Notes |
|---|---|
| `NUXT_PUBLIC_UNMUTE_URL` | Client-side WebSocket base URL, e.g. `wss://unmute.example.com`. Exposed as `runtimeConfig.public.unmuteUrl`. |

## Frontend files

| File | Purpose |
|---|---|
| `app/pages/voice.vue` | Layout: reactor, transcript, composer, connection state |
| `app/composables/useUnmute.ts` | Unmute WS + opus-recorder encode/decode; two AnalyserNodes (mic + playback); barge-in flush. Dynamic-imported (client-only). |
| `app/composables/useAgentActivity.ts` | SSE → tool chips, undo tokens, agent state |
| `app/composables/useTextChat.ts` | Text-chat adapter over `/api/agent/chat` |
| `app/components/voice/Reactor.client.vue` | Three.js reactor (amplitude → scale/emissive; state → palette) |
| `app/components/voice/Transcript.vue` | Live transcript + tool-action chips + Undo buttons |
| `app/components/voice/Composer.vue` | Typed fallback input |

Dependencies added: `three`, `opus-recorder` (`@types/three` dev).

## Audio decode caveat

`useUnmute.playOpus` uses `decodeAudioData` on streamed Ogg/Opus pages. This is the **#1 risk to validate manually** in a real voice session: if playback is choppy or silent, swap to opus-recorder's decoder AudioWorklet (the approach documented in `voice-agent-integration.md` §6 and §10). The failure is non-fatal (try/catch), so the page will not crash — it will just be silent.

## Cross-references

- `docs/wiki/voice-agent-integration.md` — Unmute WebSocket protocol, audio encoding, event reference, smoke test.
- `docs/wiki/mcp.md` — MCP server, now sharing the same tool registry.
- `docs/DEPLOYMENT.md §Voice agent` — Unmute LLM reconfig + proxy LAN-restriction rules.
