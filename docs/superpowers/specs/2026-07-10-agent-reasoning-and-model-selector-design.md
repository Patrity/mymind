---
title: Agent Reasoning Block + On-the-fly Model Selector
status: approved
date: 2026-07-10
cycle: 45
---

# Agent Reasoning Block + On-the-fly Model Selector — Design

Two additions to the agent chat surface (`app/pages/agent/index.vue`):

1. **Reasoning ("thinking") block** — surface the `reasoning_content` the local Qwen3.6 model already emits (and the AI SDK already parses as `reasoning-delta` parts) as a collapsible block per assistant turn. Today `run.ts` drops these parts on the floor.
2. **On-the-fly model selector** — a dropdown in the agent navbar that lists the models assigned to the `reasoning` usage and lets Tony switch which one the agent runs on, live, without editing Settings.

Both features target **only the WebSocket pipeline** (`voice.sendText` → `ws.ts` → `handleTurn` → `runAgent`). The SSE `/api/agent/chat` + `useTextChat` path is confirmed dead code (nothing imports `textStreamToTranscript`); it is left untouched and flagged for later removal.

## Context (why this is cheap)

- The agent uses the `reasoning` registry role. Its chain today is `openai/qwen3.6-35b-a3b` (thinking on) → `qwen3.6-35b-a3b` (thinking off), both on the same LiteLLM gateway (`192.168.2.85:4000`).
- `@ai-sdk/openai-compatible@2.0.48` maps `reasoning_content` deltas to distinct `reasoning-start` / `reasoning-delta` / `reasoning-end` parts — separate from `text-delta`. Verified empirically (2026-07-10) that tool-calling stays clean while reasoning is present, so no risk to the agent loop.
- `run.ts` sets **no `maxOutputTokens`**, so thinking never truncates the agent (unlike the capped `bulk`/batch callers). The agent has 33/33 clean runs on the thinking alias.
- `ws.ts`'s `emit` closure already forwards any non-audio `VoiceEvent` to the peer as JSON, and already captures per-turn side data (`toolCalls`) for persistence — the same seam carries reasoning.

## Decisions (locked with Tony, 2026-07-10)

| Decision | Choice |
|---|---|
| Reasoning persistence | **Persist per message** — new `reasoning text` column on `conversation_messages`. Survives reload + History resume. |
| Never fed back to the model | Reasoning is display/storage only. `getAgentHistory` (model context) keeps ignoring it; only the UI-hydration read (`getConversation`) selects it. Prompt input stays clean; cost flat. |
| Model-switch scope | **Ephemeral session override** — cookie-backed, sent over WS, applied at the connection level. Does **not** write `ai_config`. |
| Failover under override | Chosen model moves to the **front** of the resolved chain; the rest stay as failover. |
| Dropdown contents | **Reasoning chain only** (the models assigned to the `reasoning` usage), plus a "Default (chain order)" entry that clears the override. |

## Architecture

### 1. Data model (migration)

Add to `conversation_messages` (`server/db/schema/conversations.ts`):

```
reasoning: text('reasoning')   // nullable; assistant turns only; never sent back to the model
```

One drizzle migration. No index (not searched). `getAgentHistory` continues to select only `role`/`content` (+ existing) — reasoning is **excluded** from model context by construction. `getConversation` (UI hydration) adds `reasoning` to its select.

### 2. Reasoning block — server pipeline

**`server/lib/agent/run.ts`**
- Add `AgentEvent` variant `{ type: 'reasoning-delta'; text: string }`.
- In the `fullStream` loop, handle the SDK reasoning-delta part alongside `text-delta`. Mirror the existing dual-shape read (`p.delta ?? p.text ?? ''`); the exact field is verified against `node_modules/@ai-sdk/openai-compatible` at build time.

**`server/lib/voice/orchestrator.ts`**
- Add `VoiceEvent` variant `{ type: 'reasoning'; text: string }`.
- On `ev.type === 'reasoning-delta'`: `deps.emit({ type: 'reasoning', text: ev.text })` and accumulate into a local `reasoningText`. **Never** push to the `SentenceChunker`/TTS and **never** append to `assistantText` — voice turns must not speak the thinking, and it must not pollute the persisted answer.

**`server/api/voice/ws.ts`**
- In the `emit` closure, capture reasoning the same way `toolCalls` is captured: on `e.type === 'reasoning'`, `reasoningText += e.text` (the generic `else` branch already `peer.send`s it to the client).
- Pass `reasoning: m.role === 'assistant' ? (reasoningText || null) : null` into `appendMessages`.

### 3. Reasoning block — client + UI

**`app/lib/voice/messages.ts`**
- `ServerMsg` gains optional carriage of the reasoning frame; `MsgEffect` gains `reasoning?: string`. `mapServerMessage`: `if (m.type === 'reasoning' && m.text) return { reasoning: m.text, events }`.

**`app/composables/useVoice.ts`**
- `TranscriptEntry` gains `reasoning?: string`.
- New `pushReasoning(text)`: reasoning arrives before the answer text. If the last entry is the current turn's assistant entry, append to its `reasoning`; otherwise start a new assistant entry with `text: ''` and `reasoning: text` seeded. The subsequent `pushDelta('assistant', …)` appends answer text to that same bubble (existing same-role-append logic). (Multi-step turns: reasoning emitted after a tool chip seeds a fresh assistant bubble — reasoning attaches to the nearest following answer bubble. Acceptable for v1.)
- WS `onmessage`: `if (fx.reasoning) pushReasoning(fx.reasoning)`.

