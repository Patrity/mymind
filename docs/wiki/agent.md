---
title: Agent Surface (/agent)
status: shipped
cycle: 42
updated: 2026-07-01
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

`runAgent(messages, ctx, deps)` where `ctx = { signal, speak?, profile?, context?, maxSteps? }`:
- `profile` (`server/lib/agent/profile.ts`) — `AgentProfile = { id, tools, personaKey }`. **ONE always-armed profile since cycle 42**: `bridgetProfile` = the full `agentTools` registry **+ `execTool` + the subagent tools** (`research_web`, `search_brain`). The old `powerful` profile and the `agent-exec-enabled` cookie/switch are gone — safety is the approval gate (dangerous tools pause for allowlist-or-approval; channels without an approval UI auto-deny).
- `speak` — replaces the old `voice` boolean; drives TTS + prompt mode.
- `context` — the per-turn context block: live state (projects + open tasks, rebuilt EVERY turn since cycle 42) **plus proactive memory injection** — `buildMemoryContext(userText)` (`server/lib/agent/context.ts`) retrieves the top-5 relevant memories for the user's message (relevance floor 0.2, 1.5s timeout, never throws) and injects them as a labeled background block. Wired at the WS boundary (`ws.ts` passes it into `handleTurn`); tests omit it.
- `maxSteps` — optional per-run override of the step cap (subagents pass their own budget).
- The system prompt is built **once** before the model loop; start-only failover + `recordEvent` observability are unchanged. `deps.buildSystemPrompt` is injectable so tests run without the DB.
- **Sampling + step budget (cycle 41):** `streamText` always sends `temperature` (`VOICE_TUNING.agent.temperature`, 0.7 — qwen3-recommended) so a greedy serving-stack default can't degenerate a small local model into copy-loops; `maxSteps` is 16 for every main-loop turn (single cap since cycle 42).
- **Known structural gap (cycle 43, task filed):** model history is `{role, content}` **text only** — the model never sees its own prior tool calls/results across turns (`getAgentHistory` drops them). Cross-turn it can't know it already searched; the fix is persisting tool calls with args+results and feeding them back as structured tool messages. See handover 2026-07-01.

## Subagents (cycle 42)

`server/lib/agent/subagents.ts` — fixed specialist subagents exposed to the main agent as ordinary tools. Each runs a **nested `runAgent`** with a narrow tool subset, its own steering system prompt (replaces the Bridget persona), and its own step budget, and returns a compact digest — multi-step digging happens off the main conversation's context.

| Tool | Toolset | Budget | Returns |
|---|---|---|---|
| `research_web` | `web_search`, `web_fetch` | 10 steps | digest ≤~350 words + source URLs (multi-angle queries, reads 2–3 sources, reports degraded backend honestly) |
| `search_brain` | memories/docs/passages/projects/tasks read tools | 8 steps | digest with paths/citations, including what was NOT found |

Design invariants: **not** a generic spawner (fixed types keep a small orchestrator model from compounding planning errors); no subagent's toolset contains subagent tools (recursion impossible by construction); subagents live on the **profile**, not `agentTools`, so MCP never sees them; `makeSubagentTool` dynamic-imports `run.ts` (breaks the run→profile→subagents cycle); the prompt tells the orchestrator the subagents **cannot see the conversation** — pass facts via `context`.

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

`app/pages/agent/index.vue` (and `app/pages/agent/history.vue`). `/voice` redirects to `/agent` (routeRules). The WS **auto-connects on mount** (no mic) so the chat is usable immediately — **there is no Connect button**; just type and send. Controls: **Visualizer** toggle (cookie `agent-canvas`), **Respond in voice** toggle (cookie `agent-speak` → per-message `speak`), **Enable microphone** (`enableMic()`/`disableMic()` — lazy VAD; the only voice affordance, auto-connects if needed), **New**, **History** slideover (`app/components/agent/HistorySlideover.vue`), and the composer. Assistant replies render **markdown** via the shared `<MdView>` (MDC) renderer; user turns are literal text. Streamed text deltas are appended raw (they already carry their own spacing).

