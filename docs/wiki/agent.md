---
title: Agent Surface (/agent)
status: shipped
cycle: 64
updated: 2026-09-19
mymind_id: b780bc2c-df0e-465f-acc0-ed83da00da0f
mymind_hash: c2b3c91ccf100c5a07efca8e315efbd213ab076cf7fee6a53611168474e75cfc
---

# Agent Surface (`/agent`)

One surface for talking **and** typing to Bridget. `/agent` (formerly `/voice`) is a single page laid out as **three columns** — threads / conversation / Bridget — where conversations persist as resumable + searchable threads and the same shared agent core powers every turn. (Before cycle 60 it was a 75%-canvas / 25%-transcript split with the visualizer on a toggle; both the toggle and its `agent-canvas` cookie are gone.) This is the in-app "agent loop" — tool-scoped on the current 20-tool registry. Powerful capability tools (web research / shell / SSH / `gh` / file-edit) are part of the Cycle B series (B1/B2/B3 shipped).

> **Cycle 64 update — the conversation column moved onto AI SDK `UIMessage`s, rendered with AI Elements Vue.** The WS no longer carries hand-rolled `transcript`/`reasoning`/`tool`/`usage` frames for the assistant side of a turn; it carries the AI SDK's own `UIMessageChunk` stream (`{type:'chunk', turnId, chunk}`) plus one `{type:'user-message', turnId, message}` frame, assembled client-side with the SDK's `readUIMessageStream`. `app/components/voice/Transcript.vue` and `app/components/agent/ReasoningBlock.vue` are **deleted**, replaced by `app/components/agent/Conversation.vue` (+ `ToolPart.vue`, `SubagentSteps.vue`, `Attachment.vue`, `ReplyActions.vue`) built on **AI Elements Vue**, installed beside Nuxt UI behind a token bridge (`app/assets/css/main.css`) rather than porting either design system onto the other. Tools now show a live **Running → Completed/Error/Denied** state with an expandable input/output, and a subagent's nested tool calls render **inline**, nested under the parent tool, instead of collapsing to `(N tool calls)`. See [WebSocket protocol](#websocket-protocol-serverapivoicewsts) and [UI](#ui--the-three-column-surface-cycle-60) below, and [voice-agent.md](voice-agent.md) for the socket's other frames (audio, state, approval). Spec: [`2026-09-19-agent-elements-foundation-design.md`](../superpowers/specs/2026-09-19-agent-elements-foundation-design.md); handover: [`2026-09-19-agent-elements-foundation.md`](../handovers/2026-09-19-agent-elements-foundation.md).

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

