---
title: Voice Agent ("Jarvis")
cycle: 17
date: 2026-06-08
status: shipped
feedback: ../../scope-feedback.md
shipped:
  - "Shared agent core server/lib/agent/: types.ts, tools.ts (11-tool registry over existing services), bus.ts (single-user EventEmitter), undo.ts (TTL token store, 10-min expiry), prompt.ts (system-prompt builder), loop.ts (streaming tool-calling loop: filler-before-tools, abort-on-barge-in, MAX_ROUNDS=5 then forced spoken answer), openai-chunk.ts."
  - "server/lib/ai/chat-stream.ts: streaming OpenAI client with tool_calls delta assembly + zodShapeToJsonSchema (Zod-v4)."
  - "Endpoints server/api/agent/: llm.post.ts (keyless, LAN-guarded via isPrivateAddress, exempted in auth middleware PUBLIC_PREFIXES), activity.get.ts (SSE, session-authed), undo.post.ts (session-authed), chat.post.ts (text adapter over same loop — typed fallback + future chat UI)."
  - "MCP refactor: server/lib/mcp/server.ts now registers from the shared registry (exports mcpToolNames()); MCP gained quick_capture; save_memory passes source: 'voice' by default."
  - "Frontend: app/composables/useUnmute.ts (Unmute WS + opus-recorder encode/decode, dynamic-imported client-only; two AnalyserNodes; playback; barge-in flush), useAgentActivity.ts, useTextChat.ts, app/components/voice/Reactor.client.vue (Three.js reactor), Transcript.vue, Composer.vue, app/pages/voice.vue, nav item in app/layouts/default.vue."
  - "Config: runtimeConfig.public.unmuteUrl, .env.example NUXT_PUBLIC_UNMUTE_URL. Deps: three, opus-recorder."
  - "Tests: 157 passing (unit-tested the whole agent core; frontend validated by typecheck + build; audio/voice is manual)."
deferred:
  - "Audio playback decode is the #1 risk to validate manually: useUnmute.playOpus uses decodeAudioData on streamed Ogg/Opus pages. If playback is choppy/silent, swap to opus-recorder's decoder AudioWorklet (see docs/wiki/voice-agent-integration.md §6/§10). Failure is non-fatal (try/catch)."
  - "Unmute backend LLM reconfig is a one-time manual infra step — not done by this PR. See DEPLOYMENT.md §Voice agent."
  - "Typed-fallback (/api/agent/chat) runs a separate ephemeral context from the voice conversation (no merged history) — v1 cut."
  - "No persisted conversation history. Single default voice (no picker). No gallery/clipboard tools."
  - "Destructive-confirm is prompt-driven (not a structural cross-turn gate). Universal undo is the real safety net."
  - "Tool handlers receive ToolContext.signal but don't forward it to DB service calls — abort is honored at the model-stream layer, which is where latency lives. Minor follow-up."
  - "quick_capture has no undo (no soft-delete service for createDoc)."
next_seam: "Port opus decoder AudioWorklet if playOpus proves choppy. Persisted conversation history + real chat UI via /api/agent/chat. Structural cross-turn confirm gate for destructive tools. AI model registry (cycle 12) would let the voice loop pick its model from DB instead of env."
validation: "pnpm typecheck + pnpm build pass. 157 tests pass (agent core unit tests: tools registry, bus, undo, loop tool-round + filler, prompt, chat-stream parsing helpers, MCP parity, net guard, openai-chunk framing). Frontend: typecheck + build. Manual voice loop (barge-in, filler timing, tool turn) is pending Unmute LLM reconfig on the rig."
---

# Cycle 17 — Voice Agent "Jarvis" (handover)

Round-3 cycle 1: a `/voice` page where Tony talks to MyMind with full barge-in and tool use. Also subsumes the planned Cycle 14 (in-app AI chat) by shipping a shared agent core and a text-chat endpoint the future chat UI can build on.

## What shipped

### Architecture

Two browser connections:
- **(A) WebSocket → Unmute** (192.168.2.25, subprotocol `realtime`): mic Opus up / assistant Opus + transcripts down. Feeds the Three.js reactor and transcript pane.
- **(B) SSE ← `/api/agent/activity`**: tool-call chips, undo tokens, agent state.

**The key move:** Unmute's configured LLM URL is re-pointed at `/api/agent/llm` (OpenAI `/v1/chat/completions` shape). Unmute is ears + mouth; Nitro is the brain. Unmute never knows tools exist — it sends a message list and streams back text. Tool activity goes to the in-process bus → SSE (B), never into the Unmute text stream.

### Shared agent core (`server/lib/agent/`)

