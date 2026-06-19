---
title: Agent Surface (/agent)
status: shipped
cycle: 28
updated: 2026-06-17
---

# Agent Surface (`/agent`)

One surface for talking **and** typing to Bridget. `/agent` (formerly `/voice`) is a single page where the Three.js visualizer is a toggle, conversations persist as resumable + searchable threads, and the same shared agent core powers every turn. This is the in-app "agent loop" — tool-scoped on the current 15-tool registry. Powerful capability tools (web research / shell / SSH / `gh` / file-edit) are a separate future cycle (**Cycle B**), not built here.

## The convergence principle (one flow, one branch)

Voice and text run through the **same** path: client WebSocket → `server/lib/voice/orchestrator.ts` (`handleTurn`/`handleUtterance`) → `runAgent` (`server/lib/agent/run.ts`). There is **no second agent code path for the UI**. A turn varies only by independent flags:

| Flag | Effect |
|---|---|
| input: mic / typed | how the turn arrives — VAD→WAV utterance vs. a `{type:'text'}` frame |
| `speak`: on / off | **the sole voice/text branch** — gates TTS *and* selects prompt mode (spoken-brief/no-markdown vs. text/markdown-ok). Default: on for mic, off for typed unless "Respond in voice" is on |
| canvas: on / off | cosmetic — show/hide the visualizer; reacts to a `typing` state for text turns |

The SSE `POST /api/agent/chat` still exists but is **headless/programmatic only** (cron, scripts) — the page does not use it.

## Entry point (`runAgent`)

`runAgent(messages, ctx, deps)` where `ctx = { signal, speak?, profile?, context? }`:
- `profile` (`server/lib/agent/profile.ts`) — `AgentProfile = { id, tools, personaKey }`. One profile this cycle: **`bridgetProfile`** (all 15 tools + the `agent_persona` persona). The shape is the seam for Cycle B (a profile selects its tool subset/prompt).
- `speak` — replaces the old `voice` boolean; drives TTS + prompt mode.
- `context` — the per-connection live-state block (see Personality).
- The system prompt is built **once** before the model loop; start-only failover + `recordEvent` observability are unchanged. `deps.buildSystemPrompt` is injectable so tests run without the DB.

## Conversation store

New tables (`server/db/schema/conversations.ts`, migration 0022), kept separate from the CC/Hermes import `sessions`/`messages`:

- **`conversations`**: `id`, `title` (auto from the first user turn via `deriveTitle`), `summary` (null — reserved), `project_id` (null — optional), `message_count`, `last_message_at`, `summary_embedding halfvec(2560)` (**reserved**, unpopulated — keyword search ships first), `created_at`/`updated_at`. Indexes: `last_message_at`, gin-trigram on `title`.
- **`conversation_messages`**: `id`, `conversation_id` (FK `ON DELETE CASCADE`), `parent_id` (nullable — **tree-capable edge, populated linearly** = parent is the prior turn; branching UI is deferred), `role`, `content`, `modality` (`voice`|`text`), `tool_calls jsonb` (assistant tool chips for resume), `created_at`. Indexes: `(conversation_id, created_at)`, gin-trigram on `content`.

Store service: `server/services/conversations.ts` — `createConversation` / `appendMessages` (linear `parent_id` chain) / `getConversation` / `getAgentHistory` (role+content only, for WS hydration) / `listConversations({q})` (keyword: title ILIKE OR a message content ILIKE; newest first, limit 50) / `deleteConversation` / `deriveTitle`.

## WebSocket protocol (`server/api/voice/ws.ts`)

Per-connection `ConnState` adds `conversationId` + `context`. Frames (client→server):
- binary WAV — a spoken utterance (`speak=true`, modality `voice`)
- `{type:'text', text, speak?}` — typed turn (`speak` default false → modality `text`, reply is `typing`)
- `{type:'interrupt'}` — barge-in / abort
- `{type:'voice', voice}` — set the TTS voice
- `{type:'load', conversationId}` — hydrate history from the store (errors surface as an `error` frame)
- `{type:'new'}` — reset history + conversation + context