**Transcript rendering invariants (cycle 41):**
- Every `TranscriptEntry` has a stable unique `id` (uuid at stream time; DB message id on resume) which keys BOTH the `v-for` and the MDC parse cache (`<MdView :cache-key>`). **This is load-bearing**: `<MDC>` keys its `useAsyncData` on `hash(value)` frozen at setup — for streamed text that's the hash of the *first delta*, so two replies opening with the same token would otherwise share one asyncData record and render each other's content (live incident: three distinct replies all displayed as the first one).
- **Tool chips render inline** at their true stream position: the orchestrator's WS `{type:'tool'}` events map to `role:'tool'` transcript entries (with undo), naturally splitting assistant text into before/after-tool bubbles. On resume, chips rebuild from the persisted `tool_calls` and render before their reply (exact position isn't stored). The old bottom-of-transcript chips block (fed by the global `/api/agent/activity` SSE) is gone; that SSE + `useAgentActivity` are currently unconsumed. Resume: `getConversation(id)` → set transcript → `loadConversation(id)`; `/agent?c=<id>` deep-links from the history page. The client transport (`app/composables/useVoice.ts`) decouples the WS from the mic so typing never prompts for a microphone and text chat survives an STT/TTS outage. `connect()` resolves only once the socket is OPEN, and `sendText`/`loadConversation` auto-connect transparently, so a typed send never races the handshake. Reads use `@tanstack/vue-query` (`useConversations`); the `conversation` live-resource refreshes lists across tabs.

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
| `web_search` | read | SearXNG / Brave; SSRF-guarded (cycle 29). Returns `{results, warning?}` — `warning` set when results are empty AND engines are down (rate-limit/CAPTCHA), so the model reports a backend outage instead of "no results" (cycle 41). SearXNG config (`searxng/settings.yml`): bing/mojeek/qwant enabled + fast engine-suspension recovery (60–300s, defaults were 1h–24h) |
| `web_fetch` | read | Markdown extraction; SSRF-guarded (cycle 29) |
| `generate_image` | create | ComfyUI + Qwen-Image; saves to gallery (cycle 36) |
| `edit_image` | create | Qwen-Image-Edit-2509 instruction editing on an existing image; defaults to most-recent generated; result embedded by server (cycles 37–38) |

## Image generation (`generate_image`)

**Cycle 36.** Generates images from a text prompt using the local ComfyUI + Qwen-Image stack and saves the result directly into the gallery.

**Config:** lives in the `image_config` settings doc, edited at `/settings → Image Gen`. This is **not** the `ai_config` model registry — it holds the ComfyUI URL, workflow ID, default resolution/steps/cfg, the Qwen-Image model name, and (added cycle 38) the Qwen-Image-Edit-2509 model name + edit graph IDs. No DB migration — the settings doc is created on first save. (`editStrength` was removed in cycle 38 when img2img was replaced.)

**Persistence:** generated images skip the vision-enrich pass entirely. The prompt becomes both the `summary` and the embedding source; the image is tagged `['generated']`; `enrich_status` is set to `done` at creation time so the enrichment cron ignores it.

**Behavior:** synchronous (~1 min/image, 180 s hard cap, honors the abort signal). Parameters: `prompt`, `negative_prompt`, `width`, `height`, `steps`, `cfg`, `seed` (same seed → identical image), `n` (1–4 images, generated sequentially). If ComfyUI is unreachable or not configured, returns `{ ok: false, error }` — never throws.

**MCP:** auto-exposed via the standard `agentTools` loop in `server/lib/mcp/server.ts` (non-`dangerous` → always registered). No per-tool MCP wiring needed.

**Deferred:** live diffusion-preview WebSocket stream; REST `POST /api/images/generate` endpoint.

## Image editing (`edit_image`) — cycles 37–38

**Cycle 38 (supersedes cycle-37 img2img).** Edits an existing image using **Qwen-Image-Edit-2509** — an instruction-tuned diffusion model. The tool takes a natural-language instruction describing the *change* ("change the hat to a blue cowboy hat") and edits the named region while preserving the rest of the image. This is fundamentally different from img2img re-roll: the model reuses the encoder/VAE of the source and targets only the described part.

**img2img + editStrength removed (cycle 38):** the old img2img denoise-strength approach and the `strength`/`editStrength` parameter are gone. Do not reference them — they no longer exist in code or config.

**Source resolution:** if `source_image_id` is omitted (the normal case), the server resolves the most recently generated/edited image from the gallery. The agent never has to track IDs explicitly.

**Speed:** a **fast merged 4-step path** is the default (~14 s). Pass `quality: true` to use a 20-step unmerged path (slower, sharper). The graph automatically selects the sampler/scheduler and step count based on this flag.

**Resolution:** `FluxKontextImageScale` auto-selects the resolution from the source image — no manual width/height needed.

**Instruction prompt:** phrase as a targeted edit, e.g. "change the hat to a blue cowboy hat", "make the background a sunset", "add sunglasses". The model preserves the unmentioned parts of the image; a good instruction targets one clearly described change.

**Persistence:** edited images are tagged `['generated', 'edited']`; `enrich_status: done`; embedding source = the instruction prompt. The `source_image_id` is stored on the row for lineage.

**Fails clean:** returns `{ ok:false, error }` when ComfyUI is unreachable, when no source image exists, or when the source row is missing — never throws.

## Reliable render (cycle 37 — supersedes cycle-36 approach)

**Problem:** in cycle 36, the model was asked to paste a markdown image link from the tool result. In practice the model would sometimes hallucinate the URL slightly (or the wrong path), making the inline image silently fail — and the embed depended on the model faithfully copying the URL out of the tool response.

**Fix (cycle 37):** the model **never receives an image URL**. The `generate_image` and `edit_image` tool handlers set a `display` sentinel on the result instead of returning a raw URL. The orchestrator (`server/lib/voice/orchestrator.ts`) intercepts this sentinel, looks up the real persisted gallery row by ID, and **authors the chat embed itself** as an `assistant` message containing the correct markdown image link. The model only receives `{ ok:true, id, summary }` — no URL.

