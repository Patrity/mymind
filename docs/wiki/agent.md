---
title: Agent Surface (/agent)
status: shipped
cycle: 60
updated: 2026-08-29
mymind_id: b780bc2c-df0e-465f-acc0-ed83da00da0f
mymind_hash: 6f456b25c7802e23ab05add8f8ce481876c4f7d516395c47b2da0ae2980d1074
---

# Agent Surface (`/agent`)

One surface for talking **and** typing to Bridget. `/agent` (formerly `/voice`) is a single page laid out as **three columns** — threads / conversation / Bridget — where conversations persist as resumable + searchable threads and the same shared agent core powers every turn. (Before cycle 60 it was a 75%-canvas / 25%-transcript split with the visualizer on a toggle; both the toggle and its `agent-canvas` cookie are gone.) This is the in-app "agent loop" — tool-scoped on the current 20-tool registry. Powerful capability tools (web research / shell / SSH / `gh` / file-edit) are part of the Cycle B series (B1/B2/B3 shipped).

## The convergence principle (one flow, one branch)

Voice and text run through the **same** path: client WebSocket → `server/lib/voice/orchestrator.ts` (`handleTurn`/`handleUtterance`) → `runAgent` (`server/lib/agent/run.ts`). There is **no second agent code path for the UI**. A turn varies only by independent flags:

| Flag | Effect |
|---|---|
| input: mic / typed | how the turn arrives — VAD→WAV utterance vs. a `{type:'text'}` frame |
| `speak`: on / off | **the sole voice/text branch** — gates TTS *and* selects prompt mode (spoken-brief/no-markdown vs. text/markdown-ok). Default: on for mic, off for typed unless "Respond in voice" is on |
| ~~canvas: on / off~~ | **removed in cycle 60.** Bridget is a permanent column, not a toggle; the `agent-canvas` cookie no longer exists. Her face still reacts to `typing` on text turns. |

The SSE `POST /api/agent/chat` still exists but is **headless/programmatic only** (cron, scripts) — the page does not use it.

## Entry point (`runAgent`)

`runAgent(messages, ctx, deps)` where `ctx = { signal, speak?, profile?, context?, maxSteps?, modelDefId? }`:
- `profile` (`server/lib/agent/profile.ts`) — `AgentProfile = { id, tools, personaKey }`. **ONE always-armed profile since cycle 42**: `bridgetProfile` = the full `agentTools` registry **+ `execTool` + the subagent tools** (`research_web`, `search_brain`). The old `powerful` profile and the `agent-exec-enabled` cookie/switch are gone — safety is the approval gate (dangerous tools pause for allowlist-or-approval; channels without an approval UI auto-deny).
- `speak` — replaces the old `voice` boolean; drives TTS + prompt mode.
- `context` — the per-turn context block: live state (projects + open tasks, rebuilt EVERY turn since cycle 42) **plus proactive memory injection** — `buildMemoryContext(userText)` (`server/lib/agent/context.ts`) retrieves the top-5 relevant memories for the user's message (relevance floor 0.2, 1.5s timeout, never throws) and injects them as a labeled background block. Wired at the WS boundary (`ws.ts` passes it into `handleTurn`); tests omit it.
- `maxSteps` — optional per-run override of the step cap (subagents pass their own budget).
- The system prompt is built **once** before the model loop; start-only failover + `recordEvent` observability are unchanged. `deps.buildSystemPrompt` is injectable so tests run without the DB.
- **Sampling + step budget (cycle 41):** `streamText` always sends `temperature` (`VOICE_TUNING.agent.temperature`, 0.7 — qwen3-recommended) so a greedy serving-stack default can't degenerate a small local model into copy-loops; `maxSteps` is 16 for every main-loop turn (single cap since cycle 42).
- **Final-answer guarantee (two layers):** a turn must never end with tool calls and no reply. (1) `prepareStep` forces the **last allowed** step (`stepNumber ≥ maxSteps-1`) to `toolChoice:'none'`, covering the "burned all steps" case. (2) After the stream drains, if tools ran but **no text-delta was emitted** (a reasoning model can voluntarily stop after a tool call, emitting only reasoning/tool calls — the step guard never fires because it quit early), `runAgent` re-runs **once** with `toolChoice:'none'`, feeding back `(await result.response).messages` (the tool results), to force a spoken answer. Recorded as `reasoning:agent-forced-final` in the activity log (`warn` if even that yields no text). Without layer 2, the turn persisted only the user message and silently dropped the tool calls (`orchestrator.ts` returns history without an assistant turn when `assistantText===''`), leaving the question unanswered **and** poisoning the next turn's history. Live failure that motivated it: a typed "What'd we work on yesterday?" ran `search_docs` + `list_documents` then went silent.

