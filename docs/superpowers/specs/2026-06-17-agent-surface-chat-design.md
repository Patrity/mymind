---
title: Unified Agent Surface (/agent) + Conversation Persistence + Bridget
date: 2026-06-17
status: design
cycle: 28
related:
  - 2026-06-08-voice-agent-jarvis-design.md
  - 2026-06-09-voice-self-hosted-redesign-design.md
  - 2026-06-09-voice-visualizer-redesign-design.md
  - 2026-06-10-ai-config-registry-design.md
  - 2026-06-12-live-reactivity-design.md
  - ../../handovers/2026-06-09-voice-v2.md
  - ../../handovers/2026-06-10-voice-visualizer.md
---

# Unified Agent Surface (`/agent`) + Conversation Persistence + Bridget

This is the first of two cycles that graduate the shared `runAgent` core into a first-class in-app assistant. **Cycle A (this spec)** unifies voice and text into one surface, persists conversations as resumable/searchable threads, and gives Bridget a real, editable, context-aware personality — all on the **current safe 15-tool surface**. **Cycle B (a separate, security-first brainstorm)** adds the powerful capability tools (deep web research, shell, SSH, `gh`, file-editing/report-rendering) and is explicitly out of scope here.

## The core principle: minimal divergence (a plan constraint, not just a goal)

Voice and text already share `runAgent` (`server/lib/agent/run.ts`) via the orchestrator (`server/lib/voice/orchestrator.ts` → `handleTurn`). A typed turn already runs the **identical** loop today — the only reason it is "voice" is that `handleTurn` always calls `speak()` (TTS) and passes `voice: true` to `runAgent`. This cycle keeps that convergence and tightens it.

**Hard constraint, to be carried verbatim into the implementation plan:** the UI must not fork voice vs. text beyond a single `speak` branch inside `handleTurn`. There is **no second agent code path for the UI** — no parallel chat composable/endpoint driving the page. The existing SSE `POST /api/agent/chat` is **retained only as a headless/programmatic API** (cron, MCP-style callers); the `/agent` page uses the WebSocket for both typing and talking. Every implementation task must be reviewed against this constraint.

A turn varies only by three **independent flags**:

| Flag | Values | Effect |
|---|---|---|
| `input` | mic / typed | how the user's turn arrives: VAD→WAV utterance vs. `{type:'text'}` frame |
| `speak` | on / off | TTS the reply **and** select prompt mode (spoken-brief vs. markdown-ok). Default: **on** for mic turns, **off** for typed turns unless "respond in voice" is toggled |
| `canvas` | on / off | cosmetic only — show/hide the Three.js Reactor; reacts to a new `typing` state |

## 1. Entry-point parameterization

Generalize `runAgent`'s current `ctx.voice: boolean` into a small profile-aware context:

```ts
ctx = { signal: AbortSignal; profile: AgentProfile; speak: boolean }
```

- **`profile`** — Cycle A ships exactly one profile, `"bridget"`, which resolves to the persona + the current 15 tools. The *shape* is the seam for Cycle B (a profile selects its tool subset + prompt). Do not over-build it: a profile is `{ id, buildTools(), personaKey }`-ish, enough to make "bridget" a value rather than a hardcode. No profile registry UI this cycle.
- **`speak`** — replaces the `voice` boolean. Drives (a) whether the orchestrator synthesizes TTS and (b) the prompt mode (`buildSystemPrompt` selects spoken-brief/no-markdown vs. text/markdown-ok). This is the single convergence branch.

`buildSystemPrompt` becomes `buildSystemPrompt({ profile, speak, context })` (see §5).

### Orchestrator changes (`handleTurn`)
`handleTurn(userText, history, deps)` gains `speak: boolean` in `deps`:
- `speak === false` → never call `speak()`/TTS; emit `state: 'typing'` instead of `'speaking'`; pass `speak: false` into `runAgent`.
- `speak === true` → unchanged from today's voice behavior.
- Returns the updated `history` exactly as now. Persistence (§3) is layered at the WS handler around the turn, not inside `handleTurn`, to keep the orchestrator pure and unit-testable.