After each completed turn the handler lazily creates the conversation (first turn) and appends the new user+assistant messages (with per-message modality + collected `tool_calls`), then `publishChange({resource:'conversation', action})`. Live context is assembled **once per connection** (cached on `ConnState`, rebuilt on `new`).

## Personality (Bridget)

`buildSystemPrompt({profile, speak, context})` (`server/lib/agent/prompt.ts`) composes: **[editable persona]** + **[time-of-day tone]** + **[modality rules from `speak`]** + **[live context]**.
- **Editable** — persona text in the `settings` table under key `agent_persona` (`server/lib/agent/persona.ts`, cached like `ai_config`; `DEFAULT_PERSONA` seed). Edited in-app at **`/settings → Bridget`** (`GET`/`PUT /api/settings/persona`).
- **Time-of-day** — `timeOfDayTone(now)` (morning/afternoon/evening/late-night). (Verified live: an evening turn replied "Evening, Tony!".)
- **Context-aware** — `buildLiveContext(now)` injects active projects + open tasks (assembled once per connection to bound cost).
`composePrompt` + `timeOfDayTone` are pure + unit-tested; the DB-backed loaders are E2E-validated.

## UI

`app/pages/agent/index.vue` (and `app/pages/agent/history.vue`). `/voice` redirects to `/agent` (routeRules). The WS **auto-connects on mount** (no mic) so the chat is usable immediately — **there is no Connect button**; just type and send. Controls: **Visualizer** toggle (cookie `agent-canvas`), **Respond in voice** toggle (cookie `agent-speak` → per-message `speak`), **Enable microphone** (`enableMic()`/`disableMic()` — lazy VAD; the only voice affordance, auto-connects if needed), **New**, **History** slideover (`app/components/agent/HistorySlideover.vue`), and the composer. Assistant replies render **markdown** via the shared `<MdView>` (MDC) renderer; user turns are literal text. Streamed text deltas are appended raw (they already carry their own spacing). Resume: `getConversation(id)` → set transcript → `loadConversation(id)`; `/agent?c=<id>` deep-links from the history page. The client transport (`app/composables/useVoice.ts`) decouples the WS from the mic so typing never prompts for a microphone and text chat survives an STT/TTS outage. `connect()` resolves only once the socket is OPEN, and `sendText`/`loadConversation` auto-connect transparently, so a typed send never races the handshake. Reads use `@tanstack/vue-query` (`useConversations`); the `conversation` live-resource refreshes lists across tabs.

> **Nuxt routing note:** the page lives at `pages/agent/index.vue` (not `pages/agent.vue`) so `/agent` and `/agent/history` are **sibling** routes. With `pages/agent.vue` + `pages/agent/history.vue`, Nuxt nests `/agent/history` under `agent.vue`, which has no `<NuxtPage/>` outlet, so the history route renders the agent shell. (Caught by E2E; typecheck/build pass either way.)

## Deferred (not built this cycle)

- **Cycle B1 (shipped, cycle 29)** — `web_search` + `web_fetch` read-only web research tools on the default toolset; SSRF-guarded; SearXNG bundled (zero-config). See [web-research.md](web-research.md).
- **Cycle B2 (shipped, cycle 30)** — approval-gate harness + constrained `exec` tool (`powerful` profile opt-in, per-command Approve/Deny prompt, persisted allowlist, `setpriv` privilege drop, `/workspace` jail, stripped env). See [agent-exec.md](agent-exec.md).
- **Cycle B3+** — `gh` / file-edit / report rendering + SSH (ride the B2 harness; not yet built).
- Conversation **summarization worker** + **semantic search** (the `summary_embedding` column is reserved; keyword ships now).
- **Branching UI** (edit/regenerate → fork): the `parent_id` edge exists; `active_leaf_id`/path-walking + UI are future.
- Storing voice **audio** (transcript text only), command-palette integration, token-cost display, multi-profile UI.

See also: [voice-agent.md](voice-agent.md) (the self-hosted STT/TTS pipeline + visualizer), [ai-providers.md](ai-providers.md) (model registry), [live-reactivity.md](live-reactivity.md), [web-research.md](web-research.md) (`web_search` + `web_fetch` tools, SSRF guard, SearXNG), [agent-exec.md](agent-exec.md) (approval gate + constrained exec, Cycle B2).