> **Tool-call-as-text recovery (cycle 49):** if the model streams a `<tool_call>`/`<function=` marker as text with no real tool-call (vLLM streaming hermes bug, [vllm#31871](https://github.com/vllm-project/vllm/issues/31871)), `run.ts` re-runs once with tools allowed + a corrective nudge (`reasoning:agent-recovered-textcall`), distinct from the no-text `reasoning:agent-forced-final` path.
- **Tool history across turns (cycle 43):** the model sees its own prior tool calls and results, not just the prose it produced afterward — closing the gap where `getAgentHistory` and live in-connection history dropped everything but `role`+`content`. See [Tool history](#tool-history-cycle-43) below.

## Tool history (cycle 43)

The model sees its own prior tool calls and results across turns — not just the prose it produced afterward. Before this, the blindness sat at **two** seams: **live**, where `handleTurn` (`server/lib/voice/orchestrator.ts`) flattened tool events into plain assistant text and discarded them; and **resume**, where `getAgentHistory` selected `role`+`content` only. Both close through **one** call site, so the two paths cannot diverge.

**Capture.** `buildAiTools`' `execute` (`server/lib/agent/ai-tools.ts`) threads the AI SDK's `toolCallId` and the tool's `kind` through every emit path — success, approval denial, and a thrown handler — into a `tool-result` `AgentEvent` carrying `callId`, `args`, `result`, `kind`. A denied tool's `{ denied: true }` and a thrown handler's `{ error }` are captured exactly like a success; that is what stops the agent re-proposing a refused command on the next turn. **The emitted/recorded `args` are the `redactForLog` copy**, computed once at the top of `execute` and used at every emit site (and for the observability span) — `exec`'s command can contain literal secret values, and these args are persisted and shipped to the browser. The handler still receives the original unmasked input; a throwing `redactForLog` degrades to a body-free marker rather than failing the tool.

**Records.** `orchestrator.ts` collects these into `AgentToolRecord[]` (`server/lib/agent/tool-history.ts`) on the assistant turn, each tagged with `textOffset` — the ordering fix. `AgentMessage` gains one optional field on its assistant arm (`toolRecords?: AgentToolRecord[]`) — no new `tool` role. **`textOffset` indexes the PERSISTED text, not the raw stream**: the assistant turn is always run through `applyImageEmbeds` before it is stored (it trims and collapses whitespace even when no image was produced), so the offset is recorded as `sanitizedOffset(textSoFar)` (`server/lib/agent/image-embed.ts`) — the same strip/collapse chain with only the start trimmed. Recording a raw `assistantText.length` used to split a resumed bubble mid-word.

**Persistence.** Records ride `conversation_messages.tool_calls` (jsonb, untyped — additive, no migration). `ws.ts` persists them straight from the message that owns them. Legacy rows (`{ name, summary, undoToken }`, no `callId`) degrade to **shape-only**: the resume chip still renders, but the record contributes nothing to model history — no backfill, no crash.

**Decay policy (`applyHistoryPolicy`).** Walking the conversation newest-to-oldest and counting only tool-*bearing* assistant turns (plain chat turns never consume the window):
- **The call always survives, for the life of the conversation** — `callId` + `name`, the anti-fabrication signal.
- The **last 3** tool-bearing turns keep their **payloads**, capped: `read` results at 1500 chars on replay (8192 at write, so the replay cap can be retuned with no backfill); `create`/`destructive` results are kept whole (mostly body-free receipts since cycle 52 — `exec` is the outlier, returning full stdout/stderr, and is bounded by the 8192-char write cap alone); **`args` at 1024 chars on replay, 4096 at write**.
- Older turns: **both** payloads are replaced with `{ elided: true, bytes: n }` — never the call.
- **Why args are capped too:** they are not cheap. The write tools take unbounded strings (`save_document`/`update_document`/`sync_document` `content`, `edit_document` `old_string`/`new_string`, `create_skill` `body`), and this is a document manager. Uncapped, a 60 KB body was persisted and replayed on *every* later turn with no way to decay — context overflow, conversation unusable. A truncated args object becomes `{ truncated, bytes, preview }`, which is still valid as a tool-call `input` (the AI SDK types it `unknown`).
- A malformed record (bad jsonb, or an unvalidated `messages` array posted to `/api/agent/chat`) passes through untouched rather than throwing; `toolBlocksFor` then drops it for having no `callId`.

**Replay (`buildModelMessages`, `server/lib/agent/run.ts`) — the single call site.** `runAgent` runs `applyHistoryPolicy` then `toolBlocksFor` immediately before the model call, so live and resumed history physically cannot skip the policy or drift apart. `toolBlocksFor` expands each assistant turn's records, grouped by `textOffset`, into an `assistant`(tool-call parts) → `tool`(tool-result parts) pair per distinct offset, followed by one final `assistant` message carrying the text — a turn with N distinct offsets produces 2N+1 messages. Calls sharing one offset (parallel calls in a single step) group into a single pair; calls at different offsets emit successive pairs, so a multi-step turn (call → text → call → text) replays in step order. **The pairing invariant holds even for an elided result** — an elided result still emits its paired `tool` message, because providers reject an unpaired `toolCallId`; a legacy record with no `callId` emits nothing at all rather than an unpaired half.

**Attachments on resume.** `getAgentHistory` rehydrates image/file bytes for the same 3-turn window via `hydrateAttachments` (`server/services/conversations.ts`), using the same `getImageBytes`/`getFileBytes` readers the live path uses. Turns outside the window degrade to plain text with **no placeholder** — a marker is exactly the artifact cycle 39 removed; reintroducing one here would reopen the imitation bug in a new location. A failed read for a turn *inside* the window has its `[attachment unavailable...]` note stripped before the message re-enters history (`stripUnavailableMarkers`), so a durably-missing blob can't inject a repeating marker into replayed model history on every resume.

**UI: inline chip ordering on resume.** `buildResumeTranscript` (`app/lib/agent/transcript.ts`, called by `resume()` in `app/pages/agent/index.vue`) splits a resumed assistant message's `content` at each tool call's `textOffset`, interleaving text → chip → text bubbles — the same order the live path already streams in. A message is only split when **every** tool call on it carries a `textOffset` (all-or-nothing); a message with any offset-less record, or any legacy row, falls back to the old chips-first render. A chip at the very end of a message (no trailing commentary) does not leave a floating empty reply bubble, but the trailing entry still carries `reasoning`/`attachments` when the message has them.

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
- **`conversation_messages`**: `id`, `conversation_id` (FK `ON DELETE CASCADE`), `parent_id` (nullable — **tree-capable edge, populated linearly** = parent is the prior turn; branching UI is deferred), `role`, `content`, `modality` (`voice`|`text`), `tool_calls jsonb` (assistant `AgentToolRecord[]` — see [Tool history](#tool-history-cycle-43)), `reasoning text` (nullable — assistant "thinking"; **display/storage only, never re-sent to the model**; migration 0026, cycle 45), `attachments jsonb` (cycle 39), `usage jsonb` (nullable, additive — **migration 0038**, cycle 60: `{inputTokens?, outputTokens?, totalTokens?}` for the assistant turn; no backfill, so a message without it omits the count rather than showing 0), `created_at`. Indexes: `(conversation_id, created_at)`, gin-trigram on `content`.

Store service: `server/services/conversations.ts` — `createConversation` / `appendMessages` (linear `parent_id` chain; persists `reasoning` on assistant rows) / `getConversation` (DTO includes `reasoning`, for UI hydration) / `getAgentHistory` (**role+content only** — reasoning is deliberately excluded, for WS model-history hydration) / `listConversations({q})` (keyword: title ILIKE OR a message content ILIKE; newest first, limit 50) / `deleteConversation` / `deriveTitle`. The two reads are differentiated on purpose: reasoning is hydrated into the *UI* but never into the *model's* context.

## WebSocket protocol (`server/api/voice/ws.ts`)

Per-connection `ConnState` adds `conversationId` + `context`. Frames (client→server):
- binary WAV — a spoken utterance (`speak=true`, modality `voice`)
- `{type:'text', text, speak?}` — typed turn (`speak` default false → modality `text`, reply is `typing`)
- `{type:'interrupt'}` — barge-in / abort
- `{type:'voice', voice}` — set the TTS voice
- `{type:'model', modelDefId}` — **ephemeral reasoning-model override** (cycle 45): sets `ConnState.model`, applied to every subsequent turn; `null` clears it. Never writes `ai_config`.
- `{type:'load', conversationId}` — hydrate history from the store (errors surface as an `error` frame)
- `{type:'new'}` — reset history + conversation + context

Server→client adds, alongside `transcript`/`tool`/`state`/`error`:
- `{type:'reasoning', text}` (cycle 45) — reasoning deltas, never audio.
- `{type:'usage', inputTokens?, outputTokens?, totalTokens?}` (cycle 60) — per-turn token usage, emitted once. Metadata only: it never touches `assistantText`, the transcript events, or the TTS chunker.
- `{type:'conversation', conversationId, title}` (cycle 60) — emitted **once**, when the first turn lazily creates the thread, so the client can learn the id and derived title without a reload.

After each completed turn the handler lazily creates the conversation (first turn) and appends the new user+assistant messages (with per-message modality + collected `tool_calls` + accumulated `reasoning` + `usage`), then `publishChange({resource:'conversation', action})`. Live context is assembled **once per connection** (cached on `ConnState`, rebuilt on `new`).

**The persist payload is a seam, not a closure (cycle 60).** `defineWebSocketHandler` needs a real crossws upgrade to exercise, so anything built inline in `run()` is untestable. `buildTurnPersistPayload` (`server/lib/voice/turn-persist.ts`) is the pure function that turns a turn's added `AgentMessage[]` into the `appendMessages` payload, and `ws.ts` calls it. **Known residual gap, accepted:** breaking `usage: turnUsage` at the `ws.ts` *call site* still leaves the suite green — closing it needs a crossws harness that exists for no part of `ws.ts` today. Inside the extracted function the wiring is red/green-verified.

**Where usage comes from.** `run.ts` reads the AI SDK's `finish` stream part (`totalUsage ?? usage`, defensively — the SDK has renamed that field before) and yields a `{type:'usage'}` `AgentEvent`; `orchestrator.ts` re-emits it as a `VoiceEvent`; `ws.ts`'s `emit` closure — the same seam that collects `tool_calls` and `reasoning` — **overwrites** (never accumulates) it and persists it on the assistant row. Overwrite is deliberate: the forced-final recovery path runs a second `streamText` call whose usage supersedes rather than adds to the first. **`includeUsage: true` on `createOpenAICompatible` (`server/lib/ai/registry/resolve.ts`) is what makes any of it non-null** — without it the upstream never returns per-turn usage and the whole chain is inert. That resolver is shared, so the flag was verified on **both** reasoning providers (self-hosted vLLM and Claude-via-LiteLLM) with `activity_log` showing `attempt:0` for each — explicitly ruling out the "failover masked a broken primary" pattern this repo has been bitten by. `createOpenAICompatible` appears exactly once; bulk/vision/embeddings/stt/tts/rerank all use raw-fetch adapters and are untouched.

## Reasoning block + on-the-fly model selector (cycle 45)

Two additions to the `/agent` surface, both riding the WS pipeline only.

**Reasoning "Thinking" block.** The reasoning models emit `reasoning_content` (a `<think>` block) as a channel separate from the answer. `@ai-sdk/openai-compatible` parses it into `reasoning-delta` stream parts, which `runAgent` was dropping. Now:
- `run.ts` yields a `{type:'reasoning-delta', text}` `AgentEvent` (read defensively as `part.delta ?? part.text`).
- `orchestrator.ts` emits a `{type:'reasoning', text}` `VoiceEvent` — **never chunked/spoken and never merged into `assistantText`**, so voice turns don't read the thinking aloud and it never enters the model's history.
- `ws.ts` accumulates the reasoning in its `emit` closure (the same seam that collects `tool_calls`) and persists it on the assistant row (`conversation_messages.reasoning`).
- The client (`messages.ts` → `useVoice.pushReasoning`) attaches it to the current assistant `TranscriptEntry.reasoning`; `app/components/agent/ReasoningBlock.vue` renders it as a collapsible **Thinking** `<details>` above the answer (muted `whitespace-pre-wrap` text — not MDC). It **auto-opens while thinking and collapses when the answer starts**, but a manual toggle wins after that. On resume, `getConversation` returns `reasoning` and the page hydrates it, so the block persists across reloads.
  > **Fixed 2026-08-28 (`ce8f990`) — this never actually auto-collapsed on a live turn.** `<details>` fires its `toggle` event for *programmatic* open/close as well as a real click, and the component used to treat any `toggle` as "the user took control." On a live turn, reasoning arrives before any answer text, so the block mounts with `:open="true"` — Vue setting that attribute itself fires `toggle` — which immediately (and wrongly) marked the block as user-touched, permanently defeating the collapse-on-answer watcher. Resumed threads looked correct only by accident: `hasAnswer` is already `true` there, so `open` starts `false`, Vue never sets the attribute, and no `toggle` fires. User intent is now read from a `click` on the `<summary>` (keyboard activation dispatches one too); the `toggle` handler only syncs `open` to the DOM's actual state and carries no intent.

**On-the-fly reasoning-model override.** A navbar `USelectMenu` (`app/pages/agent/index.vue`) lists the models assigned to the `reasoning` usage (from `useAiConfig`) plus a **"Default (chain order)"** entry. Picking one:
- writes the cookie `agent-model` (`''` = default) and sends `{type:'model', modelDefId}` over the WS; the pick is **resent on every WS (re)open** (like the voice pick), so it survives reconnects;
- server-side, `reasoningModels(modelDefId)` calls the pure `reorderChain` (`server/lib/ai/registry/resolve.ts`) to move the chosen model to the **front** of the resolved chain — **the rest stay as failover**; an unknown/`null`/`undefined` id is a no-op (falls back to the configured order).
- The override is **ephemeral and connection-level** — it lives in `ConnState.model` + the cookie and **never mutates `ai_config`**. Subagents do **not** inherit it (they run the default reasoning chain — a deliberate scope boundary).
- reka-ui gotcha: `USelectMenu`/`ComboboxItem` **rejects an empty-string item value**, so the "Default" option uses a non-empty sentinel (`'__default__'`) mapped back to `''`/`null`. (Caught in browser E2E; typecheck/build/review all passed the empty-string version.)

## Personality (Bridget)

`buildSystemPrompt({profile, speak, context})` (`server/lib/agent/prompt.ts`) composes: **[editable persona]** + **[time-of-day tone]** + **[modality rules from `speak`]** + **[live context]**.
- **Editable** — persona text in the `settings` table under key `agent_persona` (`server/lib/agent/persona.ts`, cached like `ai_config`; `DEFAULT_PERSONA` seed). Edited in-app at **`/settings/bridget`** (`GET`/`PUT /api/settings/persona`).
- **Time-of-day** — `timeOfDayTone(now)` (morning/afternoon/evening/late-night). (Verified live: an evening turn replied "Evening, Tony!".)
- **Context-aware** — `buildLiveContext(now)` injects active projects + open tasks (assembled once per connection to bound cost).
`composePrompt` + `timeOfDayTone` are pure + unit-tested; the DB-backed loaders are E2E-validated.

> **Honesty invariant (cycle 49):** the prompt forbids reporting any mutation (create/edit/delete/move/rename/fix) as done without a tool result THIS turn, and forbids asserting unverified facts about data (schemas, references, "it's safe"). Motivated by prod conversation `054f2560`, where the agent said "Done" twice with zero tool calls.

> **Environment self-model (cycle 49):** the prompt tells the agent it runs as native systemd `mymind` (root) in LXC 114, that its DB is the Docker container `mymind-db` (not sqlite, not host `db`), and that its own source/docs at `/opt/mymind` are readable via `exec`.

> **Skills (cycle 49 Phase 2):** the system prompt now carries only a Tier-1 **index** of skill names + descriptions; the detail lives in skill documents loaded on demand via `use_skill`. The long web-research guidance moved into the `web-research-etiquette` skill, so the base prompt is smaller than before. See [agent-skills.md](./agent-skills.md).

## UI — the three-column surface (cycle 60)

`app/pages/agent/index.vue` (plus `app/pages/agent/history.vue`). `/voice` redirects to `/agent` (routeRules). The WS **auto-connects on mount** (no mic) so the chat is usable immediately — **there is no Connect button**; just type and send.

Cycle 60 replaced the two-panel canvas/transcript split with three `UDashboardPanel`s:

| Panel | Sizing | Contents |
|---|---|---|
| `agent-threads` | `resizable`, default 14 %, min 10 / max 24; `hidden lg:flex` | `AgentThreadRail` — New button, search, threads grouped Today / Yesterday / date |
| `agent-conversation` | `resizable`, default 58 %, min 35 / max 80; **`grow`** | `AgentToolbar` header, `VoiceTranscript`, the approval prompt, `VoiceComposer` |
| `agent-bridget` | fluid; `grow-[9999] min-w-[240px] max-w-[420px]`; `hidden lg:flex` | `AgentAvatar` + `AgentMicBand` |

**Why Bridget is the fluid panel.** Nuxt UI's resize handle only supports a sized panel to its *left*, so with three panels the conversation must be the sized one and her column takes the remainder; a CSS `max-width` stops her ballooning on an ultrawide. The conversation panel carries `grow` because a *capped* flex item freezes and leaves the surplus as dead space at the right edge (measured: 196 px at 2560, ~80 px at 1440 once the second handle is dragged left). Her grow factor is far larger, so she still takes the space first and the conversation only collects what her cap refuses.

**Responsive — this is the sub-1024 px fix.** The `hidden lg:flex` that used to sit on the **conversation** panel is gone. That one class was why the composer measured `0×0` with `display:none` below 1024 px — the page had no chat at all on a narrow laptop, tablet or phone. Both *side* panels carry it now instead: under `lg` the rail becomes a `USlideover` opened from a toolbar button and Bridget is reached through full-bleed voice mode, while the conversation takes the full width. Verified at 375 / 768 / 900 / 1440 px (composer 275×32 / 668×32 / 800×32 / 617×32, against `0×0` on the pre-cycle code).

**One toolbar (`app/components/agent/Toolbar.vue`).** The old navbar block was duplicated verbatim across two template branches of the page. The single toolbar carries the **current thread title** (falling back to "Bridget"), the voice-replies switch, the reasoning-model selector, a full-screen button, an `lg:hidden` threads button, and an `#actions` slot the page fills with `VoiceSettingsSlideover`. Gone from it: the `Visualizer` switch (she is a column now), `History` (a rail plus a sidebar entry), `New` (head of the rail), and the tiny `IDLE` debug state readout under the canvas. The switch + model selector are `hidden sm:flex` — verified necessary, not cosmetic: without it the navbar is 430 px wide at 375 px, the `h1` collapses to 0 and the full-screen/settings buttons render **off-screen**, removing the only route to threads on a phone. Voice replies is therefore also **mirrored into `VoiceSettingsSlideover`**, bound to the same `agent-speak` cookie ref (one source of truth, no drift), which is reachable at every width.

**Conversations are reachable (`app/layouts/default.vue`).** The sidebar gained `{ label: 'Conversations', icon: 'i-lucide-messages-square', to: '/agent/history' }`. This — not the history page, which was always complete — is the actual fix for the reported "no ability to view past conversations": the defect was navigation. `/agent/history` survives as the full browse view and now **confirms before deleting** (a `UModal` naming the thread; Escape and overlay dismissal both clear the pending id). The `HistorySlideover.vue` component is **deleted**.

**Knowing which thread you are in.** Nothing client-side used to learn the id/title the server derives on a new thread's first turn, so the toolbar read "Bridget" and no rail row highlighted until a reload. `ws.ts` now sends a one-shot `{type:'conversation', …}` frame when it creates the conversation; `useVoice` exposes `conversationId`/`conversationTitle`, written from exactly three places — that frame, a successful `resume()`, and `newConversation()` (which clears both).

### Transcript

- **Autoscroll.** The transcript is pinned to the bottom; scrolling away releases the pin; a "↓ N new" chip re-pins on click. It reuses `isAtBottom`/`countNewSince` from `app/utils/transcript-scroll.ts` (cycle 24) rather than writing a second implementation. Three details are load-bearing and were each found by measurement, not design:
  - catch-up is driven by a **`ResizeObserver`** on the content wrapper, **not** a `watch` + `nextTick`. `MdView`/MDC parses and mounts markdown asynchronously beyond a tick, so a tick-based watch measures a stale `scrollHeight`, falls behind mid-stream and **never recovers** (reproduced live: `scrollTop 1717` / `scrollHeight 3102`).
  - a **100 ms `suppressScrollUntil` window** after every programmatic `scrollTop` write, because the browser dispatches a `scroll` event for our own write about a frame later and it would otherwise read as the user scrolling away.
  - chip visibility is gated on a **content signature** (`id:textLength` per entry), not on `countNewSince` alone: a reply with no tool calls grows the *last* entry in place and never pushes a new one, so the count would stay 0 for the whole reply.
- **Message actions (`app/components/agent/MessageActions.vue`).** A hover/focus-revealed row per entry: copy, retry (assistant only), timestamp, token count. Absent usage renders **nothing** — never a misleading `0 tok`.
- **Retry** re-sends the preceding user turn and replaces the assistant turn in place. It does **not** fork; `parent_id` branching stays deferred, as since cycle 28. The walk-back/truncate logic is the pure, unit-tested `truncateForRetry` (`app/lib/agent/retry.ts`) — it skips interleaved tool chips and drops everything from that user turn onward.
- **Empty state (`app/components/agent/EmptyState.vue`).** Bridget's name, one line on what she can reach, and four starter prompts drawn from the real tool surface. Mounted as a **sibling** of the ResizeObserver's content div, never inside it, so an empty transcript can't hand the observer a size baseline that includes the starter cards. A starter click fills the composer through a dedicated `prefill` prop and never sends — deliberately separate from `initialText`/`autoSend`, which is the fire-once-per-value `?q=` handoff from Home.

### Composer

`app/components/voice/Composer.vue` keeps all of its attachment handling (paste, drag-drop, file picker, the 4-file/20 MB caps, the allowed-MIME logic). `UInput` → **`UTextarea`** (`:rows="1" :maxrows="8" autoresize`); Enter sends, Shift+Enter inserts a newline, and `e.isComposing` guards an IME commit. A **Stop** button replaces Send while `busy` — `state ∈ {thinking, tool, speaking, typing}`; `listening`/`connecting` are client-only states, not generation — and sends the existing `{type:'interrupt'}` frame, whose only caller before this was the VAD barge-in path. The **mic toggle moved here from the toolbar**.

> **Rename, cycle 60:** `useVoice`'s old `stop()` was a *full teardown* (VAD + WS + AudioContext) and is now `disconnect()`; the new `stop()` aborts only the running turn and leaves the socket up. Audited: `useVoice()` has exactly one consumer and it never called the old `stop()`, so no call site silently changed meaning.

### Full-bleed voice mode

The toolbar's full-screen button (Escape to leave) covers the columns with a fixed overlay: the avatar, the mic band, and the current line as a caption. **The caption renders through `<MdView>`** with a per-entry `cache-key`. The old page interpolated `{{ caption.text }}` as plain text, so the most prominent text on the screen printed literal `#` and `**` — the visible twin of the TTS-pronounces-asterisks bug, and fixed by the same cycle. The caption is capped (`max-h-40 overflow-y-auto shrink-0`): uncapped, a long reply at 375×700 pushed the mic band below the fold with no scroll path to it. The three-column chrome stays mounted underneath, so the conversation's scroll position survives the round trip.

**Transcript rendering invariants (cycle 41 — still load-bearing):**
- Every `TranscriptEntry` has a stable unique `id` (uuid at stream time; DB message id on resume) which keys BOTH the `v-for` and the MDC parse cache (`<MdView :cache-key>`). **This is load-bearing**: `<MDC>` keys its `useAsyncData` on `hash(value)` frozen at setup — for streamed text that's the hash of the *first delta*, so two replies opening with the same token would otherwise share one asyncData record and render each other's content (live incident: three distinct replies all displayed as the first one). The cycle-60 rewrite preserved this line byte-identically, and the full-bleed caption uses its own per-entry key for the same reason.
- **Tool chips render inline** at their true stream position, live and on resume alike. Live: the orchestrator's WS `{type:'tool'}` events map to `role:'tool'` transcript entries (with undo), naturally splitting assistant text into before/after-tool bubbles. On resume (cycle 43): `resume()` rebuilds the same order from the persisted `tool_calls`' `textOffset` — see [Tool history](#tool-history-cycle-43). The old bottom-of-transcript chips block (fed by the global `/api/agent/activity` SSE) is gone; that SSE + `useAgentActivity` are currently unconsumed. Resume: `getConversation(id)` → set transcript → `loadConversation(id)`; `/agent?c=<id>` deep-links from the history page. The client transport (`app/composables/useVoice.ts`) decouples the WS from the mic so typing never prompts for a microphone and text chat survives an STT/TTS outage. `connect()` resolves only once the socket is OPEN, and `sendText`/`loadConversation` auto-connect transparently, so a typed send never races the handshake. Reads use `@tanstack/vue-query` (`useConversations`); the `conversation` live-resource refreshes lists across tabs.

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
| `edit_project` | destructive | Supports `aliases` and `newSlug` (transactional slug cascade via `updateProject`) |
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

**Config:** lives in the `image_config` settings doc, edited at `/settings/image-gen`. This is **not** the `ai_config` model registry — it holds the ComfyUI URL, workflow ID, default resolution/steps/cfg, the Qwen-Image model name, and (added cycle 38) the Qwen-Image-Edit-2509 model name + edit graph IDs. No DB migration — the settings doc is created on first save. (`editStrength` was removed in cycle 38 when img2img was replaced.)

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
- Storing voice **audio** (transcript text only), command-palette integration, multi-profile UI. (~~token-cost display~~ — a per-turn **token count** ships in the message-action row since cycle 60; a monetary cost figure does not.)
- **Per-row rename/delete on the thread rail** (cycle 60): the spec asked for a row context menu on the rail and it was **not built** — a genuine gap in that cycle's plan, deferred rather than grown into the largest task. Nothing is unreachable: both live on `/agent/history`, which the sidebar now surfaces.

See also: [voice-agent.md](voice-agent.md) (the self-hosted STT/TTS pipeline, the cycle-60 speech pipeline, and Bridget's avatar), [ai-providers.md](ai-providers.md) (model registry), [live-reactivity.md](live-reactivity.md), [web-research.md](web-research.md) (`web_search` + `web_fetch` tools, SSRF guard, SearXNG), [agent-exec.md](agent-exec.md) (approval gate + constrained exec, Cycle B2).
