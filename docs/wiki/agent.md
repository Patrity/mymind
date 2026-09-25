---
title: Agent Surface (/agent)
status: shipped
cycle: 71
updated: 2026-09-24
mymind_id: b780bc2c-df0e-465f-acc0-ed83da00da0f
mymind_hash: 8dfb0547f7e2cc8ce201900150e7d7116b620bb42fa60aa022750ee5fac02551
---

# Agent Surface (`/agent`)

One surface for talking **and** typing to Bridget. `/agent` (formerly `/voice`) is a single page laid out as **two panels** — threads / conversation — where conversations persist as resumable + searchable threads and the same shared agent core powers every turn. (Cycle 60 had a third "Bridget" column holding a three.js particle head; cycle 65 removed it and replaced the face with a Rive **Persona** that lives inside the conversation column. Before cycle 60 it was a 75%-canvas / 25%-transcript split with the visualizer on a toggle; both the toggle and its `agent-canvas` cookie are long gone.) This is the in-app "agent loop" — tool-scoped on the current 20-tool registry. Powerful capability tools (web research / shell / SSH / `gh` / file-edit) are part of the Cycle B series (B1/B2/B3 shipped).

> **Cycle 71 update — slash commands.** A `/` at the start of the composer opens a command menu over three merged sources with precedence **code > prompt > skill**: client behaviours (`/clear`, `/new`), `prompt_commands` rows whose template expands client-side, and skills — invoked as **`/browser-testing`, not `/skill browser-testing`** — whose body is loaded **server-side** into the assembled context as a fixed tier. See [Slash commands](#slash-commands-cycle-71). Spec: [`2026-09-24-slash-commands-design.md`](../superpowers/specs/2026-09-24-slash-commands-design.md); handover: [`2026-09-24-slash-commands.md`](../handovers/2026-09-24-slash-commands.md).

> **Cycle 68 update — a conversation is a tree, and the message action row is visible without hovering.** `conversations.active_leaf_id` (migration `0045_busy_solo.sql`) names the one path through the tree that is being read, and **both** read paths — `getConversation` (the UI) and `getAgentHistory` (the model) — walk it through the single `loadActivePath`. Copy / regenerate / edit / fork sit in an always-visible row with a live **duration** and **tok/s** figure. **Retry changed behaviour: it used to truncate the thread, and now branches** — the previous reply stays reachable through a ‹ n/N › pager. See [The conversation tree](#the-conversation-tree-cycle-68) and [The message action row](#the-message-action-row-cycle-68). Spec: [`2026-09-21-agent-chat-affordances-design.md`](../superpowers/specs/2026-09-21-agent-chat-affordances-design.md); handover: [`2026-09-21-agent-chat-affordances.md`](../handovers/2026-09-21-agent-chat-affordances.md).

> **Cycle 65 update — the page itself is now AI Elements.** Cycle 64 moved the *conversation* onto AI SDK `UIMessage`s; cycle 65 rebuilt everything around it. The third column and the whole particle-head/`lib/viz` stack are **deleted**; a Rive **Persona** (`app/components/agent/Persona.client.vue`) renders as a hero in the empty thread, inline in the composer during a conversation, and full-size in voice mode. `app/components/voice/Composer.vue` is replaced by `app/components/agent/PromptInput.vue` on Elements `PromptInput` (attachments, model select, speak toggle, context meter, mic, send/stop). Exec approvals are no longer a detached banner: they ride the message stream as the SDK's own `tool-approval-request` chunk and render as an Elements `Confirmation` **inside the tool card**, so they die with the turn they belong to. A **context meter** shows how full the answering model's context window is. See [UI](#ui--the-two-panel-surface-cycle-65), [Inline exec approvals](#inline-exec-approvals-cycle-65) and [Context meter](#context-meter-cycle-65). Spec: [`2026-09-19-agent-page-rebuild-design.md`](../superpowers/specs/2026-09-19-agent-page-rebuild-design.md); handover: [`2026-09-19-agent-page-rebuild.md`](../handovers/2026-09-19-agent-page-rebuild.md).

> **Cycle 64 update — the conversation column moved onto AI SDK `UIMessage`s, rendered with AI Elements Vue.** The WS no longer carries hand-rolled `transcript`/`reasoning`/`tool`/`usage` frames for the assistant side of a turn; it carries the AI SDK's own `UIMessageChunk` stream (`{type:'chunk', turnId, chunk}`) plus one `{type:'user-message', turnId, message}` frame, assembled client-side with the SDK's `readUIMessageStream`. `app/components/voice/Transcript.vue` and `app/components/agent/ReasoningBlock.vue` are **deleted**, replaced by `app/components/agent/Conversation.vue` (+ `ToolPart.vue`, `SubagentSteps.vue`, `Attachment.vue`, `ReplyActions.vue`) built on **AI Elements Vue**, installed beside Nuxt UI behind a token bridge (`app/assets/css/main.css`) rather than porting either design system onto the other. Tools now show a live **Running → Completed/Error/Denied** state with an expandable input/output, and a subagent's nested tool calls render **inline**, nested under the parent tool, instead of collapsing to `(N tool calls)`. See [WebSocket protocol](#websocket-protocol-serverapivoicewsts) and [UI](#ui--the-two-panel-surface-cycle-65) below, and [voice-agent.md](voice-agent.md) for the socket's other frames (audio, state, approval). Spec: [`2026-09-19-agent-elements-foundation-design.md`](../superpowers/specs/2026-09-19-agent-elements-foundation-design.md); handover: [`2026-09-19-agent-elements-foundation.md`](../handovers/2026-09-19-agent-elements-foundation.md).

## The convergence principle (one flow, one branch)

Voice and text run through the **same** path: client WebSocket → `server/lib/voice/orchestrator.ts` (`handleTurn`/`handleUtterance`) → `runAgent` (`server/lib/agent/run.ts`). There is **no second agent code path for the UI**. A turn varies only by independent flags:

| Flag | Effect |
|---|---|
| input: mic / typed | how the turn arrives — VAD→WAV utterance vs. a `{type:'text'}` frame |
| `speak`: on / off | **the sole voice/text branch** — gates TTS *and* selects prompt mode (spoken-brief/no-markdown vs. text/markdown-ok). Default: on for mic, off for typed unless "Respond in voice" is on |
| ~~canvas: on / off~~ | **removed in cycle 60**, and the column it became was removed in cycle 65. The `agent-canvas` cookie no longer exists. The Persona still reacts to `typing` on text turns (it maps to `thinking`). |

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

- **`conversations`**: `id`, `title` (auto from the first user turn via `deriveTitle`), `summary` (null — reserved), `project_id` (null — optional), `message_count` (**every row in the tree, inactive branches included** — see [The conversation tree](#the-conversation-tree-cycle-68)), `last_message_at`, `active_leaf_id uuid` (nullable — **migration 0045**, cycle 68: the message that ends the path currently being read; null means "fall back to a flat read"), `summary_embedding halfvec(2560)` (**reserved**, unpopulated — keyword search ships first), `created_at`/`updated_at`. Indexes: `last_message_at`, gin-trigram on `title`.
- **`conversation_messages`**: `id`, `conversation_id` (FK `ON DELETE CASCADE`), `parent_id` (nullable — the tree edge. Reserved by cycle 28 and written linearly until cycle 68; **it is now read**, and a message can have more than one child), `role`, `content`, `modality` (`voice`|`text`), `tool_calls jsonb` (assistant `AgentToolRecord[]` — see [Tool history](#tool-history-cycle-43)), `reasoning text` (nullable — assistant "thinking"; **display/storage only, never re-sent to the model**; migration 0026, cycle 45), `attachments jsonb` (cycle 39), `usage jsonb` (nullable, additive — **migration 0038**, cycle 60: `{inputTokens?, outputTokens?, totalTokens?}` for the assistant turn, plus `contextTokens?`/`modelDefId?` from cycle 65 and `startedAt?`/`ttftMs?`/`durationMs?` from cycle 68; no backfill, so a message without it omits the figure rather than showing 0), `created_at`. Indexes: `(conversation_id, created_at)`, gin-trigram on `content`.

Store service: `server/services/conversations.ts` — `createConversation` / `appendMessages` (chains from `active_leaf_id`, not from the newest row, and moves the leaf onto what it wrote — **both inside one transaction**) / `captureTurnLeaf` / `branchParent` / `setActiveLeaf` / `setBranchLeaf` / `conversationHasMessage` / `getConversation` (DTO includes `reasoning`, for UI hydration) / `getAgentHistory` (reasoning deliberately excluded, for WS model-history hydration) / `listConversations({q})` (keyword: title ILIKE OR a message content ILIKE; newest first, limit 50) / `deleteConversation` / `deriveTitle`. The two reads are differentiated on purpose: reasoning is hydrated into the *UI* but never into the *model's* context — but **both resolve which messages exist through the same `loadActivePath`** (cycle 68), which is the property the next section exists to protect.

## The conversation tree (cycle 68)

A thread is a **tree**, and what you are reading is one **path** through it. `parent_id` has carried
that edge since cycle 28 but nothing read it; cycle 68 added the other half.

**`conversations.active_leaf_id`** names the last message on the active path. Everything else is
derived from it by walking `parent_id` upward.

### One walk, two readers — and why they must agree

`loadActivePath(conversationId)` (`server/services/conversation-path.ts`) is the **only** place a
transcript is resolved. It runs one query, orders it `(created_at, id)`, and hands the rows to the
pure `activePath(rows, leafId)` (`shared/utils/conversation-path.ts`, unit-tested without a
database). It returns the path plus a `Map` of `BranchInfo` — `{ index, total, siblingIds }` — for
every message in the thread.

Its two callers are `getConversation` (what the **user** reads) and `getAgentHistory` (what the
**model** is given). **If those two ever resolved different rows, the model would answer a
conversation nobody is reading and nothing in the UI would say so** — which is why the null-leaf
fallback lives *inside* the shared function rather than in either caller, and why
`test/conversation-path.db.test.ts` asserts `expect(model).toEqual(ui)` over full message objects.
Breaking `getAgentHistory` reddens exactly those equality assertions and nothing else in the suite,
which is itself the finding: no other test in the repo would notice the divergence.

Deliberately **not** a recursive CTE, though the spec asked for one: an in-memory walk keeps both
paths on one unit-tested function instead of duplicating the walk in SQL. It fetches no more rows
than `getConversation` already fetched. Revisit if a conversation ever approaches session scale
(prod's largest is 14 messages).

**`(created_at, id)` is not decoration.** Cycle 66 measured a **26%** `created_at` collision rate on
the sessions `messages` table (58,417 of 228,692 rows share a timestamp with a sibling, largest tie
group 615) — the same insert pattern writes a turn's user and assistant rows microseconds apart
here — and each read path runs its own copy of the query, so on `created_at` alone Postgres may
order tied rows differently per query, which would let the two paths disagree on the fallback and
swap a sibling between `1/2` and `2/2` between requests, surfacing as a pager that jumps.

### One primitive, three operations

Every branch-creating action is "point the leaf somewhere, then send a turn". `branchParent` decides
where:

| Operation | Leaf goes to | Result |
|---|---|---|
| **Fork** from a message | that message itself | the next turn continues **from there** |
| **Edit** a user message | that message's **parent** | the edited question is a **sibling** of the original |
| **Regenerate** a reply | the **preceding user message's parent** | a second attempt at the same question, as a sibling |

**Regenerate deviates from the spec's literal wording**, deliberately. The spec says "regenerate →
that reply's parent", which would make the new reply a second child of the user message. The WS turn
**always persists a `[user, assistant]` pair** — there is no path that appends an assistant message
alone — so resending under the user message would write `U → U2 → R2` and duplicate the question
inside the regenerated branch. So regenerate shares the edit mechanism (`app/pages/agent/index.vue`'s
`retryTurn` calls `editTurn` with the text unchanged) and the **pager sits on the user message rather
than on the reply**. The promise the spec actually made — the previous reply stays reachable — is
kept exactly.

**Nothing is ever deleted.** An edit does not rewrite its message; a regenerate does not replace its
reply. Both are additional rows, and the old ones stay reachable through the pager.

### Switching branches is a server round-trip

`PATCH /api/conversations/:id/leaf` (`server/api/conversations/[id]/leaf.patch.ts`), body
`{ leafId, op? }`:

- **No `op` — "switch to this branch."** `setActiveLeaf` resolves `leafId` to that branch's **tip**
  via the pure `branchTip`, which follows the **newest child at each step** (not the deepest — the
  name would be a lie; resuming a branch should land where you last left off writing it). Without the
  descent, switching to a sibling that has its own continuation would set the leaf to the sibling and
  make everything below it invisible to **both** read paths — the exact silent-hiding this cycle
  exists to prevent.
- **With an `op`** (`fork`/`edit`/`regenerate`) — "start a new branch here." `setBranchLeaf` writes
  `branchParent`'s answer **exactly**, no descent, because the descent above would walk a fork
  straight back to the end of the thread and quietly undo it. An **unknown** `op` is a 400, never a
  silent fall-back to the descending path.

The response returns the **resolved** leaf, never the requested one. The client cannot compute any of
this itself: it only ever fetches the active path, so `siblingIds` on the DTO is its only handle on a
branch it is not reading.

**Two client-side guards** (`app/pages/agent/index.vue`), both for the same hazard — between the leaf
move and the send, the thread is truncated:

- **Edit** captures the previous leaf and **restores it** whenever the leaf moved and no turn went
  out. There are **two** such exits, not one, and `moveLeaf` reports them apart as `blocked` (the
  PATCH never landed — nothing to undo) vs `stranded` (the PATCH landed and the re-read then failed —
  the leaf HAS moved, and because `resume` commits last the screen still shows the old, longer
  transcript). `sendText` returning false or throwing is the third. Collapsing `stranded` into "the
  move did not happen" was a real defect: it skipped the restore, left the thread truncated in the
  database, and reported it as *"Could not open conversation"*.
- **Fork defers the move entirely**: clicking it arms the composer ("Your next message branches from
  …", with a Cancel) and `sendTurn` moves the leaf immediately before sending. Abandoning a fork has
  no failure event to hang a restore off — the user just navigates away — so nothing is persisted at
  all. It also stops the transcript rewinding the instant you press the button.

A **branch switch** (`switchBranch`) that strands says so and leaves the leaf alone: the leaf landed
on the other branch's **tip**, which hides nothing, so restoring would be wrong — only the screen is
behind, and the toast says to reload. The leaf it restores to comes from `restorableLeafId`
(`app/lib/agent/branching.ts`), which returns the tail's id **only when that tail is a persisted
row** (recognised by the server-supplied `siblingIds` containing its own id). A tail that is still
the live stream's carries a stream UUID; PATCHing it 404s, and falling back to the last id the client
*does* recognise would point the leaf one turn too far back and truncate the thread itself.

After any turn the page **re-reads the thread**. Its trigger is the `{type:'persisted',
conversationId}` frame `ws.ts` sends the instant `appendMessages` returns — **the only post-commit
signal the page has**. `state:'idle'` is emitted inside the orchestrator's `exec`, before
`ts.finish()` and well before the append, so a re-read armed by `idle` alone races the persist; when
it won that race the read came back without the turn's rows, the "never shorter" guard (correctly)
refused it, and the turn was left holding stream UUIDs — every branch action on it 404ing and no
pager rendering until another turn or a reload. Arming on the commit cannot lose that race, and
because a refused read clears the pending flag, the frame re-arming it **is** the retry, bounded to
one extra read per turn. `busy` and `conversationId` remain watch sources (a spoken turn stays
`speaking` until playback drains, so the frame can land while `busy` is still true; and on a thread's
first turn the id does not exist yet when the turn goes idle). The re-read still refuses any result
shorter than what is on screen.

### Known limits, stated rather than discovered later

- **The first turn of a thread cannot be edited or regenerated.** `branchParent` returns `null` for a
  root, and `active_leaf_id = null` already means "fall back to a flat read", so there is no way to
  express "start a second root" without changing what null means to both read paths. The endpoint
  says so honestly — *"The first message of a thread cannot be branched yet"* — instead of claiming
  the message is not in the conversation. Rephrasing an opening question needs a new thread, which is
  what it needed before this cycle too.
- **`message_count` counts every row in the tree**, inactive branches included, so a branched thread's
  rail count legitimately exceeds what is on screen (10 rows, 4 displayed, is normal). Spec-stated and
  accepted rather than re-derived per branch.
- **A mid-turn branch switch is overridden when the reply lands.** The turn's leaf is captured at turn
  start (`captureTurnLeaf`) and passed to both persist calls, so the messages attach to the branch the
  turn was sent from — the data-integrity half. The leaf then moves to the new reply unconditionally,
  so the user is pulled to the arriving answer. A UX surprise, not data loss: both branches stay
  reachable.
- **The concurrent-writer race on the leaf is parked, not fixed.** Read-leaf → insert → write-leaf is
  not serialized (the transaction is for atomicity only; there is no `SELECT … FOR UPDATE` and no
  advisory lock, deliberately). The race **predates** this cycle — newest-row chaining had it too —
  and branching makes its consequence *less* harmful: two concurrent turns now produce a surprise
  branch you can page to, instead of an unreadable orphan.

## The message action row (cycle 68)

`app/components/agent/ReplyActions.vue`. **A third of the complaint that started this cycle was a
discoverability defect, not a missing feature**: copy, regenerate, the timestamp and the token count
already existed here, behind `opacity-0 group-hover:opacity-100` — invisible until hover and
completely unreachable on a touch device, where there is no hover at all. The class is gone; the row
is always visible and wraps rather than overflowing (measured inside 375px).

Left to right: **copy** (flips to a tick for 1.5s), **regenerate** (assistant messages), **edit**
(user messages), **fork**, the **‹ n/N › pager** (`AgentBranchPager`, rendered only when
`total > 1` — a `v-if`, so an unbranched thread has no pager in the DOM at all, and each arrow is
disabled at its own end), the **timestamp**, the **duration**, the **tok/s** figure, and an **info**
button carrying the token count and the answering model id.

That info button is a **controlled** `UTooltip` toggled on click. A plain one does not work on touch:
reka ignores `pointermove` when `pointerType` is `touch` and its `focus` handler bails while a
pointer is down, so a tap opens nothing — which would have reintroduced the very defect this row
exists to fix, for secondary metadata.

`AgentBranchPager` is three plain `UButton`s, **not** the vendored Elements
`MessageBranchPrevious`/`Next`: those `inject` a `MessageBranch` context and **throw** without an
ancestor provider, count branches from slotted VNodes (client-side variants, which is not what a
server-side pager has), wrap around, and share one `totalBranches <= 1` disabled state between both
arrows rather than clamping each end.

### Timing: `startedAt` / `ttftMs` / `durationMs`

`ws.ts` stamps the turn clock into `usage` (the jsonb that already holds this message's model and
token facts) and **finalizes it once** per turn, using the same value for the live
`message-metadata` chunk and the persisted row — so the figure on screen and the figure in the
database cannot disagree. Both the success and the rescue persist paths take it.

`app/lib/agent/metrics.ts` formats it: `durationLabel` → `"4.2s"` / `"820ms"`, `rateLabel` →
output tokens over the **generating** window (`durationMs - ttftMs`, so a slow model start is not
read as slow generation). Both guard with `Number.isFinite`, because `NaN <= 0` is false and a
corrupt jsonb row would otherwise render `NaN tok/s`.

**`rateLabel` knowingly under-reads two kinds of turn**, and that is documented rather than fixed.
Both put time inside the measured window that the model did not spend generating, so both read
*slower* than it actually generated:

- **a tool-calling turn** spends much of its wall-clock waiting on the tools, and that wait is
  inside the window;
- **a spoken turn** (`speak: true`) has `durationMs` sampled when `exec` returns, which is *after*
  TTS synthesis — and synthesis happens after the first token, so it lands inside the window too.

`durationLabel` is displayed beside it so a low figure is attributable. Measuring only the streaming
intervals would be more machinery than a monitoring readout justifies.

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

**Control frames abort the turn AND deny its approvals (cycle 65).** `interrupt`, `new` and `load` all call `s.ac?.abort()` followed by `denyAll()` — `denyPendingApprovals(s.pendingApprovals)` (`server/lib/voice/pending-approvals.ts`, pure + unit-tested: clears timers, resolves each pending approval `{approved:false}`, empties the map) plus one `{type:'approval-resolved', requestId}` frame per id. Before this, the approval `Promise` was independent of the turn's `AbortSignal`, so Stopping a turn that was waiting on an approval left the server blocked until the 120 s timeout and the *next* message sat behind the turn lock for that whole window. `close` does the same on a best-effort basis. Measured after the change: the next message's server echo arrives ~4 s after Enter.

**An aborted turn sends no `state:'idle'` (client-side gotcha).** `orchestrator.ts` returns early the moment its signal is aborted, before the emit that would send idle. `useVoice`'s `restAfterAbort()` (used by `stop()`, `newConversation()` and `loadConversation()`) is what returns the client to rest — it calls `stopPlayback()` and sets `state.value = 'idle'`. Any future caller that aborts a turn must go through it, or the composer stays stuck showing Stop with no way to send.

**Server→client — the message protocol (cycle 64).** The assistant side of a turn is no longer hand-rolled `transcript`/`reasoning`/`tool`/`usage` frames; it is the AI SDK's own `UIMessageChunk` stream, encoded by `createUIChunkEncoder` (`server/lib/voice/ui-stream.ts`) from the orchestrator's existing `VoiceEvent`s and assembled client-side with `readUIMessageStream` (`app/lib/agent/turn-stream.ts`). One `createTurnStream` (`server/lib/voice/turn-stream.ts`) per turn owns emission order — `ws.ts` is a thin caller — and guarantees `finish` is sent only **after** `handleTurn` returns, because the orchestrator appends image embeds after the speech pipeline drains and those must land inside the message.

| Frame | Shape | Meaning |
|---|---|---|
| `chunk` | `{type:'chunk', turnId, chunk: UIMessageChunk}` | One AI SDK chunk of the turn's assistant message (`text-delta`, `reasoning-delta`, `tool-input-available`, **`tool-approval-request`** (cycle 65), `tool-output-available`\|`-error`\|`-denied`, `data-subagent`, `message-metadata` for usage, `start`/`finish`/`error`/`abort`, …) |
| `user-message` | `{type:'user-message', turnId, message: UIMessage}` | The turn's user message (STT text for voice, or the typed text + attachment file parts), sent **once**, before that turn's `chunk`s |
| `audio-begin` | `{type:'audio-begin', turnId, segmentId, sampleRate}` | **Gains `turnId`** (cycle 64) — closes the barge-in ambiguity where no frame named whose turn a segment belonged to; a segment from a superseded turn is now discarded outright by `turnId`, not just by `playback-epoch.ts`'s stale-segment check |
| `persisted` | `{type:'persisted', conversationId}` | **Cycle 68 fix wave.** This turn's rows are committed — sent right after `appendMessages` returns, on **every** turn (success and rescue paths both), and the page's post-turn re-read is armed by it. `ws.ts` sets its `persisted` flag *before* sending, so a send to a socket that closed mid-turn cannot unwind into the rescue and append the same turn twice |
| `audio-end` / binary PCM / `state` / `approval` / `approval-resolved` / `conversation` / `error` | unchanged | See [voice-agent.md](voice-agent.md) for the full audio/state/approval frame list |
| ~~`transcript`~~ / ~~`reasoning`~~ / ~~`tool`~~ / ~~`usage`~~ | — | **Removed.** Superseded by `chunk`'s `text-delta`/`reasoning-delta`/`tool-*`/`message-metadata.usage` |

`turnId` is assigned once per scheduled turn (`ConnState.turnSeq`) and stamped on every frame of that turn, including `audio-begin` and `chunk`. The client (`createClientTurns`, `app/lib/agent/turn-stream.ts`) drops any frame whose `turnId` is older than the current turn, and treats a NEWER `turnId` as an implicit interrupt of whatever was active — the aborted turn's queued frames can still arrive after `{type:'interrupt'}` is sent, and this is what keeps them from corrupting the new turn's message.

**Replacing the message list (`discard()`, cycle-64 fix wave).** `interrupt()` closes a turn but still upserts its closing "stopped" snapshot — right for Stop/barge-in, wrong when the page has just **replaced** `messages`. `ClientTurns.discard()` (exposed as `useVoice().discardTurn()`) closes the active turn, marks it closed so its later frames are dropped, and suppresses every further upsert from any turn whose assembler is still draining, finalize included. `newConversation()` calls it instead of `interrupt()`, and the page calls it in `resume()` and `retryTurn()` right before assigning the new list — before this, the old thread's partial reply reappeared in the new thread, a running turn streamed into a resumed thread, and retrying a still-streaming reply re-pushed the message the truncation removed. A chunk the assembler rejects is logged (`[agent] turn N: message stream error`) and later chunks of that turn are dropped rather than throwing inside the socket's `onmessage`. Known window (documented at `interrupt()`): with no active turn, Stop closes the newest turn the client has *seen*, so a Stop before turn N's first frame lets N's first frames through until the server's abort closes it.

**`error` after `finish`.** `ws.ts` finishes the message **before** persisting, so a `createConversation`/`appendMessages` failure calls `turnStream.error()` on an already-closed stream. `error()` gates only the `error` **chunk** on the message still being open; the legacy `{type:'error'}` + `{type:'state', state:'idle'}` frames always go out, so the page alert still fires.

`{type:'usage'}` no longer exists as its own frame: usage now rides the SDK's `message-metadata` chunk (`{type:'message-metadata', messageMetadata:{usage:{...}}}}`), lifted client-side into `AgentUIMessage.metadata.usage` for the message-actions row. A later `message-metadata` **replaces** the earlier one (same overwrite semantics `ws.ts`'s `emit` closure already applied) — verified against the real assembler that no extra part appears in `parts`.

**`MessageUsage` gains `contextTokens?` and `modelDefId?` (cycle 65)** — additive jsonb on `conversation_messages.usage`, no migration. `runAgent` tracks the **last** `finish-step` part it sees (the forced-final follow-up tracks its own and **supersedes**, matching the existing overwrite-not-accumulate rule) and reports that step's input+output as `contextTokens`, plus the `modelDefId` of the model that actually produced the stream — which it can only know because `reasoningChain(modelDefId?)` (`server/lib/agent/model.ts`) now returns `{model, modelDefId}[]` instead of bare model instances. `ui-stream.ts` builds the usage metadata from **defined fields only**, so an absent field is omitted rather than serialized as `undefined`. This is what feeds the [context meter](#context-meter-cycle-65).

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

## UI — the two-panel surface (cycle 65)

`app/pages/agent/index.vue` (plus `app/pages/agent/history.vue`). `/voice` redirects to `/agent` (routeRules). The WS **auto-connects on mount** (no mic) so the chat is usable immediately — **there is no Connect button**; just type and send.

Cycle 60 made this three `UDashboardPanel`s (threads / conversation / Bridget). **Cycle 65 removed the third.** Two panels now:

| Panel | Sizing | Contents |
|---|---|---|
| `agent-threads` | `resizable`, default 14 %, min 10 / max 24; `hidden lg:flex` | `AgentThreadRail` — New button, search, threads grouped Today / Yesterday / date |
| `agent-conversation` | `grow` | `AgentToolbar` header, `AgentConversation`, `AgentMicBand` (while the mic is on), `AgentPromptInput` |

**Why the Bridget column went.** It existed to hold the cycle-60 three.js particle head, which was never finished (the CC0 MakeHuman export it needed was blocked on a human and never happened) and which Tony had already rejected on looks. Cycle 65 deleted the whole subsystem — `Avatar.client.vue`, `app/lib/avatar/**`, `app/lib/viz/**`, the Blender export + bake scripts, `app/assets/head-points.bin`, the `bake:head` package script and the viz event channel in `useVoice` — and replaced the face with a Rive **Persona** that lives *inside* the conversation column. `three` stays in the app: Galaxy still uses it.

**Responsive.** The rail carries `hidden lg:flex` and becomes a `USlideover` under `lg`; the conversation takes the full width (the cycle-60 fix for the composer measuring `0×0` below 1024 px still holds — that class must never go back on the conversation panel). Below `sm` the composer's model select and context meter fold into a PromptInput `…` action menu; the inline Persona, attach, speak, mic and send/stop stay visible. Verified at 375 px in light and dark: `scrollWidth === clientWidth === 375`, composer 373×64, no horizontal overflow, and full-bleed voice mode fits at 375×750.

**One toolbar (`app/components/agent/Toolbar.vue`).** Carries the **current thread title** (falling back to "Bridget"), a full-screen (voice mode) button, an `lg:hidden` threads button, and an `#actions` slot the page fills with `AgentSettingsSlideover`. **Cycle 65 moved the voice-replies switch and the reasoning-model selector OUT of it and into the composer** — which also retires the cycle-60 `hidden sm:flex` workaround that kept them from pushing the toolbar off-screen at 375 px. Voice replies is still mirrored in `AgentSettingsSlideover`, bound to the same `agent-speak` cookie ref (one source of truth, no drift).

### The Persona (cycle 65)

`app/components/agent/Persona.client.vue` (`AgentPersona`) wraps AI Elements' `Persona`, which renders a [Rive](https://rive.app) animation through `@rive-app/webgl2`.

- **`.client.vue` is load-bearing.** It guarantees exactly one Rive canvas per placement, never SSR'd and never a hidden duplicate instance.
- **Three placements, one at a time**, via a `size` prop: `hero` (`size-40`, the empty thread), `inline` (`size-7`, the composer footer, shown once the thread has messages) and `full` (voice mode, `h-full max-h-72 sm:max-h-96 aspect-square` so it shrinks with its wrapper on a short viewport instead of overflowing). The empty state only renders its hero when the page is not in full-bleed, so opening voice mode on an empty thread does not mount two canvases.
- **State is derived, not stored.** `personaState(state, connected)` (`app/lib/agent/persona.ts`, pure + unit-tested) maps `VoiceState` → Rive state: not connected or `connecting` → `asleep`; `idle` → `idle`; `listening` → `listening`; `thinking | tool | typing` → `thinking`; `speaking` → `speaking`.
- **Variants: `obsidian` (default), `mana`, `opal`, `glint`.** Picked in `AgentSettingsSlideover` and cookie-persisted with the other voice settings (`useVoiceSettings().settings.personaVariant`; an unknown or retired value normalizes to `obsidian`). Upstream also ships `halo` and `command` — **both were removed from the picker in cycle 65 because they render pure white regardless of theme** (their `dynamicColor` view model doesn't respond), i.e. invisible in light mode.
- **Assets.** Rive's **wasm** is served from our own origin through a Nitro `publicAssets` entry (`baseURL: 'rive'`, pointed at the `@rive-app/webgl2` package dir); `Persona.vue` calls `RuntimeLoader.setWasmUrl('/rive/rive.wasm')` before the first `new Rive`. The **four variants the picker offers** have their `.riv` files committed under `public/persona-riv/`, with the vendored sources map pointing at those local paths — cycle 65 chose to own them rather than depend at runtime on Vercel's blob host for the agent surface's core visual. The retired `halo`/`command` entries **still carry their upstream blob URLs** in `Persona.vue`; nothing can select them, so they are unreachable in practice, but they are the reason "no third-party fetches" is true of the shipped picker rather than of the file. **Naming trap:** the directory cannot be named `rive-*`. The wasm `publicAssets` entry's `rive` baseURL **prefix-matches**, so `public/rive-personas/*.riv` 404s.
- **Fallback.** On `loadError` (unreachable `.riv`, no WebGL2, …) the component renders a CSS disc (`rounded-full bg-primary/20`, pulsing for the active states) and warns **once per page load** via a module-scoped latch in `persona.ts` — not once per mounted instance. Proven by 404ing every `.riv` in the browser: zero canvases, the disc, exactly one `[persona] falling back:` line.

### Composer — `AgentPromptInput` (cycle 65)

`app/components/agent/PromptInput.vue` replaces `app/components/voice/Composer.vue` (deleted). Built on Elements' `PromptInput` via `usePromptInputProvider({accept, maxFiles, maxFileSize, onSubmit, onError})`.

- **Textarea:** Enter sends, Shift+Enter inserts a newline, `e.isComposing` guards an IME commit.
- **Attachments:** picker, drag-drop (`global-drop`) and paste, with the old composer's rules unchanged — images, PDFs and text types, ≤ 20 MB each, max 4. On submit each file is uploaded exactly as before (`/api/upload` for images, `/api/agent/files` for other files) and the resulting `AttachmentRef[]` goes to `sendText`. A rejection propagates so the provider restores the text, **keeps** the files for retry, and toasts.
- **Footer, left to right:** inline `AgentPersona` → attach → model select (`"Default (chain order)"` + the reasoning-assigned models, same `agent-model` cookie and `__default__` sentinel as cycle 45) → speak toggle → `AgentContextMeter`. Right: mic toggle, then **Stop** while busy instead of Submit.
- **Two submission invariants, both learned the hard way:**
  1. `filesForSubmit(submittedIds, currentFiles)` (`app/lib/agent/attachments.ts`) resolves the *submitted snapshot's* ids against the live tray, so a file dropped during `submitForm`'s async blob→dataURL conversion is not swept into the in-flight turn and left looking unsent.
  2. The vendored `prompt-input/context.ts` `submitForm` starts with `if (isLoading.value) return` — a **MyMind patch, recorded in-file**. `isLoading` is set synchronously before the first `await`, so a second synchronous submit bails before `onSubmit`/`clearSubmittedFiles`/`isLoading`. The guard has to live in the vendored provider, not in `AgentPromptInput.onSubmit`: a caller-side guard still let the raced `submitForm` clear in-flight files and flip `isLoading` for the call that still owned them.
- **`?q=` hand-off:** `initialText` + `autoSend` auto-submit once per distinct value (the old `autoSentText` guard), and `prefill` (starter clicks) only ever fills the box. **The page must hand `initialText` over AFTER the composer has mounted** — `app/pages/agent/index.vue` holds it in `handoffText` and assigns it at the end of its own `onMounted`, after `connect()` + `loadAiConfig()` + `setModel()`. A value present during *setup* submits before the model override is applied (so `?q=` runs on the default chain, not the picked model) and before the textarea subtree exists, and `submitForm`'s clear then never reaches the DOM — `ui/textarea`'s `useVModel(..., {passive:true})` proxy is seeded from the pre-clear value, so the provider reads `''` while the box still shows the sent question.

### Slash commands (cycle 71)

A `/` typed at the **start** of an empty composer opens a command menu, the way Claude Code and claude.ai behave. One flat namespace, three sources, precedence **code > prompt > skill**:

| Kind | Where it comes from | How it runs |
|---|---|---|
| `client` | `CLIENT_COMMANDS` in `shared/types/commands.ts` | client-side behaviour — `/clear`, `/new` |
| `prompt` | `prompt_commands` table (migration `0052_exotic_wendigo.sql`) | the template expands **client-side** into the message text |
| `skill` | MyMind skill documents | the name rides the WS frame; the **body loads server-side** into the assembled context |

It is **`/browser-testing`, not `/skill browser-testing`** — a skill is a first-class command name, so there is no second trigger to learn.

**Why the two halves run in different places.** A prompt command is *text the user is sending*, so expanding it client-side keeps the composer, the persisted transcript and the model in agreement, and a fork/edit of that turn replays correctly. A skill body is *instruction the agent needs* and can run to thousands of characters; putting it in the message would pollute the transcript, the conversation title and every later summary. So `PromptInput.vue` passes the skill **name** as the 4th argument of `sendText` → `useVoice.sendText` → the WS frame `{type:'text', …, skill}` → `ws.ts` closes over it in `buildMemoryContext` → `assembleContext({…, skill})` pushes the body as a **fixed tier, first**, ahead of resident/live/summary. Audio turns never set it — there is no way to speak a `/`-command, by design.

**Pieces.** `server/lib/commands/merge.ts` is the pure precedence merge (a surviving entry carries `shadows?: CommandKind[]` naming the kinds it beat; a same-kind guard stops an entry shadowing itself). `server/services/commands.ts` merges the three sources and `GET /api/agent/commands` is a 5-line handler over it. `app/lib/agent/slash.ts` holds the trigger rules as pure functions — `shouldOpenMenu` (`/^\/[^\s]*$/`, so a `/` mid-text is just text), `applySelection`, `nextHighlight` (wrap-around), `shouldInterceptEnter`. `useCommands` caches on `['agent','commands']`, which `app/utils/live-dispatch.ts` refreshes on any `document` change — so creating or renaming a skill updates the menu live.

**The menu is a plain `<ul role="listbox">`, deliberately.** shadcn-vue's vendored `Command`/`CommandItem` gate item visibility on a `filterState` that only `CommandInput` populates, and the composer's own textarea *is* the input — so mounting `CommandInput` was never an option and the menu rendered nothing without it. That cost three fix rounds before the wrapper was dropped. Don't reach for it again here.

**Keyboard.** `PromptInputTextarea.vue` declares a `keydown` emit and its Enter branch checks `e.defaultPrevented`, so the menu can claim Enter without the composer also sending. With the menu open: Enter selects, ↑/↓ wrap, Escape dismisses **and keeps the typed text**. Shift+Enter always inserts a newline and never selects.

**Skill bodies are capped.** `SKILL_TIER_MAX_CHARS = 8000` in `server/lib/agent/assemble.ts`; `capSkillBody` keeps head and tail with a `"\n\n…\n\n"` joiner **counted against the cap** (halving and then adding the joiner back returned 8005 for an 8000 cap — fixed). This matters because `fitBudget`'s fixed tiers are **all-or-nothing**: if they overflow the budget together, `assembleContext` drops *every* one of them, including the skill the user explicitly named. `listResidentMemories` is capped the same way (`RESIDENT_MEMORY_LIMIT = 40`, most-retrieved first) for the same reason.

**No UI for `prompt_commands` yet** — rows are insert-only via SQL. The table, service and merge are built and tested.

### Inline exec approvals (cycle 65)

The detached `agent/ApprovalPrompt.vue` banner is **deleted**. An approval is now part of the tool it belongs to:

- **Server.** `ApprovalRequest` gains `callId` (from `opts.toolCallId` in `ai-tools.ts`); `VoiceEvent` gains `{type:'approval-request', approvalId, callId, name}`; `ws.ts` keeps a connection-scoped `ConnState.activeTurn` so `requestApproval` — which fires from inside `exec`, deep under the turn — can emit into *that* turn's stream. Turns are serialized by `s.lock`, so the turn calling `requestApproval` is always the active one. `createUIChunkEncoder` maps it to the SDK's `tool-approval-request` chunk, first emitting `tool-input-available` if that call was never opened. Allow-listed calls emit nothing (unchanged).
- **Client.** The part's state becomes `approval-requested`, and `app/components/agent/ToolPart.vue` renders `AgentApprovalConfirmation` (Elements `Confirmation`) as a sibling of `ToolHeader` **inside** the `Tool` card, visible whether or not the card is expanded: "Run this?" with the command, a **remember** checkbox and an **editable** always-allow pattern seeded from `proposedPattern`, then Deny / Approve → `voice.sendApproval(requestId, approved, {remember, pattern})` (unchanged API). Details come from `voice.pendingApproval` matched on `part.approval.id === requestId`; if that frame is missing it degrades to "Approve `<toolName>`?" with the input JSON and still works.
- **Stop.** `finalizeMessage` (`app/lib/agent/turn-stream.ts`) treats a dangling `approval-requested` part as `output-error` with `errorText: 'Stopped'` — so the badge reads **Error** and the body reads **Stopped**. The server side of Stop is in [WS protocol](#websocket-protocol-serverapivoicewsts) above.

### Context meter (cycle 65)

`app/components/agent/ContextMeter.vue` (`AgentContextMeter`) — Elements `Context`/`ContextTrigger`/`ContextContent`, with the cost rows patched out (**no `tokenlens` dependency**; we already have LiteLLM prices in analytics and didn't want the catalog's bundle weight).

`contextMeterData(messages, models, [selectedOverride, chainHead])` (`app/lib/agent/context-meter.ts`, pure + unit-tested):
- `usedTokens` = the latest assistant message's `metadata.usage.contextTokens`.
- `maxTokens` = the `contextWindow` of `usage.modelDefId`, else the selected override, else the reasoning chain head.
- **No usage yet → the meter is hidden entirely.** An old thread resumed from before cycle 65 has no `contextTokens`, so the meter stays hidden until that thread's next turn produces one.
- **Known window** → a ring + percentage; the hovercard shows `<pct>% · <used> / <max>`.
- **Unknown window** (the model has no `contextWindow` set) → the token count alone, with a "set one in Settings → Models" hint. Deliberately no ring and no percentage — an earlier build rendered `0%` and `1.8K / 0`, which is a fabricated number.

**`ModelDef.contextWindow: number | null`** is where the denominator comes from — registry `types.ts`/`schema.ts` (`z.number().int().positive().nullable().default(null)`)/`resolve.ts`, the client `DraftModel`, and a "Context window (tokens)" field in `app/components/settings/ModelForm.vue` (`/settings/models`). Local Qwen isn't in any public catalog, which is why this is a manual per-model field rather than a lookup. Note `server/api/settings/ai-config.put.ts` carries its **own** zod body schema — a new `ModelDef` field must be added there too or the PUT silently strips it.

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

Retry/copy/timestamp/token-count moved onto `app/components/agent/ReplyActions.vue` (ported from the old `MessageActions.vue`, now deleted, keyed off `AgentUIMessage` instead of `TranscriptEntry`) — see [The message action row](#the-message-action-row-cycle-68) for what it holds today. **`app/lib/agent/retry.ts` and its test are deleted (cycle 68)**: `truncateForRetry` existed to cut the thread back to the retried turn, and retry no longer truncates anything — it branches. The undo flow is unaffected. Scrolling (stick-to-bottom + a scroll-to-bottom button) and markdown streaming now come from Elements' `Conversation`/`ConversationContent`/`ConversationScrollButton` (`vue-stick-to-bottom` under the hood) — the cycle-41 `ResizeObserver`/`suppressScrollUntil`/content-signature plumbing this replaced is documented in the cycle-60 handover for history but no longer exists in the tree.

- **Empty state (`app/components/agent/EmptyState.vue`).** A **hero Persona**, Bridget's name, one line on what she can reach, and four starter prompts on Elements' `Suggestions` (cycle 65; the prompts themselves are unchanged and still drawn from the real tool surface). A starter click fills the composer through a dedicated `prefill` prop and never sends — deliberately separate from `initialText`/`autoSend`, the fire-once-per-value `?q=` handoff from Home. The hero is suppressed while full-bleed voice mode is open, so only one Rive canvas is ever mounted.
- **The token bridge for Elements' own state.** `app/components/agent/ToolPart.vue` reads `part.state` (`input-streaming`\|`input-available`\|**`approval-requested`**\|`output-available`\|`output-error`\|`output-denied`) directly off the AI SDK part — there is no separate client-side "is this tool still running" flag to drift from the stream; `isRunning()` (`app/lib/agent/render.ts`) is a one-line predicate over that same state, unit-tested.

> **Stop semantics (rename, cycle 60).** `useVoice`'s old `stop()` was a *full teardown* (VAD + WS + AudioContext) and is now `disconnect()`; `stop()` aborts only the running turn (`{type:'interrupt'}`) and leaves the socket up. The composer shows **Stop** instead of Submit while `busy` — `state ∈ {thinking, tool, speaking, typing}`; `listening`/`connecting` are client-only states, not generation.

### Full-bleed voice mode

The toolbar's full-screen button (Escape to leave) covers the panels with a fixed overlay: **`AgentPersona size="full"`** (cycle 65 — it was the particle-head avatar), the mic band, and the current line as a caption. The Escape listener is on `window`, not the overlay, so it works even when focus never landed inside it. **The caption renders through `<MdView>`** with a per-message `cache-key` (`caption-${caption.id}`) — unlike the main conversation (cycle 64: Elements' `MessageResponse`/`vue-stream-markdown`), this one small overlay still uses `MdView`/MDC (it is not part of the `AgentConversation` tree, just a `computed` over `voice.messages.value` picking the last non-empty message's text via `uiMessageText()`, `app/lib/agent/render.ts`). The old page interpolated `{{ caption.text }}` as plain text, so the most prominent text on the screen printed literal `#` and `**` — the visible twin of the TTS-pronounces-asterisks bug, fixed in cycle 60. The caption is capped (`max-h-40 overflow-y-auto shrink-0`): uncapped, a long reply at 375×700 pushed the mic band below the fold with no scroll path to it. The Persona is likewise clipped by an `overflow-hidden` wrapper and sized `h-full max-h-72 sm:max-h-96 aspect-square`, so at 800×340 it shrinks rather than pushing the caption and band off-screen. The two-panel chrome stays mounted underneath, so the conversation's scroll position survives the round trip. `MdView`'s cache-key-per-id rule (cycle 41, described in the cycle-60/61 handovers) still applies here for the same reason it always did: `<MDC>` keys its parse cache on the hash of the value frozen at setup, so two captions opening with the same token would otherwise share one parse record.

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
- ~~**Branching UI** (edit/regenerate → fork): the `parent_id` edge exists; `active_leaf_id`/path-walking + UI are future.~~ ✅ **shipped in cycle 68** — see [The conversation tree](#the-conversation-tree-cycle-68). Still out of scope there: branches on the thread rail, delete/merge/rename a branch, per-branch message counts, and branching the **first** turn of a thread.
- Storing voice **audio** (transcript text only), command-palette integration, multi-profile UI. (~~token-cost display~~ — a per-turn **token count** ships in the message-action row since cycle 60; a monetary cost figure does not.)
- **Per-row rename/delete on the thread rail** (cycle 60): the spec asked for a row context menu on the rail and it was **not built** — a genuine gap in that cycle's plan, deferred rather than grown into the largest task. Nothing is unreachable: both live on `/agent/history`, which the sidebar now surfaces.
- **Cost in the context meter** (cycle 65): deliberately not built. It would need `tokenlens`' catalog, and LiteLLM prices are already in analytics — the meter shows tokens against the window, never money.
- **An audio-reactive Persona** (cycle 65): the Persona is **state-driven only** (`idle`/`listening`/`thinking`/`speaking`/`asleep`). `useVoice` still exposes `micAnalyser()`, read by `AgentMicBand` alone. The TTS-playback analyser node stays in the audio signal chain but is **no longer exposed** — its only reader was the retired avatar's jaw envelope.
- **Subagents inheriting the composer's model override** — `research_web`/`search_brain` always resolve the default reasoning chain. Deliberate cycle-45 scope boundary; explicitly out of scope in cycle 65's spec. See [Subagents](#subagents-cycle-42).

See also: [voice-agent.md](voice-agent.md) (the self-hosted STT/TTS pipeline and the cycle-60 speech pipeline), [ai-providers.md](ai-providers.md) (model registry), [live-reactivity.md](live-reactivity.md), [web-research.md](web-research.md) (`web_search` + `web_fetch` tools, SSRF guard, SearXNG), [agent-exec.md](agent-exec.md) (approval gate + constrained exec, Cycle B2).