**Effect:**
- A hallucinated image URL cannot render — the model has no URL to hallucinate.
- The embed is always derived from the real, persisted row.
- Even if the model writes a stray markdown link (impossible with the current prompt, but belt-and-suspenders), the orchestrator strips unrecognized image links from model output before appending them to the transcript.

This supersedes the cycle-36 "model pastes markdown" approach and closes the hallucination-render bug entirely.

## Multimodal attachments (cycle 39)

Attach **images and files** to a turn (paste / drag-drop / file-picker in the composer, mirroring the clipboard input). The reasoning model (**Qwen3.6-35B-A3B**, a native VLM) sees the attachment as a message **content part** and decides from the prompt: reason over it ("what's in this?", "summarize this PDF") or call a tool (e.g. `edit_image` on an attached photo). No separate vision model, no `analyze_image` tool, no per-turn routing.

**The serving-stack constraint (why files become images):** vLLM's OpenAI API forwards only `image_url`/`video_url`/`audio_url` content parts — **there is no generic file/document part**. So everything the model receives is a **text part or an image part**:

| Attachment | What the model gets |
|---|---|
| image | a native image part (bytes inline as a base64 data-URL) |
| PDF | rendered to page images (`pdf-to-img` + `sharp`→webp, **first 8 pages, ≤1600px**) → one image part per page — the VLM *sees* the document |
| text-like file (`text/*`, json, xml, csv) | decoded UTF-8 → a text part |
| other binary (docx, xlsx, …) | rejected at the composer (deferred) |

`AgentMessage.content` is `string | AgentContentPart[]` where `AgentContentPart = {type:'text'} | {type:'image'}` (no file part). `messageText()` flattens parts for display/persistence; `toModelContent()` maps to the AI SDK `streamText` shape and applies the cycle-37 URL redaction to **text parts only**.

**Pipeline:** composer uploads each attachment over HTTP (images → `POST /api/upload`; files → `POST /api/agent/files`, raw blob in the new `agent_files` table) → the WS `text` frame carries `attachments: AttachmentRef[]` (`{id, kind:'image'|'file', mime, name?}`) → `handleTurn` reads the bytes server-side and builds the multimodal message via `buildUserMessageParts` (`server/lib/agent/attachments.ts`; PDFs go through `server/lib/agent/pdf-render.ts`) → the turn's **image** attachment ids ride `ToolContext.attachmentImageIds`.

**Edit-from-attachment:** `edit_image` defaults its source to the turn's attachment image (`resolveSourceImageId(explicitId, { preferIds: ctx.attachmentImageIds })`) before the newest-generated fallback — so "make the sky purple" on an attached photo edits that photo.

**Bytes, never URLs:** attachment images + rendered PDF pages are inline base64 — the self-hosted model behind LiteLLM can't fetch the auth-gated `/api/...` URLs. This is consistent with the cycle-37 reliable-render invariant; user *attachments* are a separate INPUT path from server-authored *generated*-image output.

**Persistence + render:** the user message persists its `attachments` (`conversation_messages.attachments` jsonb); `getConversation` returns them in the DTO; the transcript renders image thumbnails (`/api/images/<id>/raw`) and file download chips (`/api/agent/files/<id>`) on the user turn — live and on reload. `getAgentHistory` (the model's history) stays text-only: **v1 sends attachment content only for the current turn** (multi-turn image memory is deferred).

## Deferred (not built this cycle)

- **Cycle B1 (shipped, cycle 29)** — `web_search` + `web_fetch` read-only web research tools on the default toolset; SSRF-guarded; SearXNG bundled (zero-config). See [web-research.md](web-research.md).
- **Cycle B2 (shipped, cycle 30)** — approval-gate harness + constrained `exec` tool (`powerful` profile opt-in, per-command Approve/Deny prompt, persisted allowlist, `setpriv` privilege drop, `/workspace` jail, stripped env). See [agent-exec.md](agent-exec.md).
- **Cycle B3.1/B3.2 (shipped, cycles 34/35)** — native LXC deploy (systemd) + credentialed self-installing native `exec` (root-in-LXC, always-on encrypted credential injection, allowlist-first gate). See [agent-exec.md](agent-exec.md). B3.3/B4 (artifact/report rendering, SSH to other homelab hosts) remain.
- Conversation **summarization worker** + **semantic search** (the `summary_embedding` column is reserved; keyword ships now).
- **Branching UI** (edit/regenerate → fork): the `parent_id` edge exists; `active_leaf_id`/path-walking + UI are future.
- Storing voice **audio** (transcript text only), command-palette integration, token-cost display, multi-profile UI.

See also: [voice-agent.md](voice-agent.md) (the self-hosted STT/TTS pipeline + visualizer), [ai-providers.md](ai-providers.md) (model registry), [live-reactivity.md](live-reactivity.md), [web-research.md](web-research.md) (`web_search` + `web_fetch` tools, SSRF guard, SearXNG), [agent-exec.md](agent-exec.md) (approval gate + constrained exec, Cycle B2).