### WS protocol additions (`server/api/voice/ws.ts`)
Current control frames: `interrupt`, `voice`, `text`. Add:
- `{ type: 'text', text, speak?: boolean }` — typed turn; `speak` defaults to the connection's current mode.
- `{ type: 'load', conversationId }` — hydrate `ConnState.history` from the store (§3) and set the active conversation.
- `{ type: 'new' }` — clear `history` + active conversation; refresh the cached context block (§5).
- `{ type: 'mode', speak }` — set the connection default for `speak` ("respond in voice" toggle).

`ConnState` gains `conversationId: string | null` and `context: ContextBlock | null` (cached per connection, see §5). On the first user turn with no active conversation, lazily create one. After each completed turn, persist the user + assistant messages (+ tool events) and `publishChange` (§6).

## 2. Mic decoupling (essential for text-first UX)

Today `useVoice.start()` couples WS connect + `getUserMedia` + VAD + `AudioContext`. Typing must never trigger a mic-permission prompt, and text chat must work even when STT/TTS providers are down.

Split startup:
- **WS connect** is always available and mic-independent.
- **Mic input** (`getUserMedia` + VAD) initializes lazily, only when voice input is engaged.
- **Playback `AudioContext`** initializes only when `speak` is on (or on first inbound audio).

Result: a user can open `/agent`, type, and converse with zero mic/audio permissions. Voice input is opt-in; TTS output is the `speak` toggle. `sendText` already exists and already falls back to the SSE endpoint when the WS is closed — that fallback is removed once the WS is the always-on transport, since for the UI the WS is the only path.

## 3. Data model — modality-agnostic conversation store

New tables (a new migration), kept **separate** from `sessions`/`messages` (those model imported CC/Hermes transcripts and carry `externalUuid`/`parentUuid`/`isSidechain`/git/machine baggage that does not fit live chat).

### `conversations`
| column | type | notes |
|---|---|---|
| `id` | uuid PK | `gen_random_uuid()` |
| `title` | text, null | auto-derived from the first user turn (truncated); summarization deferred |
| `summary` | text, null | reserved for a future summarization worker |
| `project_id` | uuid, null | optional association (a conversation may be project-scoped); no FK churn beyond the existing pattern |
| `message_count` | int, default 0 | maintained on each persisted turn |
| `last_message_at` | timestamptz, null | drives history ordering |
| `summary_embedding` | halfvec(2560), null | **column reserved**; population deferred (keyword search ships first) |
| `created_at` / `updated_at` | timestamptz | conventions as elsewhere |

### `conversation_messages`
| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `conversation_id` | uuid, FK → `conversations.id` `ON DELETE CASCADE` | |
| `parent_id` | uuid, null, self-FK → `conversation_messages.id` | **branching-capable edge**; populated **linearly** (parent = prior turn). See "Branching" below. |
| `role` | text | `'user' \| 'assistant'` |
| `content` | text | |
| `modality` | text | `'voice' \| 'text'` — how this turn was conducted |
| `tool_calls` | jsonb, null | assistant tool events `[{ name, summary, undoToken? }]` so tool chips re-render on resume |
| `created_at` | timestamptz | |

Indexes: `conversation_messages (conversation_id, created_at)` for the read path; `conversations (last_message_at desc)` for the history list; trigram index supporting keyword search (§4).

### Branching (tree-capable schema, linear behavior)
The `parent_id` self-FK makes the message store a tree, but **Cycle A is strictly linear**: each new message's `parent_id` is the previous turn's id, reads are `ORDER BY created_at` (the no-branch subset of the tree). This mirrors the existing `messages.parentUuid` convention and makes future branching a **UI + fork-write** change rather than a migration.

**Deferred with the feature (NOT built now):** an `active_leaf_id` (or path materialization) on `conversations`, path-aware reads (walk active leaf → root), and the edit/regenerate fork UI. Building the active-leaf/path machinery now would add real complexity for a deferred feature; the column alone costs ~nothing and is the only concession this cycle makes.

## 4. `/agent` page + history

### `/agent` (renamed from `/voice`)
`/voice` redirects to `/agent`. Reuses the existing components: `Reactor.client.vue` (canvas), `Transcript.vue`, `Composer.vue`, `SettingsSlideover.vue`. Adds:
- **Canvas toggle** — off → transcript takes full width (clean chat); on → current voice/visualizer feel. Cookie-persisted.
- **"Respond in voice" toggle** — sets the connection `speak` default (sends `{type:'mode'}`); cookie-persisted via `useVoiceSettings`.
- **History slideover** — recent conversations (title, `last_message_at`, snippet); click → `{type:'load'}` hydrates the WS history and renders the transcript; a "New conversation" button → `{type:'new'}`.
- Transcript renders **markdown** for text-mode assistant turns, **plain** for spoken; tool chips + undo preserved (re-rendered from `tool_calls` on resume).

