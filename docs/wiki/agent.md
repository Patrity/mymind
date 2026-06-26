---
title: Agent Surface (/agent)
status: shipped
cycle: 37
updated: 2026-06-25
---

# Agent Surface (`/agent`)

One surface for talking **and** typing to Bridget. `/agent` (formerly `/voice`) is a single page where the Three.js visualizer is a toggle, conversations persist as resumable + searchable threads, and the same shared agent core powers every turn. This is the in-app "agent loop" — tool-scoped on the current 20-tool registry. Powerful capability tools (web research / shell / SSH / `gh` / file-edit) are part of the Cycle B series (B1/B2/B3 shipped).

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

## Tool registry (current — 20 tools)

| Tool | Kind | Notes |
|---|---|---|
| `search_memories` | read | Hybrid RRF search over memory store |
| `get_recent_memories` | read | Most recent memories, optional scope/project filter |
| `save_memory` | create | Confidence ≥ 0.75 auto-reviews |
| `search_docs` | read | Trigram + semantic RRF; optional project scope |
| `search_passages` | read | Per-chunk passage search (cycle 31) |
| `list_documents` | read | Optional project filter |
| `get_document` | read | Full content + frontmatter |
| `save_document` | create | Auto-files under `/projects/<slug>/` when project set |
| `search_projects` | read | Active + all |
| `get_project` | read | Full model + counts |
| `create_project` | create | |
| `edit_project` | destructive | |
| `search_tasks` | read | Status + project filter |
| `create_task` | create | |
| `edit_task` | destructive | |
| `quick_capture` | create | Drops note into `/input` |
| `web_search` | read | SearXNG / Brave; SSRF-guarded (cycle 29) |
| `web_fetch` | read | Markdown extraction; SSRF-guarded (cycle 29) |
| `generate_image` | create | ComfyUI + Qwen-Image; saves to gallery (cycle 36) |
| `edit_image` | create | ComfyUI img2img on an existing image; defaults to most-recent generated; result embedded by server (cycle 37) |

## Image generation (`generate_image`)

**Cycle 36.** Generates images from a text prompt using the local ComfyUI + Qwen-Image stack and saves the result directly into the gallery.

**Config:** lives in the `image_config` settings doc, edited at `/settings → Image Gen`. This is **not** the `ai_config` model registry — it holds the ComfyUI URL, workflow ID, default resolution/steps/cfg, the Qwen-Image model name, and (added cycle 37) `editStrength` (the default img2img denoise strength). No DB migration — the settings doc is created on first save.

**Persistence:** generated images skip the vision-enrich pass entirely. The prompt becomes both the `summary` and the embedding source; the image is tagged `['generated']`; `enrich_status` is set to `done` at creation time so the enrichment cron ignores it.

**Behavior:** synchronous (~1 min/image, 180 s hard cap, honors the abort signal). Parameters: `prompt`, `negative_prompt`, `width`, `height`, `steps`, `cfg`, `seed` (same seed → identical image), `n` (1–4 images, generated sequentially). If ComfyUI is unreachable or not configured, returns `{ ok: false, error }` — never throws.

**MCP:** auto-exposed via the standard `agentTools` loop in `server/lib/mcp/server.ts` (non-`dangerous` → always registered). No per-tool MCP wiring needed.

**Deferred:** live diffusion-preview WebSocket stream; REST `POST /api/images/generate` endpoint.

## Image editing (`edit_image`) — cycle 37

**Cycle 37.** Edits an existing image via ComfyUI img2img (same Qwen-Image model as `generate_image`). The tool takes a natural-language change description and re-rolls the image guided by the new prompt, producing a result image that is persisted into the gallery.

**Source resolution:** if `source_image_id` is omitted (the normal case), the server resolves the most recently generated/edited image from the gallery. The agent never has to track IDs explicitly.

**`strength` (denoise):** controls how far the result departs from the source (0 = identical; 1 = full re-generation). Default is `editStrength` from `image_config` (roughly 0.55). Lower values preserve more of the original composition; higher values allow more change. Configurable per-call or globally in `/settings → Image Gen`.

**Caveat — whole-image shift:** img2img re-rolls the **entire** image guided by the combined prompt, not a masked/targeted region. A prompt like "make the hat blue" may shift other areas of the image too. Phase 2 (paste-upload), Phase 3 (mask/inpaint), and Qwen-Image-Edit are deferred.

**Persistence:** edited images are tagged `['generated', 'edited']`; `enrich_status: done`; embedding source = the edit prompt. The `source_image_id` is stored on the row for lineage.

**Fails clean:** returns `{ ok:false, error }` when ComfyUI is unreachable, when no source image exists, or when the source row is missing — never throws.

## Reliable render (cycle 37 — supersedes cycle-36 approach)

**Problem:** in cycle 36, the model was asked to paste a markdown image link from the tool result. In practice the model would sometimes hallucinate the URL slightly (or the wrong path), making the inline image silently fail — and the embed depended on the model faithfully copying the URL out of the tool response.

**Fix (cycle 37):** the model **never receives an image URL**. The `generate_image` and `edit_image` tool handlers set a `display` sentinel on the result instead of returning a raw URL. The orchestrator (`server/lib/voice/orchestrator.ts`) intercepts this sentinel, looks up the real persisted gallery row by ID, and **authors the chat embed itself** as an `assistant` message containing the correct markdown image link. The model only receives `{ ok:true, id, summary }` — no URL.

**Effect:**
- A hallucinated image URL cannot render — the model has no URL to hallucinate.
- The embed is always derived from the real, persisted row.
- Even if the model writes a stray markdown link (impossible with the current prompt, but belt-and-suspenders), the orchestrator strips unrecognized image links from model output before appending them to the transcript.

This supersedes the cycle-36 "model pastes markdown" approach and closes the hallucination-render bug entirely.

## Deferred (not built this cycle)

- **Cycle B1 (shipped, cycle 29)** — `web_search` + `web_fetch` read-only web research tools on the default toolset; SSRF-guarded; SearXNG bundled (zero-config). See [web-research.md](web-research.md).
- **Cycle B2 (shipped, cycle 30)** — approval-gate harness + constrained `exec` tool (`powerful` profile opt-in, per-command Approve/Deny prompt, persisted allowlist, `setpriv` privilege drop, `/workspace` jail, stripped env). See [agent-exec.md](agent-exec.md).
- **Cycle B3.1/B3.2 (shipped, cycles 34/35)** — native LXC deploy (systemd) + credentialed self-installing native `exec` (root-in-LXC, always-on encrypted credential injection, allowlist-first gate). See [agent-exec.md](agent-exec.md). B3.3/B4 (artifact/report rendering, SSH to other homelab hosts) remain.
- Conversation **summarization worker** + **semantic search** (the `summary_embedding` column is reserved; keyword ships now).
- **Branching UI** (edit/regenerate → fork): the `parent_id` edge exists; `active_leaf_id`/path-walking + UI are future.
- Storing voice **audio** (transcript text only), command-palette integration, token-cost display, multi-profile UI.

See also: [voice-agent.md](voice-agent.md) (the self-hosted STT/TTS pipeline + visualizer), [ai-providers.md](ai-providers.md) (model registry), [live-reactivity.md](live-reactivity.md), [web-research.md](web-research.md) (`web_search` + `web_fetch` tools, SSRF guard, SearXNG), [agent-exec.md](agent-exec.md) (approval gate + constrained exec, Cycle B2).
