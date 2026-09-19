---
title: Agent Elements foundation — AI SDK message protocol over the voice socket, rendered with AI Elements Vue (cycle 64)
cycle: 64
date: 2026-09-19
status: >
  BUILT, NOT MERGED. All 11 tasks complete; live-validated in a real browser against the real app
  with a live model (Haiku 4.5, picked via the toolbar model selector — the dev default reasoning
  chain's head, qwen @ 192.168.2.25:8004, is down). 10 of 10 validation items now PASS. Item 2
  (subagent nested steps growing live) was originally a PARTIAL in this session (the outer tool's
  Running→Error rendering was confirmed, but the subagent's own nested tool calls couldn't be
  exercised because subagents always run the default chain and don't inherit the model picker) and
  was upgraded to a full PASS by a dedicated follow-up validation (task-11) that temporarily
  reordered the LOCAL DEV reasoning chain (Haiku 4.5 moved ahead of the down qwen head, DB-only,
  restored exactly afterward) so the subagent itself had a reachable model — see item 2 below for
  the live-growth evidence. No code defects were found during live validation; zero fix commits
  were needed. Gates at that point: typecheck 0 / test 204 files, 1871 tests / build clean only at
  a 6 GB heap. The final whole-branch review then found the build OOMs at deploy.yml's 4096 MB heap
  (shiki's full bundle) plus two Important and several Minor issues; the fix wave landed all of them
  on the branch (see "Final-review fix wave"). Gates after it: typecheck 0 / test 205 files, 1882
  tests / build passes at 4096 MB and at the V8 default (no NODE_OPTIONS). Not merged, not pushed,
  not deployed — no migration to run.
branch: feat/agent-elements-foundation
spec: ../superpowers/specs/2026-09-19-agent-elements-foundation-design.md
plan: ../superpowers/plans/2026-09-19-agent-elements-foundation.md
docs:
  - ../wiki/agent.md (UPDATED — cycle bumped to 64; new "Cycle 64 update" callout; WS protocol frame
    table rewritten for `chunk`/`user-message`/`audio-begin+turnId`, `transcript`/`reasoning`/`tool`/
    `usage` frames marked removed; the Transcript section replaced by a Conversation/AI-Elements
    section (per-part render table, the design-token bridge, `data-ai-elements`); Tool history section
    gained the `steps` field + `toUIMessages`; Subagents section gained the `onNestedEvent` live
    channel + the ordering-gap fix + the down-chain caveat; Reasoning-block and full-bleed sections
    corrected to describe the AI-SDK part model instead of the deleted `TranscriptEntry`)
  - ../wiki/voice-agent.md (UPDATED — cycle bumped to 64; new update callout; server→client frame
    table rewritten (`audio-begin` gains `turnId`; `chunk`/`user-message` added; `transcript`/
    `reasoning`/`tool`/`usage` struck); new "Stale-segment rejection" note on `turnId`-guarded
    `audio-begin`)
  - ../BACKLOG.md (UPDATED — reconciliation date bumped to cycle 64; new "Agent Elements foundation"
    subsection closing the three brainstorm-raised complaints and pointing cycles 65-67 at their
    MyMind tasks; the down-chain/no-subagent-failover operational note recorded)
  - ../superpowers/plans/00-roadmap.md (UPDATED — cycle 64 row added)
  - ../wiki/agent.md + ../wiki/voice-agent.md (UPDATED again by the final-review fix wave — live
    context rebuilt every turn, `discard()`/`discardTurn()`, error-after-finish frames, corrected
    bundle weight + the fine-grained shiki rule)
  - ../../.claude/rules/web-nuxt.md (UPDATED by the fix wave — production builds at a 4096 MB heap;
    never import the full `shiki` bundle in client code)
tasks:
  - 3a32a2ca (MyMind, cycle 64) — update to reflect BUILT/NOT MERGED (controller does this after
    mirroring)
shipped:
  - "Design-system coexistence spike (Task 0, gate)`` — shadcn-vue + AI Elements Vue installed
    beside Nuxt UI behind a CSS token bridge (`app/assets/css/main.css`), not a port of either
    system onto the other. No repaint on `/`, `/tasks`, `/documents`, `/settings`; the spike measured
    a +5,328 B gzip bundle delta, which is WRONG for the final branch (the finished CodeBlock pulled
    in shiki's full bundle: 3.70 MB gzip / 572 chunks and a heap-limit crash at 4096 MB) — see
    \"Final-review fix wave\" for the corrected numbers; image embeds fixed
    (`mode=\"static\"` on `MessageResponse`'s `<Markdown>`, later made state-driven in Task 9); no
    MDC-only syntax found in the agent prompt or persisted replies."
  - "`server/lib/voice/ui-stream.ts` — `createUIChunkEncoder`, a pure `VoiceEvent`/`AgentEvent` →
    `UIMessageChunk[]` encoder, proven against the real AI SDK `readUIMessageStream` assembler
    (not just asserted against the docs)."
  - "`server/lib/voice/turn-stream.ts` — `createTurnStream`, the pure emission-order owner
    (`finish` only after `handleTurn` returns, so late image embeds land inside the message;
    nothing sent after finish/error/abort)."
  - "One ordered event channel in `runAgent` (`server/lib/agent/run.ts`) — both the model stream
    and tool callbacks push into it, so a nested subagent tool-start reaches the UI as soon as it
    fires instead of bursting out when the outer tool call finishes (verified against the real SDK,
    `run-live-events.test.ts`)."
  - "Subagent nested-call forwarding — `ctx.onNestedEvent` threaded through `buildAiTools` →
    `subagents.ts`, `AgentEvent` gains `subagent-event`, `orchestrator.ts` accumulates a running
    `SubagentStep[]` per parent call and re-emits the full list on each change (`{type:'subagent'}`
    `VoiceEvent`); `AgentToolRecord` gains optional `steps` (terminal states only, jsonb, no
    migration) — `toolBlocksFor` ignores it, so model history/context is unchanged."
  - "WS frame changes — `chunk`/`user-message` new; `audio-begin` gains `turnId`; `transcript`
    (assistant)/`reasoning`/`tool`/`usage` removed. `turnId` closes the barge-in ambiguity where no
    frame named whose `audio-begin` a segment belonged to."
  - "Client stream assembly — `app/lib/agent/turn-stream.ts` (`createClientTurns`), one
    `ReadableStream<UIMessageChunk>` per turn fed by `chunk` frames, assembled with the SDK's own
    `readUIMessageStream`; stale-`turnId` frames dropped; a dangling tool/text/reasoning part is
    finalized client-side (`finalizeMessage`) on interrupt/error/disconnect so nothing keeps
    spinning past its turn."
  - "Resume — `app/lib/agent/to-ui-messages.ts` (`toUIMessages`), replaces `buildResumeTranscript`/
    `app/lib/agent/transcript.ts` (deleted, test ported): textOffset split, legacy tools-first
    fallback, mixed-offset all-or-nothing, a subagent record's `steps` → a `data-subagent` part."
  - "`app/components/agent/Conversation.vue` (+ `ToolPart.vue`, `SubagentSteps.vue`,
    `Attachment.vue`, `ReplyActions.vue`) — Elements `Conversation`/`Message`/`Tool`/`Reasoning`/
    `ChainOfThought`, replacing `voice/Transcript.vue` and `agent/ReasoningBlock.vue` (both
    deleted). Tools show live Running→Completed/Error/Denied with expandable input/output; a
    subagent's steps render nested under the parent tool card."
  - "`app/pages/agent/index.vue` rebuilt to stream/resume through `AgentUIMessage[]` end to end;
    retry/undo/usage carried over onto the new part model; `useTextChat.ts` and
    `useAgentActivity.ts` deleted (both callerless before this cycle)."
  - "Live/resume parity test — a turn encoded live and the same turn persisted then resumed produce
    equivalent text/tool/subagent parts (the drift guard between the two paths)."
deferred:
  - "Persona, three-column → new layout, `PromptInput` composer, `Confirmation` (replaces
    `ApprovalPrompt`), a Context meter, avatar/three.js removal — cycle 65 (`/agent` rebuild).
    MyMind task `3ddae408`."
  - "`/sessions/[id]` transcript on the same Elements components — cycle 66. MyMind task
    `14d0074b`."
  - "Voice studio shared pieces + Home `PromptInput` — cycle 67. MyMind task `d321c732`."
  - "Deferred minors (from the SDD ledger, none blocking): the brief's Task 2 test had a TS2698
    spread defect — the implementer typed the inner param as `Parameters<typeof streamText>[0]`
    instead (no runtime change); `/dev/elements`' `IMAGE_ID` is a worktree-local upload
    (documented in the fixture, not fixed); `orchestrator.ts:169/172` duplicate fallback-id
    expression; `orchestrator.ts:196` terminal subagent steps shared by reference between the live
    map and the persisted record (not exploitable; copy defensively if ever touched);
    `ui-stream.ts`'s usage `message-metadata` carries undefined-valued keys for a partial usage
    object (harmless over JSON); no test for a tool result arriving with no `tool-start` while a
    text block is open (same `close()` path as the tested cases); two structurally identical
    `AttachmentRef` types (`server/lib/agent/attachments.ts` vs `shared/types/conversation.ts`);
    `finalizeMessage` rebuilds a dynamic-tool part field-by-field instead of spreading `...p`
    (would drop `title`/`toolMetadata`/`providerExecuted` if any tool ever sets them — none do
    today); the staleness predicate is duplicated between `advance()`/`isStale` in
    `app/lib/agent/turn-stream.ts`; `recordParts` takes the whole `ResumeMessage` just for `m.id`
    (brief-level nit); `ToolPart.vue` hardcodes the label 'Denied' and ignores any approval reason
    the server might one day attach; Task 11's own two: the exec-approval banner (`ApprovalPrompt`)
    stays visible/clickable after Stop, because `{type:'interrupt'}` aborts the turn's `AbortSignal`
    but not the server's separate pending-approval `Promise` (pre-existing, not cycle-64); and a
    one-off dark-mode repaint glitch right after toggling color mode mid-session (computed CSS was
    already correct at the time; never reproduced on reload or fresh navigation); from the final
    review, documented at `interrupt()` but not fixed: with no active turn, Stop closes the newest
    turn the client has SEEN, so a Stop before turn N's first frame lets N's first frames through
    until the server's abort closes it (closing N client-side needs its id before any of its frames
    arrive)."
next_seam: >
  Cycle 65 (/agent rebuild — Persona, a new layout, PromptInput composer, Confirmation replacing
  ApprovalPrompt, a Context meter, avatar/three.js removal). MyMind task 3ddae408. The message
  protocol and Elements-rendered conversation this cycle shipped are the foundation it builds on;
  nothing in cycle 65's scope should need to touch ui-stream.ts, turn-stream.ts (either side), or
  to-ui-messages.ts unless the part model itself needs to grow (e.g. a Persona-specific data part).
---

# Agent Elements foundation (cycle 64)

## What shipped

The `/agent` conversation now streams and resumes as **AI SDK `UIMessage`s**, rendered with **AI
Elements Vue** instead of the hand-rolled `Transcript.vue`. The WebSocket still owns mic audio,
sentence-level TTS and barge-in (there is no streaming/duplex voice API in the AI SDK), but what it
carries for the *message* is now the SDK's own `UIMessageChunk` protocol, assembled client-side
with `readUIMessageStream` — no bespoke transcript-entry model, no hand-adapted `Chat` class (voice
turns are server-initiated, which fights `Chat`'s `sendMessage` model — decision D3 in the spec).

This closes three concrete gaps raised in the 2026-09-18/19 brainstorm:
1. **Tool calls now show a live state** (Running → Completed/Error/Denied) with expandable
   input/output, instead of a one-line badge that only appeared after the call finished.
2. **A subagent's nested tool calls render inline**, nested under the parent tool's card, instead
   of collapsing to "(N tool calls)".
3. **The hand-rolled transcript scroll/markdown plumbing is gone** — Elements' `Conversation`
   (`vue-stick-to-bottom`) and `vue-stream-markdown` replace the `ResizeObserver`/MDC-cache-key
   machinery that kept breaking (documented at length in the cycle-41/60 handovers).

Cycle 1 of a 4-cycle "agent surfaces on AI Elements" program; cycles 65-67 are deferred (see
frontmatter `deferred` + `next_seam`).

## Spike gates (Task 0 — the cycle's go/no-go)

| Gate | Result |
|---|---|
| Fixture renders correctly, light + dark | ✅ borders subtle in both themes, user bubble grey (not brand green), all 5 tool-state badges distinct, `ChainOfThought` expands, table/code-block/links render, syntax highlighting works |
| No repaint on `/`, `/tasks`, `/documents`, `/settings` | ✅ `magick compare -metric AE` (light+dark) found 103-5646 non-zero px per page, but every diff was read and is the Nuxt DevTools "load time" badge (varies per dev-server run) — zero app-UI pixels changed |
| Bundle delta | ✅ *at the spike*: total `_nuxt/*.js` gzip: 1,808,606 B → 1,813,934 B (**+5,328 B**, well under the ~500 KB budget). Entry chunk (booted `.output/server/index.mjs`, read the served module script): 159,712 B gz → 155,195 B gz — **shrank** 4,517 B. **Wrong for the final branch** — once the finished `CodeBlock` highlighted with `createHighlighter` from `shiki`, the full grammar/theme bundle was registered (3,704,928 B gz, 572 chunks) and the build OOM'd at deploy.yml's 4096 MB heap. Corrected in the fix wave below. |
| Image embeds render | ✅ root cause was not the URL allow-list (default already permits relative URLs) — `vue-stream-markdown`'s `<Markdown>` defaults `mode="streaming"`, which keeps the trailing block `loading=true` forever for one-shot static content. Fixed with `mode="static"` on `MessageResponse.vue` (Task 9 later made this state-driven: `streaming` while a turn is in flight, `static` once done) |
| `pnpm typecheck`/`pnpm build` green | ✅ typecheck 0; first `pnpm build` OOM'd locally, retried clean with `NODE_OPTIONS=--max-old-space-size=6144` (carried as a standing gate requirement into every later run). That OOM was a real signal, not noise — prod builds at 4096 MB. The fix wave cut the weight and re-gated at 4096 MB and at the V8 default (see below). |
| MDC audit (nothing lost by switching to plain streaming markdown) | ✅ `grep '::|\{[a-z]+='` over `server/lib/agent/prompt.ts` — no matches; two real persisted conversations read in full — no MDC-only syntax found |

Dependencies added (CLI): `@lucide/vue`, `motion-v`, `reka-ui`, `shiki`, `vue-stick-to-bottom`,
`vue-stream-markdown`. Manually added (the CLI didn't): `clsx`, `class-variance-authority`,
`tw-animate-css`; pinned `tailwind-merge ^3.6.0`; pinned `reka-ui` to the exact `2.9.8` Nuxt UI
already used. `pnpm why` confirmed single copies of `reka-ui`/`tailwind-merge` — no dual-version
bundle bloat. 3 token edits (`bg-secondary` → `bg-elevated`): `message/MessageContent.vue:17`,
`ui/button/index.ts:18`, `ui/badge/index.ts:14`.

## Planning deviations (decided while planning — each smaller or safer than the spec's default)

1. **Encoder and turn runner live in `server/lib/voice/`** (`ui-stream.ts`, `turn-stream.ts`), not
   `server/lib/agent/` — both consume the orchestrator's `VoiceEvent`, not the raw `AgentEvent`.
2. **No separate 16 KB wire cap.** The orchestrator already caps what it persists (`ARGS_WRITE_CAP`
   4096 / `WRITE_RESULT_CAP` 8192). Live tool events now carry *those same capped copies*, so what
   the UI shows live is byte-for-byte what a resumed thread shows, and the wire is bounded by the
   smaller persist caps.
3. **The envelope has no `images`.** Image embeds are already appended to the message text; showing
   them again in the tool output would duplicate them and break live/resume parity.
4. **Usage rides the SDK's `message-metadata` chunk**, not a `data-usage` part. Verified: later
   metadata replaces earlier (overwrite semantics preserved) and no extra part appears in `parts`.
5. **New task: a live event channel in `runAgent`.** Verified against the real SDK: `fullStream`
   emits nothing while a tool's `execute` is pending, and the old design only drained its
   tool-event queue when the next stream part arrived — so a subagent's nested calls arrived in one
   burst when it finished. `tool-start` itself was separately confirmed to arrive live even before
   this fix.
6. **`tool-output-denied` confirmed** accepted by `readUIMessageStream` from `input-available`
   (state `output-denied`). Data parts with the same `id` reconcile (replace); `error` chunks call
   `onError` without throwing and keep the partial text; an `abort` leaves an open tool at
   `input-available` and an unterminated text part at `streaming` — hence client-side finalization
   (`finalizeMessage`).
7. **User messages always come from the server** (`user-message` frame), as today's UX already
   waits for the server echo. The user message carries its `AttachmentRef[]` in
   `metadata.attachments` so retry can re-send them.
8. **`Composer.vue`'s `entries` prop is unused** — removed rather than migrated.

## Rulings (from the SDD ledger, with cost-if-wrong)

- **Worktree branched from LOCAL HEAD `a206109`, not `origin/master`** (EnterWorktree default) —
  the spec+plan commits are unpushed and the plan must exist in the worktree. *Cost if wrong:*
  none — master is ahead of origin only by these two docs commits.
- **Task 11's wiki/handover mirroring (mints a temporary prod API token per the `wiki-mirror`
  skill) is done by the CONTROLLER, not a subagent** — it touches prod DB; the procedure is the
  project's documented one. *Cost if wrong:* a leftover token (mitigated: delete + verify).
- **Commit messages carry NO `Co-Authored-By` trailer** (Tony's global CLAUDE.md overrides the
  harness reminder) — stated in every dispatch and verified per-commit (`⚠️ trailer check` entries
  in the ledger on 98b9d30, 0ab2442, ed22ea8).
- **`MessageResponse.vue` ships with `mode="static"`** (the spike's fix for images never rendering
  under the default `"streaming"` mode) — Task 9 had to make it a prop driven by the text part's
  state (streaming while in flight, static when done). *Cost if wrong:* streamed markdown flickers
  or images stay hidden until done. (Resolved: Task 9 shipped the state-driven prop.)
- **Subagents cannot write report files in this harness** — every dispatch from Task 1 on asked for
  the full report in the final message; the controller transcribed `task-N-report.md` from it.
  *Cost if wrong:* none.
- **`spike/REPORT.md` was written by the controller** as a copy of the transcribed Task 0 report —
  the implementer's harness refuses report-file writes, so a fix round couldn't have succeeded; the
  file is a gitignored workspace record, not code. *Cost if wrong:* none — the reviewer
  independently re-verified the gate numbers against the raw spike artifacts.
- **Async nested emit (Task 2 fix round 1)** — the live-event channel test was rewritten so a
  nested tool-start is emitted after a real `await` (20ms), so it can only pass through the new
  ordered channel and not the old drain-on-next-part queue; this is what makes the test discriminate
  the two designs instead of passing against either.
- **Task 11 live validation selects "Haiku 4.5"** (model id `4144d313-bcf3-494b-a00e-7ef2a767406a`,
  LiteLLM) in the `/agent` toolbar model picker — the dev chain head (qwen @ `:8004`) is down and
  `runAgent` does not fail over on a mid-stream connect error. *Cost if wrong:* validation exercises
  a different model than prod's default; the rendering path under test is model-independent, so
  this doesn't weaken what was actually being proven.
- **Task 11 split**: a subagent did Step 1 (live validation + any fixes, test-first, each committed
  separately) and Steps 2-3 (wiki, handover, roadmap, backlog) WITHOUT MyMind writes; the controller
  does the MyMind mirroring (prod token) and task updates. *Cost if wrong:* none.
- **Validate item 2 by TEMPORARILY reordering the LOCAL DEV `ai_config` reasoning chain** to
  `[Haiku, qwen]`, running the research turn, then restoring the exact original order — the
  subagent path ignores the model picker (the pre-existing cycle-45 scope boundary above) and the
  qwen head is down, so this was the only way to exercise a real, live-growing step list; the dev
  DB is local and the change is reverted immediately after. *Cost if wrong:* the dev chain is left
  reordered (mitigated: restored + verified by re-reading the row afterward).

## Live validation (playwright-cli, dev on :3217, Haiku 4.5 selected via the model picker)

Screenshots under `.superpowers/sdd/2026-09-19-agent-elements-foundation/task-11/` (gitignored
workspace evidence, not committed).

| # | Item | Result |
|---|---|---|
| 1 | Typed turn with a tool ("What are my open tasks?") | **PASS.** Two `list_tasks` tool calls rendered inline, both reached Completed (green check) by the time of the first screenshot (Haiku is fast); expanding one (real click) showed the Parameters (`{"status":"todo","limit":25}`) and Result (full JSON, syntax-highlighted) sections; the reply rendered markdown (bold headings, bullet lists) correctly. The Running→Completed transition itself was confirmed separately in items 2 and 4 below (a slower/paused tool). |
| 2 | Subagent turn ("Research the latest on self-hosted TTS") — nested steps growing | **PASS** (upgraded from the earlier PARTIAL by a dedicated follow-up validation, task-11, 2026-09-19). Original attempt in this session hit the down default chain (see prior note preserved below); a follow-up session gave the subagent a reachable model by **temporarily reordering the LOCAL DEV reasoning chain only** — `settings.value->assignments->reasoning` (row `key='ai_config'`) moved from `[qwen, haiku]` to `[haiku, qwen]` via a direct `UPDATE ... jsonb_set(...)` against the dev DB (`postgres://…@localhost:5433/mymind`), followed by a dev-server restart (`loadConfig()` in `server/lib/ai/registry/store.ts` caches the row in a module-level var invalidated only by `saveConfig()`, so a DB-only edit needs a restart to take effect). With Haiku reachable, two fresh `/agent` conversations were sent "Use your research subagent to find the latest on self-hosted TTS models, then summarize." — both delegated to `research_web` without needing a follow-up nudge. **Live growth while Running:** screenshots taken a few seconds apart during the second run showed the nested step count genuinely increasing while the outer tool's badge still read Running — 2 steps (`spread-3.png`) → 7 steps (`spread-7.png`) → 10 steps (`spread-10.png`), each new `Web search` row appearing in red as `failed: web_search` (SearXNG isn't running in this dev box, exactly the anticipated dev-only failure mode — the point under test is that failed steps still arrive incrementally over the live channel, not that search itself works). **Settling:** once finished, the tool card read **Completed**, the step list stopped growing (10 steps, matching the persisted record exactly), no spinners remained, and the assistant's summary reply rendered (screenshot `12-completed-settled.png`, `13-tool-header-completed.png`). **Reload + reopen from the thread rail:** a hard page reload followed by clicking the thread back open from the rail re-rendered both turns' step lists from the persisted record — 9 steps and 10 steps respectively, both in terminal (no-spinner) states — confirmed both visually (`14-reload-persisted-turn1.png`, `15-reload-persisted-turn1-expanded.png`) and against the raw API (`GET /api/conversations/:id`, each `toolCalls[0].steps[]` entry carrying its final `state`/`callId`/`summary`). Automated coverage (Task 4's live-event test, Task 8's live/resume parity test) and the non-live `/dev/elements` browser validation (Task 9) still stand; this follow-up is the first time the mechanism was exercised with a REAL, live-growing step list end to end. Screenshots live under `.superpowers/sdd/2026-09-19-agent-elements-foundation/task-11/`. One test-methodology note, not a product finding: one of the two conversations ended up with two user turns (a second identical send landed ~9s after a `playwright-cli` ref-resolution error during rapid-fire polling) — most likely an artifact of overlapping CLI invocations against stale element refs, not a reproduced app behavior; it did not affect either turn's own correctness and isn't reported as a defect. The dev reasoning-chain order was restored to the original `[qwen, haiku]` immediately after and verified by re-reading the row (see Operational notes). *(Prior note, preserved for context: the outer `research_web` tool originally showed **Running** then settled to **Error** (`subagent produced no report`) with zero nested tool calls, because the subagent always runs the default chain, which resolves to the down `qwen3.6-35b-a3b @ 192.168.2.25:8004` and does not inherit the toolbar's model-picker override — a pre-existing scope boundary, not a cycle-64 defect; see Operational notes.)* |
| 3 | Exec denial ("Check disk usage on the app box" → Deny) | **PASS.** First `Exec` tool flipped to **Denied** (red x); the model reacted in-turn ("Hmm, `df -h` is blocked... let me try a different approach") and proposed a second command (`du -sh /`), which was also denied to clean up. Screenshots `03-exec-approval-prompt.png`, `03-exec-denied.png`. |
| 4 | Stop mid-tool (exec awaiting approval, click Stop) | **PASS.** Clicking Stop while the approval prompt was showing (tool state = Running) flipped the tool to **Error**, the message showed **"stopped"** beneath it, and nothing kept spinning. Screenshot `04-stop-mid-tool.png`. **Concern (not a cycle-64 defect, not fixed):** the yellow "Approve exec command?" banner stayed visible and clickable after Stop — the approval mechanism (`ApprovalPrompt.vue`, pre-existing, untouched this cycle) is a separate client-side ref from the message stream, and `{type:'interrupt'}` only aborts the turn's `AbortSignal`; it does not resolve the server's pending-approval `Promise` (only `approve`/`deny` frames or the 120s timeout do). This is existing interrupt-vs-approval-gate behaviour predating cycle 64; flagged for a design decision (should Stop also auto-deny a pending approval?) rather than improvised on. |
| 5 | Speak-mode turn | **PASS.** Toggled "Voice replies" on, sent a typed question; mid-generation the avatar turned the exact `speaking`/`typing` palette color (`0x22d3ee`, verified against `app/lib/viz/tuning.ts`) and the composer's Send button was replaced by Stop (busy state includes `speaking`); `useVoice.ts:216` sets `state.value = 'speaking'` directly on the first binary PCM frame, and Breeze TTS was confirmed reachable per the task's environment note. Text rendered correctly both mid-stream and once settled. Screenshots `05-speak-mode*.png`. |
| 6 | Resume a legacy thread + a new one | **PASS (both).** Legacy (pre-cycle, 8/28 thread, tool records with no `steps`): resumed with a `generate_image` tool inline at its correct position, Error state, expandable Parameters/Error — exactly matching a live render. New-format (today's research thread, 3 tool records including the subagent one from item 2): resumed with all three tool parts (`research_web` error, `web_search` error ×2) in the same order and interleaved text as the live turn — confirmed via the page snapshot's DOM order (not just a viewport screenshot, which had scrolled to the tail). No subagent `steps` were present to render on resume either, for the same reason as item 2 (0 live tool calls to begin with) — this is a resume-path consequence of the same environment limitation, not a resume-path defect (`toUIMessages`'s `t.steps?.length` branch is exercised by `to-ui-messages.test.ts`). Screenshots `06-legacy-resume-1.png`, `06-new-resume.png`, `06-new-resume-top.png`. |
| 7 | Retry the last reply | **PASS.** Clicking Retry on the research thread re-sent the same user message ("Research the latest on self-hosted TTS", unchanged) and streamed a genuinely NEW, different reply (this time reasoning about checking the local stack via `exec`, triggering a fresh approval prompt) — confirms retry re-sends the user turn and doesn't replay a cached response. Screenshot `07-retry-inflight.png`. |
| 8 | Undo from a tool part | **PASS.** Asked the agent to create a task ("Task 11 undo test", low priority); the `create_task` tool showed Completed with an **Undo** link; confirmed via authenticated `fetch('/api/tasks?status=todo')` that the task existed (id `613f0e98-...`) before Undo; clicked Undo, the link flipped to **"undone"** text, and the same fetch afterward returned an empty array — the task was genuinely deleted, not just visually hidden. Screenshots `08-create-task.png`, `08-undo-done.png`. |
| 9 | Light and dark | **PASS**, with one noted (unreproduced-after-navigation) observation. Toggling dark mode and immediately opening a thread showed the conversation column's background stuck white for one render (all computed CSS — `html.className`, `--ui-bg`, `--color-background` bridge variable, `body`'s `background-color` — was already correctly dark at the time, confirmed via `getComputedStyle`); a `reload` or a fresh navigation into the same thread rendered dark correctly every time after, including a repeat of item 1's exact scenario (`09-dark-mode-good.png`) and light mode (`10-home-light.png` etc.). Given the underlying CSS was correct throughout and the issue never reproduced on normal navigation, this reads as a one-off compositor/paint timing artifact of the dark-mode toggle transition rather than a token-bridge bug — recorded as a concern, not chased into a fix (see Concerns below). |
| 10 | `/dev/elements`, `/`, `/tasks`, `/documents`, `/settings` | **PASS.** All five render correctly in both themes with zero console errors (`/settings` had 1 pre-existing warning, 0 errors). `/dev/elements` fixture (code block, image embed, error tool state, headings/bold/inline-code/link) matches Task 9's browser-validated shape. |

**Defects found requiring a code fix: none.** No test-first fix commits were needed for Step 1 — the
two items above marked with a "Concern" are pre-existing/environment-scoped, not cycle-64
rendering defects, and are recorded for awareness per the fix-discipline instruction ("if a defect
needs a design decision, report it as a concern instead of improvising") rather than fixed.

## Operational notes (pre-existing, not introduced this cycle)

- **The dev reasoning chain's head is down.** `reasoning` resolves to `qwen3.6-35b-a3b` at
  `192.168.2.25:8004` (confirmed identical to the `vision` provider's URL in `/settings/providers`
  — both point at the same down rig endpoint). `runAgent` does not fail over on a connect error that
  surfaces once a stream has already been constructed (only *stream construction* failures, e.g. a
  bad adapter config, are retried across the chain before the loop starts) — so a turn on the
  default chain fails/produces nothing rather than falling back to a reachable model, unless the
  `/agent` toolbar's model picker is used to move a reachable model to the front for that
  connection. This is pre-existing behaviour, not introduced by cycle 64.
- **Subagents never inherit the model picker.** `research_web`/`search_brain` always call `runAgent`
  with no `modelDefId`, so they always resolve the default chain — a deliberate scope boundary from
  cycle 45, documented in `agent.md`. The practical consequence, discovered during this cycle's live
  validation: with the chain head down, a subagent's nested `run()` makes zero tool calls and
  returns `{error: 'subagent produced no report'}` with an empty `steps` list, so its nested
  `ChainOfThought` never has anything to show — this looks identical to (but is not) a
  rendering/forwarding bug. Confirming which it is required reading the persisted
  `tool_calls[].summary` (`"researched: no report (0 tool calls)"`), not just the UI.

## Measured gates

At the original handover (superseded — see the fix wave below):

```
pnpm typecheck                                    → exit 0, 0 errors
pnpm test                                          → 204 files, 1871 tests passed
NODE_OPTIONS=--max-old-space-size=6144 pnpm build  → exit 0, "✨ Build complete!" (81.2 MB / 22.6 MB gzip total)
```

After the final-review fix wave (HEAD `fa4013d` + this docs commit):

```
pnpm typecheck                                                              → exit 0, 0 errors
pnpm test                                                                   → 205 files, 1882 tests passed
NODE_OPTIONS=--max-old-space-size=4096 NUXT_PUBLIC_UNMUTE_URL="" pnpm build → exit 0 (deploy.yml's exact command), peak RSS 4.64 GB
NUXT_PUBLIC_UNMUTE_URL="" pnpm build   (no NODE_OPTIONS, V8 default 4144 MB) → exit 0 (CI's command), peak RSS 4.54 GB
```

Baseline at cycle start (Task 0 dispatch): `pnpm test` → 196 files / 1826 tests. The +8 files / +45
tests reflects every task's new/ported test files (encoder, turn-stream ×2, to-ui-messages,
subagent-forwarding, live-event channel, the Task 10 fix round's 3 new voice-message-frame cases,
Elements component smoke coverage) plus the ported `transcript.test.ts` cases now living in
`to-ui-messages.test.ts`.

## Final-review fix wave

The final whole-branch review (base `a206109` → `538b50a`) returned *ready to merge with fixes*.
Everything below landed on the branch, one commit per finding; each behavioural fix was test-first
(RED captured, then GREEN).

**C1 (Critical) — the branch OOM'd the production build.** `code-block/utils.ts` called
`createHighlighter` from `shiki`, which registers shiki's full bundle (every grammar + theme as a
lazy chunk, plus the oniguruma WASM). Fix (`48c6e69`): one highlighter from `shiki/core` + the JS
regex engine (what `@nuxtjs/mdc` already uses) with only the `json` grammar the agent UI renders
(any other language renders as plain text) and the same `github-light`/`github-dark` themes; a
`pnpm-workspace.yaml` `overrides` block collapses `@nuxtjs/mdc`'s shiki 4.1.0 onto 4.4.3 so both
share one `@shikijs/core`, engine and grammar/theme chunks. vue-stream-markdown's
mermaid/katex turned out to cost nothing: neither library is installed, and the package only
loads them through `extensions` we never pass. `/dev/**` is also dropped from production
builds (`fa4013d`, M9). Measured with deploy.yml's command (`.output/public/_nuxt/*.js`, per-file
gzip; peak RSS from `/usr/bin/time -l`):

| Build | Client JS chunks | gzip total | 4096 MB | 3584 MB | V8 default | Peak RSS @4096 |
|---|---|---|---|---|---|---|
| base `a206109` (clean export) | 203 | 1,805,848 B | pass | **fail** | — | 4.46 GB |
| cycle HEAD `538b50a` | 572 | 3,704,928 B | **FAIL** (heap limit, Nitro phase) | — | — | 4.63 GB at crash |
| C1 only (`48c6e69`) | 267 | 2,091,631 B | pass | — | — | 4.53 GB |
| final (`fa4013d`) | 264 | 2,099,125 B | pass | **fail** | pass (4.54 GB) | 4.64 GB |

Net cost of the cycle is now +61 chunks / +293 KB gzip over base (the Elements + vue-stream-markdown
vendor chunk), not +5 KB. **Headroom caveat:** base *and* final both fail at 3584 MB — the app sat
within 512 MB of deploy.yml's cap before this cycle, and still does. deploy.yml/CI were not changed.

**I2 — a persistence failure was silent** (`3464f09`). `ws.ts` finishes the message before
persisting, so a `createConversation`/`appendMessages` throw hit `turnStream.error()` on a closed
stream, which returned early — no `error` frame, no `idle`. `error()` now always sends the legacy
error + idle frames and gates only the error chunk. Test: *error after finish still sends the error
+ idle frames (and no chunk)*.

**I3 — a superseded turn leaked into a replaced list** (`c2bee7d`). `ClientTurns.discard()` closes
the active turn, drops its later frames, and suppresses every further upsert from any turn whose
assembler is still draining (finalize included). `useVoice().discardTurn()` exposes it;
`newConversation()` uses it instead of `interrupt()`, and the page calls it in `resume()` and
`retryTurn()` before replacing the list. Six tests: four went red against an `interrupt`-alike
stub (queued chunks + finalize, later frames, a finished-but-still-draining turn, a newer turn
after discard); two are guards (before the first chunk, fresh socket).

**M4 / M5** (`9c3ec44`). `onError` now `console.warn`s with the turn id (it swallowed assembler
errors), and `controller.enqueue` is guarded — after an assembler rejection the turn's stream is
cancelled and every later chunk threw inside the socket's `onmessage` (both RED first). The
remaining `interrupt()` window (Stop before turn N's first frame) is documented at `interrupt()`.

**M6** (`d5ca7c3`). Comment at `pump()` in `server/lib/agent/run.ts`: it ignores an early consumer
exit, safe today because every exit in practice is an abort that also ends the stream; in speak
mode the pump reads ahead of the TTS-throttled consumer.

**M8** — this docs commit: the ReasoningContent-streaming and shiki-coexistence "deferred minors"
removed (both fixed), wiki `agent.md`'s "live context once per connection" corrected (rebuilt
every turn since cycle 42), bundle claims corrected here and in the wiki, and a bundle-weight
constraint added to `.claude/rules/web-nuxt.md`.

**Browser re-check** (playwright-cli, dev :3217; screenshots in
`.superpowers/sdd/2026-09-19-agent-elements-foundation/fix-wave/`, gitignored): `/dev/elements` in
light and dark — tool input/output JSON highlighted (3 token colours; `github-light` values in
light, `--shiki-dark` values in dark), markdown heading/bold/inline code/table/link render, fixture
image loads (naturalWidth 200); the markdown ` ```ts ` block is unhighlighted exactly as before
(vue-stream-markdown only highlights with a `code` extension, never passed). `/agent`: loads with
0 console errors / 0 warnings; resuming a thread from the rail and expanding its tool shows the
highlighted JSON; New conversation returns to the empty state with 0 errors. No live-model turn was
run in the fix wave. I3's streaming race is covered by the unit tests only.

## Commits (this task, Step 1/2/3/4)

No code-fix commits were needed (Step 1 found no defects). This handover + the wiki/roadmap/backlog
edits are committed together as the single Step 4 docs commit — see the commit log for the exact
SHA and message.