### `/agent/history`
A dedicated page listing + searching **all** past conversations. Cycle A: **keyword (trigram) search** over `title` + message `content`, consistent with other surfaces. The `summary_embedding` column is reserved so semantic search + a summarization worker can be a fast-follow. Command-palette integration is deferred.

## 5. Bridget personality

`buildSystemPrompt` composes, in order: **[editable base persona]** + **[modality rules from `speak`]** + **[time-of-day tone]** + **[live context block]**.

- **Rich base persona** — a genuinely opinionated rewrite of the current thin prompt: how she addresses Tony, initiative/proactivity, brevity, and — per Tony's stated preference — **pushes back directly when she disagrees rather than just agreeing**. This is the foundation; the enhancements layer on top.
- **Editable in `/settings`** — the base persona text is stored in the `settings` table under a new key `agent_persona`, edited in a new **`/settings → Bridget`** tab, cached + invalidated exactly like `ai_config` (`server/lib/ai/registry/store.ts` pattern). A sane default seeds on first load.
- **Context-aware (live state injection)** — inject current date/time + active projects + top open tasks (+ optionally a few relevant memories) into the prompt. **Assembled once per connection** (cached on `ConnState.context`, refreshed on `{type:'new'}`) to bound token/latency cost — not rebuilt every turn.
- **Time-of-day / mood** — a small tone modifier (morning / afternoon / evening / late-night) derived from the current time, using the `age-aware-system-prompts` pattern (skill available). Lightweight; one short appended block.

Modality rules (spoken-brief/no-markdown vs. text/markdown-ok) come from `speak`, so a typed turn answered in voice still gets the spoken rules — correct, because it will be heard.

## 6. Live reactivity, safety, failure modes

- **Live** — add `conversation` to the `ResourceName` union (`shared/types/live.ts`) + dispatch registry (`app/utils/live-dispatch.ts`); every writer calls `publishChange({ resource: 'conversation', action, id })` after commit; the slideover + `/agent/history` use `@tanstack/vue-query` per the `live-data` rule + `add-live-resource` skill. (Cross-tab: start a conversation on one device, see it in history on another.)
- **Resilience** — text mode never depends on STT/TTS: TTS runs only when `speak`, STT only for audio frames. A voice-provider outage degrades to text, not failure.
- **Auth** — WS upgrade already validates the session (`ws.ts` `upgrade`); conversations are single-user (whole app is).
- **Abort / barge-in / failover / undo / activity-log** — unchanged. `runAgent` start-only failover, undo tokens, and `withSpan` observability carry over as-is.

## 7. Testing

- **Unit** — orchestrator `speak: false` path (no `audio` events, emits `typing`, returns history unchanged in shape); conversation store CRUD + linear `parent_id` population + `tool_calls` round-trip; `buildSystemPrompt` composition (persona + modality + time-of-day + context, with `speak` toggling markdown rules).
- **E2E (`playwright-cli`, per the `browser-testing` skill)** — type a turn on `/agent` → it persists → appears in `/agent/history` → resume via the slideover loads the transcript (incl. tool chips) → canvas toggle hides/shows the Reactor → "respond in voice" produces audio. Gates: `pnpm typecheck` / `pnpm test` / `pnpm build` / `pnpm db:migrate`.

## Out of scope (Cycle A)

- Powerful capability tools (web research, shell, SSH, `gh`, file-editing/report-rendering) — **Cycle B**, separate security-first brainstorm.
- Conversation **summarization worker** + **semantic search** (column reserved, keyword ships first).
- Storing voice **audio blobs** (transcript text only).
- The branching **feature** (active-leaf/path-walking + edit/regenerate UI) — schema edge only.
- Command-palette integration, token-cost display, multi-profile UI, message editing/branching UI.

## Open follow-ons (tracked for later cycles)

- Cycle B: capability tools + execution-model/security design.
- Conversation summarization + semantic search (reuse the sessions summarization pattern).
- Branching UI (the schema is ready).
- Command-palette + `/agent/history` cross-surface search.