**A subagent record also carries `steps?: SubagentStep[]` (cycle 64)** — `{ callId, name, summary?, state: 'running'|'done'|'error' }`, terminal states only, no args/results. `toolBlocksFor` (the model-history expansion) never reads `steps`, so it is display-only and doesn't grow what the model replays. Live, `orchestrator.ts` accumulates a subagent's nested `tool-start`/`tool-result` events (forwarded through `ctx.onNestedEvent`, see [Subagents](#subagents-cycle-42) below) into this same shape and emits the running list as a `{type:'subagent'}` `VoiceEvent` on every change — each emission carries the FULL current list, so the client reconciles (replaces) rather than appends. On resume, `toUIMessages` turns a record with `steps` into a `data-subagent` part alongside its tool part; the UI (`AgentSubagentSteps.vue`, on Elements' `ChainOfThought`) renders one step per nested call, nested under the parent tool's `Tool` card.

**Decay policy (`applyHistoryPolicy`).** Walking the conversation newest-to-oldest and counting only tool-*bearing* assistant turns (plain chat turns never consume the window):
- **The call always survives, for the life of the conversation** — `callId` + `name`, the anti-fabrication signal.
- The **last 3** tool-bearing turns keep their **payloads**, capped: `read` results at 1500 chars on replay (8192 at write, so the replay cap can be retuned with no backfill); `create`/`destructive` results are kept whole (mostly body-free receipts since cycle 52 — `exec` is the outlier, returning full stdout/stderr, and is bounded by the 8192-char write cap alone); **`args` at 1024 chars on replay, 4096 at write**.
- Older turns: **both** payloads are replaced with `{ elided: true, bytes: n }` — never the call.
- **Why args are capped too:** they are not cheap. The write tools take unbounded strings (`save_document`/`update_document`/`sync_document` `content`, `edit_document` `old_string`/`new_string`, `create_skill` `body`), and this is a document manager. Uncapped, a 60 KB body was persisted and replayed on *every* later turn with no way to decay — context overflow, conversation unusable. A truncated args object becomes `{ truncated, bytes, preview }`, which is still valid as a tool-call `input` (the AI SDK types it `unknown`).
- A malformed record (bad jsonb, or an unvalidated `messages` array posted to `/api/agent/chat`) passes through untouched rather than throwing; `toolBlocksFor` then drops it for having no `callId`.

**Replay (`buildModelMessages`, `server/lib/agent/run.ts`) — the single call site.** `runAgent` runs `applyHistoryPolicy` then `toolBlocksFor` immediately before the model call, so live and resumed history physically cannot skip the policy or drift apart. `toolBlocksFor` expands each assistant turn's records, grouped by `textOffset`, into an `assistant`(tool-call parts) → `tool`(tool-result parts) pair per distinct offset, followed by one final `assistant` message carrying the text — a turn with N distinct offsets produces 2N+1 messages. Calls sharing one offset (parallel calls in a single step) group into a single pair; calls at different offsets emit successive pairs, so a multi-step turn (call → text → call → text) replays in step order. **The pairing invariant holds even for an elided result** — an elided result still emits its paired `tool` message, because providers reject an unpaired `toolCallId`; a legacy record with no `callId` emits nothing at all rather than an unpaired half.

**Attachments on resume.** `getAgentHistory` rehydrates image/file bytes for the same 3-turn window via `hydrateAttachments` (`server/services/conversations.ts`), using the same `getImageBytes`/`getFileBytes` readers the live path uses. Turns outside the window degrade to plain text with **no placeholder** — a marker is exactly the artifact cycle 39 removed; reintroducing one here would reopen the imitation bug in a new location. A failed read for a turn *inside* the window has its `[attachment unavailable...]` note stripped before the message re-enters history (`stripUnavailableMarkers`), so a durably-missing blob can't inject a repeating marker into replayed model history on every resume.

**UI: inline part ordering on resume (cycle 64: `toUIMessages`, replaces `buildResumeTranscript`).** `app/lib/agent/to-ui-messages.ts`'s `toUIMessages(messages)` (called by `resume()` in `app/pages/agent/index.vue`) splits a resumed assistant message's `content` at each tool record's `textOffset`, interleaving `text` → `dynamic-tool` (+ `data-subagent` when the record has `steps`) → `text` parts — the same order the live path already streams in. A message is only split when **every** tool call on it carries a `textOffset` (all-or-nothing, carried over byte-for-byte from `buildResumeTranscript`'s rule); a message with any offset-less record, or any legacy row, falls back to tools-first. A tool part at the very end of a message (no trailing commentary) does not leave a floating empty reply part, but the trailing text still carries a leading `reasoning` part and `attachments`/`usage` metadata when the message has them. `app/lib/agent/transcript.ts` (+ its test) is **deleted**; every case it covered is ported into `to-ui-messages.test.ts`.

## Subagents (cycle 42)

`server/lib/agent/subagents.ts` — fixed specialist subagents exposed to the main agent as ordinary tools. Each runs a **nested `runAgent`** with a narrow tool subset, its own steering system prompt (replaces the Bridget persona), and its own step budget, and returns a compact digest — multi-step digging happens off the main conversation's context.

| Tool | Toolset | Budget | Returns |
|---|---|---|---|
| `research_web` | `web_search`, `web_fetch` | 10 steps | digest ≤~350 words + source URLs (multi-angle queries, reads 2–3 sources, reports degraded backend honestly) |
| `search_brain` | memories/docs/passages/projects/tasks read tools | 8 steps | digest with paths/citations, including what was NOT found |

Design invariants: **not** a generic spawner (fixed types keep a small orchestrator model from compounding planning errors); no subagent's toolset contains subagent tools (recursion impossible by construction); subagents live on the **profile**, not `agentTools`, so MCP never sees them; `makeSubagentTool` dynamic-imports `run.ts` (breaks the run→profile→subagents cycle); the prompt tells the orchestrator the subagents **cannot see the conversation** — pass facts via `context`. Subagents run the **default** reasoning chain always — they do not receive the connection's `{type:'model'}` override (see [WS protocol](#websocket-protocol-serverapivoicewsts)).

**Nested tool calls reach the parent live (cycle 64).** Each subagent tool's `handler` forwards its own nested `run()`'s `tool-start`/`tool-result` events through `ctx.onNestedEvent` (`server/lib/agent/subagents.ts`) — threaded from `buildAiTools`' hooks (`server/lib/agent/ai-tools.ts`), which re-emits each as `{type:'subagent-event', parentCallId, event}` (`AgentEvent`, `server/lib/agent/types.ts`). The subagent's own generated report text is **not** forwarded — it arrives once, as the outer tool's result. `orchestrator.ts` accumulates these into a running `SubagentStep[]` keyed by `parentCallId` and re-emits the **full current list** on every change as a `{type:'subagent'}` `VoiceEvent`, so each live update reconciles (replaces) rather than appends; the encoder maps it to a `data-subagent` chunk (`{type:'data-subagent', id:parentCallId, data:{steps}}`). When the outer tool settles, the accumulated steps are written onto its `AgentToolRecord.steps` for persistence (any still-`running` step is finalized to `error`).

**A known ordering gap, verified and accepted (not a bug to chase).** The AI SDK's `fullStream` emits nothing while a tool's `execute()` is pending, and `runAgent`'s old design only drained its tool-event queue when the NEXT stream part arrived — so events a tool emits *while running* (a subagent's nested calls) would all arrive in one burst when the outer tool finished, not as it went. Cycle 64 fixed this with one ordered channel (`createChannel()` in `run.ts`) that BOTH the model stream and tool callbacks push into, so a nested `tool-start` now reaches the UI as soon as it fires — verified against the real SDK (`run-live-events.test.ts`). **In dev, this only shows a real growing step list when the subagent's own model is actually reachable** — if the default reasoning chain's head is down (see the [voice-agent.md](voice-agent.md) operational note), the subagent's nested `run()` calls zero tools before giving up, and the outer tool shows `error: 'subagent produced no report'` with an empty `steps` list rather than a growing one; that is the model being unavailable, not a rendering defect.

## Conversation store

New tables (`server/db/schema/conversations.ts`, migration 0022), kept separate from the CC/Hermes import `sessions`/`messages`:

- **`conversations`**: `id`, `title` (auto from the first user turn via `deriveTitle`), `summary` (null — reserved), `project_id` (null — optional), `message_count`, `last_message_at`, `summary_embedding halfvec(2560)` (**reserved**, unpopulated — keyword search ships first), `created_at`/`updated_at`. Indexes: `last_message_at`, gin-trigram on `title`.
- **`conversation_messages`**: `id`, `conversation_id` (FK `ON DELETE CASCADE`), `parent_id` (nullable — **tree-capable edge, populated linearly** = parent is the prior turn; branching UI is deferred), `role`, `content`, `modality` (`voice`|`text`), `tool_calls jsonb` (assistant `AgentToolRecord[]` — see [Tool history](#tool-history-cycle-43)), `reasoning text` (nullable — assistant "thinking"; **display/storage only, never re-sent to the model**; migration 0026, cycle 45), `attachments jsonb` (cycle 39), `usage jsonb` (nullable, additive — **migration 0038**, cycle 60: `{inputTokens?, outputTokens?, totalTokens?}` for the assistant turn; no backfill, so a message without it omits the count rather than showing 0), `created_at`. Indexes: `(conversation_id, created_at)`, gin-trigram on `content`.

Store service: `server/services/conversations.ts` — `createConversation` / `appendMessages` (linear `parent_id` chain; persists `reasoning` on assistant rows) / `getConversation` (DTO includes `reasoning`, for UI hydration) / `getAgentHistory` (**role+content only** — reasoning is deliberately excluded, for WS model-history hydration) / `listConversations({q})` (keyword: title ILIKE OR a message content ILIKE; newest first, limit 50) / `deleteConversation` / `deriveTitle`. The two reads are differentiated on purpose: reasoning is hydrated into the *UI* but never into the *model's* context.

## WebSocket protocol (`server/api/voice/ws.ts`)

Per-connection `ConnState` adds `conversationId` + `context` + a monotonic `turnSeq`. Frames (client→server):
- binary WAV — a spoken utterance (`speak=true`, modality `voice`)
- `{type:'text', text, speak?, attachments?}` — typed turn (`speak` default false → modality `text`, reply is `typing`); `attachments` are `AttachmentRef[]` (image/file refs uploaded over HTTP beforehand)
- `{type:'interrupt'}` — barge-in / abort
- `{type:'preset', presetId}` — pick the voice **preset** for this connection (replaced `{type:'voice'}` in cycle 61 — see [voice-agent.md](voice-agent.md))
- `{type:'model', modelDefId}` — **ephemeral reasoning-model override** (cycle 45): sets `ConnState.model`, applied to every subsequent MAIN-agent turn; `null` clears it. Never writes `ai_config`. **Subagents do not inherit it** — they always run the default reasoning chain (a deliberate scope boundary; see [Subagents](#subagents-cycle-42)).
- `{type:'load', conversationId}` — hydrate history from the store (errors surface as an `error` frame)
- `{type:'new'}` — reset history + conversation + context
- `{type:'approve'|'deny', requestId, remember?, pattern?}` — resolve a pending exec approval (resolved immediately, not queued behind the turn lock)

**Server→client — the message protocol (cycle 64).** The assistant side of a turn is no longer hand-rolled `transcript`/`reasoning`/`tool`/`usage` frames; it is the AI SDK's own `UIMessageChunk` stream, encoded by `createUIChunkEncoder` (`server/lib/voice/ui-stream.ts`) from the orchestrator's existing `VoiceEvent`s and assembled client-side with `readUIMessageStream` (`app/lib/agent/turn-stream.ts`). One `createTurnStream` (`server/lib/voice/turn-stream.ts`) per turn owns emission order — `ws.ts` is a thin caller — and guarantees `finish` is sent only **after** `handleTurn` returns, because the orchestrator appends image embeds after the speech pipeline drains and those must land inside the message.

| Frame | Shape | Meaning |
|---|---|---|
| `chunk` | `{type:'chunk', turnId, chunk: UIMessageChunk}` | One AI SDK chunk of the turn's assistant message (`text-delta`, `reasoning-delta`, `tool-input-available`, `tool-output-available`\|`-error`\|`-denied`, `data-subagent`, `message-metadata` for usage, `start`/`finish`/`error`/`abort`, …) |
| `user-message` | `{type:'user-message', turnId, message: UIMessage}` | The turn's user message (STT text for voice, or the typed text + attachment file parts), sent **once**, before that turn's `chunk`s |
| `audio-begin` | `{type:'audio-begin', turnId, segmentId, sampleRate}` | **Gains `turnId`** (cycle 64) — closes the barge-in ambiguity where no frame named whose turn a segment belonged to; a segment from a superseded turn is now discarded outright by `turnId`, not just by `playback-epoch.ts`'s stale-segment check |
| `audio-end` / binary PCM / `state` / `approval` / `approval-resolved` / `conversation` / `error` | unchanged | See [voice-agent.md](voice-agent.md) for the full audio/state/approval frame list |
| ~~`transcript`~~ / ~~`reasoning`~~ / ~~`tool`~~ / ~~`usage`~~ | — | **Removed.** Superseded by `chunk`'s `text-delta`/`reasoning-delta`/`tool-*`/`message-metadata.usage` |

`turnId` is assigned once per scheduled turn (`ConnState.turnSeq`) and stamped on every frame of that turn, including `audio-begin` and `chunk`. The client (`createClientTurns`, `app/lib/agent/turn-stream.ts`) drops any frame whose `turnId` is older than the current turn, and treats a NEWER `turnId` as an implicit interrupt of whatever was active — the aborted turn's queued frames can still arrive after `{type:'interrupt'}` is sent, and this is what keeps them from corrupting the new turn's message.

**Replacing the message list (`discard()`, cycle-64 fix wave).** `interrupt()` closes a turn but still upserts its closing "stopped" snapshot — right for Stop/barge-in, wrong when the page has just **replaced** `messages`. `ClientTurns.discard()` (exposed as `useVoice().discardTurn()`) closes the active turn, marks it closed so its later frames are dropped, and suppresses every further upsert from any turn whose assembler is still draining, finalize included. `newConversation()` calls it instead of `interrupt()`, and the page calls it in `resume()` and `retryTurn()` right before assigning the new list — before this, the old thread's partial reply reappeared in the new thread, a running turn streamed into a resumed thread, and retrying a still-streaming reply re-pushed the message the truncation removed. A chunk the assembler rejects is logged (`[agent] turn N: message stream error`) and later chunks of that turn are dropped rather than throwing inside the socket's `onmessage`. Known window (documented at `interrupt()`): with no active turn, Stop closes the newest turn the client has *seen*, so a Stop before turn N's first frame lets N's first frames through until the server's abort closes it.

**`error` after `finish`.** `ws.ts` finishes the message **before** persisting, so a `createConversation`/`appendMessages` failure calls `turnStream.error()` on an already-closed stream. `error()` gates only the `error` **chunk** on the message still being open; the legacy `{type:'error'}` + `{type:'state', state:'idle'}` frames always go out, so the page alert still fires.

`{type:'usage'}` no longer exists as its own frame: usage now rides the SDK's `message-metadata` chunk (`{type:'message-metadata', messageMetadata:{usage:{...}}}}`), lifted client-side into `AgentUIMessage.metadata.usage` for the message-actions row. A later `message-metadata` **replaces** the earlier one (same overwrite semantics `ws.ts`'s `emit` closure already applied) — verified against the real assembler that no extra part appears in `parts`.

After each completed turn the handler lazily creates the conversation (first turn) and appends the new user+assistant messages (with per-message modality + collected `tool_calls` (now including `steps` for a subagent record) + accumulated `reasoning` + `usage`), then `publishChange({resource:'conversation', action})`. Live context is rebuilt **every turn** (`buildLiveContext(new Date())` at the top of each turn's run in `ws.ts` — two cheap indexed queries); the old once-per-connection cache was dropped in cycle 42 because it went stale (a task created mid-conversation never appeared).

**The persist payload is a seam, not a closure (cycle 60).** `defineWebSocketHandler` needs a real crossws upgrade to exercise, so anything built inline in `run()` is untestable. `buildTurnPersistPayload` (`server/lib/voice/turn-persist.ts`) is the pure function that turns a turn's added `AgentMessage[]` into the `appendMessages` payload, and `ws.ts` calls it. **Known residual gap, accepted:** breaking `usage: turnUsage` at the `ws.ts` *call site* still leaves the suite green — closing it needs a crossws harness that exists for no part of `ws.ts` today. Inside the extracted function the wiring is red/green-verified.

**Where usage comes from.** `run.ts` reads the AI SDK's `finish` stream part (`totalUsage ?? usage`, defensively — the SDK has renamed that field before) and yields a `{type:'usage'}` `AgentEvent`; `orchestrator.ts` re-emits it as a `VoiceEvent`; `ws.ts`'s `emit` closure — the same seam that collects `tool_calls` and `reasoning` — **overwrites** (never accumulates) it and persists it on the assistant row. Overwrite is deliberate: the forced-final recovery path runs a second `streamText` call whose usage supersedes rather than adds to the first. **`includeUsage: true` on `createOpenAICompatible` (`server/lib/ai/registry/resolve.ts`) is what makes any of it non-null** — without it the upstream never returns per-turn usage and the whole chain is inert. That resolver is shared, so the flag was verified on **both** reasoning providers (self-hosted vLLM and Claude-via-LiteLLM) with `activity_log` showing `attempt:0` for each — explicitly ruling out the "failover masked a broken primary" pattern this repo has been bitten by. `createOpenAICompatible` appears exactly once; bulk/vision/embeddings/stt/tts/rerank all use raw-fetch adapters and are untouched.

## Reasoning block + on-the-fly model selector (cycle 45)

Two additions to the `/agent` surface, both riding the WS pipeline only.

**Reasoning "Thinking" block.** The reasoning models emit `reasoning_content` (a `<think>` block) as a channel separate from the answer. `@ai-sdk/openai-compatible` parses it into `reasoning-delta` stream parts, which `runAgent` was dropping. Now:
- `run.ts` yields a `{type:'reasoning-delta', text}` `AgentEvent` (read defensively as `part.delta ?? part.text`).
- `orchestrator.ts` emits a `{type:'reasoning', text}` `VoiceEvent` — **never chunked/spoken and never merged into `assistantText`**, so voice turns don't read the thinking aloud and it never enters the model's history.
- `ws.ts` accumulates the reasoning in its `emit` closure (the same seam that collects `tool_calls`) and persists it on the assistant row (`conversation_messages.reasoning`).
- **Cycle 64 update:** the client no longer has a bespoke `TranscriptEntry.reasoning`/`ReasoningBlock.vue` pair. `createUIChunkEncoder` (`server/lib/voice/ui-stream.ts`) maps each `{type:'reasoning'}` `VoiceEvent` to `reasoning-start`/`reasoning-delta`/`reasoning-end` chunks like any other AI SDK part, so a message's reasoning is just its `reasoning`-type part; `app/components/agent/Conversation.vue` renders it with Elements' `Reasoning`/`ReasoningTrigger`/`ReasoningContent` (auto-open while `state==='streaming'`, collapsible, a manual toggle still wins once touched — same UX, generic component). On resume, `toUIMessages` turns the persisted `reasoning` string into one leading `reasoning` part per message (see [Tool history](#tool-history-cycle-43) — the "known asymmetry" this creates: live reasoning can interleave with tools, a resumed message shows it as a single leading block).

**On-the-fly reasoning-model override.** A navbar `USelectMenu` (`app/pages/agent/index.vue`) lists the models assigned to the `reasoning` usage (from `useAiConfig`) plus a **"Default (chain order)"** entry. Picking one:
- writes the cookie `agent-model` (`''` = default) and sends `{type:'model', modelDefId}` over the WS; the pick is **resent on every WS (re)open** (like the voice pick), so it survives reconnects;
- server-side, `reasoningModels(modelDefId)` calls the pure `reorderChain` (`server/lib/ai/registry/resolve.ts`) to move the chosen model to the **front** of the resolved chain — **the rest stay as failover**; an unknown/`null`/`undefined` id is a no-op (falls back to the configured order).
- The override is **ephemeral and connection-level** — it lives in `ConnState.model` + the cookie and **never mutates `ai_config`**. Subagents do **not** inherit it (they run the default reasoning chain — a deliberate scope boundary).
- reka-ui gotcha: `USelectMenu`/`ComboboxItem` **rejects an empty-string item value**, so the "Default" option uses a non-empty sentinel (`'__default__'`) mapped back to `''`/`null`. (Caught in browser E2E; typecheck/build/review all passed the empty-string version.)

## Personality (Bridget)

`buildSystemPrompt({profile, speak, context})` (`server/lib/agent/prompt.ts`) composes: **[editable persona]** + **[time-of-day tone]** + **[modality rules from `speak`]** + **[live context]**.
- **Editable** — persona text in the `settings` table under key `agent_persona` (`server/lib/agent/persona.ts`, cached like `ai_config`; `DEFAULT_PERSONA` seed). Edited in-app at **`/settings/bridget`** (`GET`/`PUT /api/settings/persona`).
- **Time-of-day** — `timeOfDayTone(now)` (morning/afternoon/evening/late-night). (Verified live: an evening turn replied "Evening, Tony!".)
- **Context-aware** — `buildLiveContext(now)` injects active projects + open tasks (rebuilt every turn — two cheap indexed queries — so a task created mid-conversation shows up on the next turn).
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

### Conversation (cycle 64 — AI Elements Vue; replaces the hand-rolled Transcript)

`app/components/agent/Conversation.vue` renders `messages: AgentUIMessage[]` (the AI SDK's own `UIMessage` shape — see [WS protocol](#websocket-protocol-serverapivoicewsts)) through **AI Elements Vue** (`vuepont/ai-elements-vue`, installed via its CLI beside Nuxt UI, `app/components/ai-elements/**` + `app/components/ui/**`) instead of the old bespoke ResizeObserver/MDC-cache-key scroll+parse plumbing.

**The design-system bridge.** Elements/shadcn and Nuxt UI both register Tailwind v4 tokens under the same names (`--color-primary`, `--color-secondary`, `bg-muted`) with different meanings. Rather than importing shadcn's stock theme (which would repaint every Nuxt UI component) or porting Elements onto Nuxt UI primitives, `app/assets/css/main.css` defines only the shadcn tokens Nuxt UI doesn't own (`--color-background`, `--color-card(-foreground)`, `--color-popover(-foreground)`, `--color-muted-foreground`, `--color-border`, `--color-destructive`, …), each pointing at the matching `--ui-*` variable — e.g. `--color-background: var(--ui-bg)`. Nuxt UI keeps `primary`/`secondary`/`muted`; a handful of vendored components that assumed "secondary = grey" are patched in place (`bg-secondary` → `bg-elevated`). Every Elements-rendered subtree is scoped with a `data-ai-elements` attribute (on `Conversation`'s root) for CSS/test targeting. Verified no-repaint: before/after screenshots of `/`, `/tasks`, `/documents`, `/settings` are pixel-identical.

**Bundle weight (and why the build heap matters).** The spike's "+5 KB gzip" was measured before the Elements `CodeBlock` highlighted anything and was wrong for the shipped branch: `createHighlighter` from `shiki` registers shiki's **full** bundle (every grammar and theme as a lazy chunk, plus the oniguruma WASM), which took client JS from 1.81 MB to 3.70 MB gzip (203 → 572 chunks) and made `pnpm build` crash with "Reached heap limit" at deploy.yml's `--max-old-space-size=4096`. The fix-wave `code-block/utils.ts` builds one highlighter from **`shiki/core`** + the **JS regex engine** (what `@nuxtjs/mdc` already uses — no WASM) with only the `json` grammar the agent UI renders (anything else renders as plain text) and the `github-light`/`github-dark` themes; a `pnpm-workspace.yaml` `overrides` block collapses `@nuxtjs/mdc`'s shiki 4.1.0 onto 4.4.3 so both share one `@shikijs/core`, engine and grammar/theme chunks (the `json` grammar chunk is MDC's own). Result: 264 chunks / 2.10 MB gzip; the build passes at 4096 MB and at the V8 default. **Rule:** never import `createHighlighter`/`codeToHtml` from bare `shiki` in client code — use `shiki/core` with explicit `shiki/langs/*` / `shiki/themes/*` imports. `/dev/**` fixture pages are excluded from production builds (`$production.ignore` in `nuxt.config.ts`).

**Per-part rendering:**

| `AgentUIPart.type` | Renders as |
|---|---|
| `text` | `MessageResponse` (streaming markdown, `vue-stream-markdown`); assistant only — a user turn's text is plain `<p>` |
| `reasoning` | `Reasoning` / `ReasoningTrigger` / `ReasoningContent` — auto-open while `state==='streaming'`, closable, same "Thinking" concept as the old `ReasoningBlock.vue` (now deleted) |
| `dynamic-tool` | `app/components/agent/ToolPart.vue` → Elements `Tool`/`ToolHeader`/`ToolInput`/`ToolOutput` — a status badge (**Running** while `input-streaming`\|`input-available`, **Completed**/**Error**/**Denied** once settled), a collapsible JSON input (`CodeBlock`, highlighted by the fine-grained shiki described above) and output (`envelope.value`, syntax-highlighted), and an **Undo** action when `envelope.undoToken` is present |
| `data-subagent` | `app/components/agent/SubagentSteps.vue` → Elements `ChainOfThought`, nested **inside** the parent tool's card (looked up by `toolCallId` via `subagentSteps()` in `app/lib/agent/render.ts`) — one step per nested call, open while any step is `running` |
| `file` (user) | `app/components/agent/Attachment.vue` — image thumbnail / file chip, as before |

Retry/copy/timestamp/token-count moved onto `app/components/agent/ReplyActions.vue` (ported from the old `MessageActions.vue`, now deleted, keyed off `AgentUIMessage` instead of `TranscriptEntry`). `app/lib/agent/retry.ts`'s `truncateForRetry` and the undo flow were adapted from entry ids to message ids / tool call ids; their walk-back/skip-tool-chips behaviour is unchanged. Scrolling (stick-to-bottom + a scroll-to-bottom button) and markdown streaming now come from Elements' `Conversation`/`ConversationContent`/`ConversationScrollButton` (`vue-stick-to-bottom` under the hood) — the cycle-41 `ResizeObserver`/`suppressScrollUntil`/content-signature plumbing this replaced is documented in the cycle-60 handover for history but no longer exists in the tree.

- **Empty state (`app/components/agent/EmptyState.vue`, unchanged).** Bridget's name, one line on what she can reach, and four starter prompts drawn from the real tool surface. A starter click fills the composer through a dedicated `prefill` prop and never sends — deliberately separate from `initialText`/`autoSend`, the fire-once-per-value `?q=` handoff from Home.
- **The token bridge for Elements' own state.** `app/components/agent/ToolPart.vue` reads `part.state` (`input-streaming`\|`input-available`\|`output-available`\|`output-error`\|`output-denied`) directly off the AI SDK part — there is no separate client-side "is this tool still running" flag to drift from the stream; `isRunning()` (`app/lib/agent/render.ts`) is a one-line predicate over that same state, unit-tested.

### Composer

`app/components/voice/Composer.vue` keeps all of its attachment handling (paste, drag-drop, file picker, the 4-file/20 MB caps, the allowed-MIME logic). `UInput` → **`UTextarea`** (`:rows="1" :maxrows="8" autoresize`); Enter sends, Shift+Enter inserts a newline, and `e.isComposing` guards an IME commit. A **Stop** button replaces Send while `busy` — `state ∈ {thinking, tool, speaking, typing}`; `listening`/`connecting` are client-only states, not generation — and sends the existing `{type:'interrupt'}` frame, whose only caller before this was the VAD barge-in path. The **mic toggle moved here from the toolbar**.

> **Rename, cycle 60:** `useVoice`'s old `stop()` was a *full teardown* (VAD + WS + AudioContext) and is now `disconnect()`; the new `stop()` aborts only the running turn and leaves the socket up. Audited: `useVoice()` has exactly one consumer and it never called the old `stop()`, so no call site silently changed meaning.

### Full-bleed voice mode

The toolbar's full-screen button (Escape to leave) covers the columns with a fixed overlay: the avatar, the mic band, and the current line as a caption. **The caption renders through `<MdView>`** with a per-message `cache-key` (`caption-${caption.id}`) — unlike the main conversation (cycle 64: Elements' `MessageResponse`/`vue-stream-markdown`), this one small overlay still uses `MdView`/MDC (it is not part of the `AgentConversation` tree, just a `computed` over `voice.messages.value` picking the last non-empty message's text via `uiMessageText()`, `app/lib/agent/render.ts`). The old page interpolated `{{ caption.text }}` as plain text, so the most prominent text on the screen printed literal `#` and `**` — the visible twin of the TTS-pronounces-asterisks bug, fixed in cycle 60. The caption is capped (`max-h-40 overflow-y-auto shrink-0`): uncapped, a long reply at 375×700 pushed the mic band below the fold with no scroll path to it. The three-column chrome stays mounted underneath, so the conversation's scroll position survives the round trip. `MdView`'s cache-key-per-id rule (cycle 41, described in the cycle-60/61 handovers) still applies here for the same reason it always did: `<MDC>` keys its parse cache on the hash of the value frozen at setup, so two captions opening with the same token would otherwise share one parse record.

**Tool parts render inline, live and on resume alike (cycle 64).** Live: `createUIChunkEncoder` maps each `tool-start`/`tool-result` `VoiceEvent` to `tool-input-available`/`tool-output-*` chunks in stream position, naturally splitting a message's `text` parts into before/after-tool segments — see [WS protocol](#websocket-protocol-serverapivoicewsts). On resume: `toUIMessages` (`app/lib/agent/to-ui-messages.ts`) rebuilds the same order from the persisted `tool_calls`' `textOffset` — see [Tool history](#tool-history-cycle-43). The old bottom-of-transcript chips block (fed by the global `/api/agent/activity` SSE) was already gone before this cycle; that SSE-backed composable, `app/composables/useAgentActivity.ts`, had zero callers and is now **deleted**, along with `app/composables/useTextChat.ts` (the pre-WS typed-chat fallback over `/api/agent/chat`, also callerless). Resume: `getConversation(id)` → `toUIMessages(...)` → `voice.messages.value = ...` (`resume()`, `app/pages/agent/index.vue`); `/agent?c=<id>` deep-links from the history page. The client transport (`app/composables/useVoice.ts`) decouples the WS from the mic so typing never prompts for a microphone and text chat survives an STT/TTS outage. `connect()` resolves only once the socket is OPEN, and `sendText`/`loadConversation` auto-connect transparently, so a typed send never races the handshake. Reads use `@tanstack/vue-query` (`useConversations`); the `conversation` live-resource refreshes lists across tabs.

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