**`app/pages/agent/index.vue`**
- `resume()` hydrates `reasoning` from persisted messages onto the rebuilt assistant `TranscriptEntry` (requires `getConversation` to return it).

**`app/components/voice/Transcript.vue`**
- For assistant entries with non-empty `reasoning`, render a collapsible **"Thinking"** block above the `MdView` answer, using a `<details>`/`UCollapsible` in the style of `content/Collapsible.vue`. Collapsed by default; reasoning shown as muted `whitespace-pre-wrap` text (not MDC — keeps it visually secondary and cheap). While a turn is actively thinking with no answer text yet, the block auto-opens, then collapses once answer text begins.

### 4. Model selector — server

**`server/lib/agent/model.ts` + `run.ts`**
- `reasoningModels(modelDefId?: string)`: resolve `resolveChain('reasoning')`, then if `modelDefId` is present in the chain, move that entry to the front (stable order for the rest → failover preserved). Unknown id → unchanged chain (safe fallback).
- `runAgent` ctx gains `modelDefId?: string`; passes it to `reasoningModels`.

**`server/lib/voice/orchestrator.ts`**
- `TurnDeps` gains `modelDefId?: string`; `handleTurn`/`handleUtterance` thread it into `run(messages, { …, modelDefId })`.

**`server/api/voice/ws.ts`**
- `ConnState` gains `model: string | null`.
- New control frame `{ type: 'model', modelDefId }` sets `s.model` (mirrors the set-and-remember `voice` frame; `modelDefId: null` clears it). Every subsequent turn (voice or text) passes `modelDefId: s.model ?? undefined` into the turn deps.

### 5. Model selector — client + UI

**`app/composables/useVoice.ts`**
- Track `desiredModel` (like `desiredVoice`); resend on WS (re)open. New `setModel(modelDefId: string | null)`: updates `desiredModel` and sends `{ type: 'model', modelDefId }` when the socket is open.

**`app/pages/agent/index.vue`**
- Load the reasoning chain via `useAiConfig()` (`load()` then `assignments.reasoning` → map to `models` for `{ id, label }`). Build options = chain models + a leading **"Default (chain order)"** (value = null).
- A `USelectMenu` in the navbar (both header variants, alongside the existing controls), bound to a cookie `agent-model` (modelDefId | null, like `showCanvas`/`speakReply`). On change → `voice.setModel(id)`.

## Data flow

```
User turn ─► ws.ts (s.model) ─► handleTurn(modelDefId) ─► runAgent(modelDefId)
                                                              │
                                     reasoningModels(modelDefId) reorders chain
                                                              │
        AI SDK fullStream ─┬─ text-delta   ─► emit transcript ─► answer bubble
                           └─ reasoning-delta ─► emit reasoning ─► Thinking block
                                                              │  (also accumulated)
                        ws.ts emit closure captures reasoningText
                                                              │
                        appendMessages(..., reasoning) ──► conversation_messages
                                                              │
                        resume(): getConversation() ──► hydrate reasoning on reload
```

## Error handling / edge cases

- **Override id stale** (config changed, id no longer in chain): `reasoningModels` ignores it → normal chain. No error surfaced.
- **Reasoning must never reach the model**: enforced by capturing in `ws.ts`/orchestrator locals, not on the `AgentMessage`, and by `getAgentHistory` not selecting the column.
- **Voice turns**: reasoning is emitted + persisted but never synthesized; the caption (`agent/index.vue`) reads `.text`, so the empty-text-then-streaming assistant entry behaves as today.
- **Barge-in / abort mid-thinking**: existing abort path returns before append; partial reasoning is simply not persisted (turn discarded), same as partial answer today.

## Testing

- **Unit**
  - `mapServerMessage`: `reasoning` frame → `{ reasoning }` effect.
  - `reasoningModels(modelDefId)`: chosen id reordered to front, failover order preserved; unknown id → unchanged.
  - `orchestrator`: a fake `runAgent` yielding `reasoning-delta` emits a `reasoning` VoiceEvent and does **not** call TTS for it; `reasoningText` accumulates.
  - `run.ts`: a fake stream with reasoning parts yields `reasoning-delta` events.
  - persistence: `appendMessages` + `getConversation` round-trip `reasoning`; `getAgentHistory` omits it.
- **Browser (`playwright-cli`, per project rule)** — invoke the `browser-testing` skill:
  - Send a turn → a collapsed **Thinking** block renders on the assistant bubble; expand/collapse works; reload/History-resume still shows it.
  - Switch the model dropdown → the next turn runs on the chosen model (verify via `activity_log.model_id` for the `reasoning:agent` event).

## Scope / YAGNI

- No separate live "reasoning stream" pane; it lives inline on the bubble.
- No per-message model pinning in history; override is connection/session-level.
- No reasoning in the voice caption.
- No touching or reviving the dead SSE `/api/agent/chat` path.
- No new read endpoint for the model list — reuse `GET /api/settings/ai-config` via `useAiConfig`.

## Wiki

On ship, update the agent/voice system wiki page (`docs/wiki/`) with the reasoning column, the `reasoning` VoiceEvent, the `model` control frame, and the two new UI controls; mirror the page to MyMind.