Transport-agnostic: used by voice (via `llm.post.ts`), the existing MCP server (refactored to register from the same registry), and the new text-chat endpoint. One tool registry = no drift between surfaces.

The loop (`loop.ts`) streams tool-calling rounds with DI for `streamChat`/`tools`. On interrupt, Unmute aborts the HTTP call → `request.close` → `AbortController.abort()` propagates through the model stream. Filler deltas are emitted before tool execution so the user hears something immediately.

### File map summary

```
server/lib/agent/          — agent core (types, tools, bus, undo, prompt, loop, openai-chunk)
server/lib/ai/chat-stream.ts — streaming OpenAI client + zodShapeToJsonSchema
server/utils/net.ts        — isPrivateAddress() guard
server/api/agent/          — llm.post, activity.get, undo.post, chat.post
server/lib/mcp/server.ts   — refactored to register from shared registry
server/middleware/auth.ts  — /api/agent/llm added to PUBLIC_PREFIXES
app/composables/           — useUnmute.ts, useAgentActivity.ts, useTextChat.ts
app/components/voice/      — Reactor.client.vue, Transcript.vue, Composer.vue
app/pages/voice.vue
app/layouts/default.vue    — nav item
```

### Key decisions

1. **Unmute-as-LLM-proxy:** Unmute calls our `/api/agent/llm` endpoint exactly as it would call any OpenAI-spec LLM. Zero changes to Unmute's codebase; we own the reasoning + tools entirely.

2. **Two connections, not one:** Tool activity cannot go into the Unmute text stream without corrupting TTS. A separate SSE side-channel is the right seam — same pattern the clipboard SSE already uses; no new infrastructure.

3. **One shared core, three consumers:** The tool registry is the single source of truth. MCP + voice + text-chat all consume it. The MCP refactor in this cycle made that concrete (and added `quick_capture` to MCP as a side effect).

4. **Act + confirm + undo:** Creates execute immediately with an Undo chip; destructives get a prompt-driven confirm. Universal undo (TTL token → inverse fn) is the real safety net. A structural cross-turn gate is explicitly deferred.

## Deferred / known limitations

See the `deferred:` frontmatter block. The most important item:

**Audio playback decode is the #1 risk unvalidated at handover.** `useUnmute.playOpus` decodes streamed Ogg/Opus pages with `decodeAudioData`. This works in theory but depends on the browser's Opus decoder accepting incremental Ogg pages. If it fails (choppy or silent playback), the fix is to swap to opus-recorder's decoder AudioWorklet, which is the approach described in `docs/wiki/voice-agent-integration.md` §6 and §10. Failure is non-fatal (try/catch), so the page will not crash.

**Unmute LLM reconfig is pending.** The infra step (SSH to 192.168.2.25, set LLM base_url to point at MyMind) must be done before the first voice session. Instructions are in `docs/DEPLOYMENT.md §Voice agent`.

## Post-merge live test (2026-06-09)

Ran the typed `/voice` path against the real dev stack (Postgres + dev server + `:8004` model) via playwright-cli. Results:

- **Brain works end-to-end (no Unmute needed):** typed "Add a task called 'Buy milk for the voice test'" → the local `qwen3.6-35b-a3b` model emitted a `create_task` tool call → task created in the DB (verified) → activity chip *"added … to todo"* rendered → assistant confirmed. **Tool-calling on the local model is confirmed working** (this was the #1 open risk).
- **Fixed two bugs found in testing (committed to `master`):**
  1. `Reactor.client.vue` 500'd on load — `host.value` null on the first `onMounted` tick under the client-component wrapper. Now polls for the ref via rAF with a size fallback (`49585d9`).
  2. Connecting voice threw `AbortError: Unable to load a worklet's module` — opus-recorder's `audioWorklet.addModule(encoderPath)` used a default relative path that 404s when bundled. Vendored its worklet to `public/opus/` and set `encoderPath: '/opus/encoderWorker.min.js'` (`96f8383`). **Deploy note: `public/opus/` must ship in the image.**
- **Still unvalidated:** full audio round-trip (STT→loop→TTS→playback + barge-in) — needs the Unmute LLM reconfig + a real browser mic. The `playOpus` decode caveat above still stands.

## Next seam

1. Do the Unmute LLM reconfig and run the manual voice test (barge-in, filler timing, tool turn with undo).
2. If `playOpus` is choppy, port to the opus-recorder decoder AudioWorklet.
3. Persisted conversation history + real chat UI over `/api/agent/chat` (closes cycle 14 properly).
4. Structural cross-turn confirmation gate for `edit_task` / `edit_project`.
5. AI model registry (cycle 12) to let the voice loop pick its model from DB.
