---
title: Agent Elements foundation — AI SDK message protocol over the voice socket, rendered with AI Elements Vue
cycle: 64
date: 2026-09-19
status: spec — approved in brainstorm, not yet planned
mymind_id: 5a1e0496-1453-4ced-863d-cbfda5e46bf0
mymind_hash: f57b25c77b579b1117b9a2bcb0896f1f856cd5d02b802866715d022d3f65a313
program: >
  Cycle 1 of 4 in the "agent surfaces on AI Elements" program (brainstormed 2026-09-18/19):
  (1) THIS — foundation: design-system coexistence + the message protocol + an Elements-rendered
  conversation; (2) /agent rebuild — Persona, layout, PromptInput, Confirmation, Context meter,
  retire the particle head; (3) /sessions/[id] on the same components; (4) voice studio + Home
  on shared voice pieces and PromptInput.
related:
  - ../../wiki/agent.md (the /agent surface, WS protocol, conversation store, tool history)
  - ../../wiki/voice-agent.md (the speech pipeline this must not disturb)
  - ../specs/2026-08-27-agent-surface-redesign-design.md (cycle 60 — the three-column shell and the avatar this program retires)
  - ../specs/2026-08-05-structural-tool-history-design.md (cycle 43 — tool records, textOffset, the model-history seam)
closes:
  - "Tool calls render as a one-line badge after they finish — no running state, no input, no output"
  - "Subagent work is invisible — a nested run collapses to '(N tool calls)'"
  - "Hand-rolled transcript scroll/markdown plumbing (Transcript.vue autoscroll pin, MDC per-entry cache keys) keeps breaking"
defers:
  - "Persona, three-column → new layout, PromptInput composer, Confirmation (replaces ApprovalPrompt), Context meter, avatar/three.js removal — cycle 65 (/agent rebuild)"
  - "/sessions/[id] transcript on Elements — cycle 66"
  - "Voice studio shared pieces + Home PromptInput — cycle 67"
out-of-scope:
  - "Persisting interrupted (barged-in) partial replies — existing behaviour, unchanged"
  - "Stream resumption after a WS drop"
  - "/api/agent/chat (HTTP) — left untouched; it has no in-app caller after this cycle"
  - "AI SDK native tool approval (needsApproval / addToolApprovalResponse) — our approval gate stays a WS round-trip"
---

# Agent Elements foundation (cycle 64)

## Why

Tony wants the agent surfaces rethought around Vercel's AI Elements — the polished, AI-SDK-native
way to show tool calls and the agentic loop — and away from bespoke UI that has been expensive to
get right (the particle face, the transcript's hand-rolled scroll/markdown plumbing).

Three facts, established in brainstorm by reading the code and the libraries, shape this cycle:

1. **AI Elements is React.** Its maintained Vue port, **AI Elements Vue**
   (`vuepont/ai-elements-vue`, v1.5.x, shadcn-vue based, copy-in source), has the full set we need:
   conversation, message (+ streaming markdown via `vue-stream-markdown`), tool, reasoning,
   chain-of-thought, task, plan, confirmation, context, persona, and the voice pieces. Nuxt UI's
   own `UChat*` components were evaluated and rejected by Tony: less complete, no markdown.
2. **`@ai-sdk/vue` is headless** (state + transport). Elements Vue sits on top of the AI SDK's
   `UIMessage` parts model. Our client state is a bespoke `TranscriptEntry[]` — that mismatch,
   not the lack of a component library, is the real seam.
3. **The data already exists server-side and is thrown away.** `runAgent` yields tool-start and
   tool-result events carrying callId, args, result, kind, images and undo tokens; `ws.ts`
   forwards only `name/summary/undoToken`, and only after the tool finishes. Subagents run a nested
   `runAgent` and discard everything but a count.

The AI SDK has no streaming/duplex voice (only one-shot `experimental_transcribe` /
`experimental_generateSpeech`), so the WebSocket stays: it owns mic audio, sentence-level TTS and
barge-in. What changes is what it carries for the *message*: the AI SDK's own stream protocol
(`UIMessageChunk`), assembled on the client by the SDK's own `readUIMessageStream`.

## Decisions (locked in brainstorm)

| # | Decision | Choice | Why |
|---|---|---|---|
| D1 | Component library | **AI Elements Vue**, installed via its CLI (copy-in source) | Polish Tony wants; Vue-native; we own the source |
| D2 | Coexistence with Nuxt UI | **Install + bridge** (not a port onto Nuxt UI primitives) | Keeps the Elements polish and CLI upgrades; porting = rebuilding UI by hand again |
| D3 | Wire protocol | **`UIMessageChunk` over the existing WS**, assembled by `readUIMessageStream` | SDK-native messages with no hand adapter and no `Chat` class (voice turns are server-initiated, which fights `Chat`'s `sendMessage` model) |
| D4 | Server strategy | **Encoder over our existing `AgentEvent`s** (not a `runAgent` rewrite onto `toUIMessageStream()`) | Leaves the forced-final follow-up, approval gate, TTS tee and tool-history persistence untouched |
| D5 | Resume | **Convert on read** (`ConversationMessageDTO[] → UIMessage[]`), no migration | Persisted tool records already carry args/result/textOffset; old rows keep working |
| D6 | Visualization (program-level) | **Persona + the loop inline** in the conversation; no separate run panel | Cycle 65 delivers Persona; this cycle delivers the inline loop |

## Scope

In: the design-system spike and bridge; the encoder; `runAgent`/`ai-tools`/subagent event
changes; the WS frame change; client stream assembly; `toUIMessages`; an Elements-rendered
conversation replacing `voice/Transcript.vue` on `/agent`; retry/undo/usage carried over; deletion
of the two dead composables.

Not in: anything in `defers` / `out-of-scope` above. The `/agent` page keeps its current
three-column shell, composer, approval prompt and avatar column this cycle — only the
conversation column's *content* is swapped.

## Task 0 — the coexistence spike (gate)

Everything else depends on shadcn-vue + Elements living beside Nuxt UI without repainting the app.
Run it first, on the cycle branch, and **stop the cycle if it fails**.

**The known collision.** Both libraries register Tailwind v4 theme tokens under the same names with
different meanings:

| Token | Nuxt UI means | shadcn means |
|---|---|---|
| `--color-primary` | brand green (`bg-primary`, `text-primary`) | primary button fill (near-black) |
| `--color-secondary` | secondary brand colour | subtle grey surface |
| `bg-muted` / `text-muted` | `--background-color-muted` / `--text-color-muted` | `--color-muted` |

Installing shadcn's stock theme CSS would repaint every Nuxt UI component.

**The bridge.** Do not import shadcn's theme block. Instead define only the shadcn tokens Nuxt UI
does *not* own, mapped onto Nuxt UI's variables, in `app/assets/css/main.css`:
`--color-background`, `--color-foreground`, `--color-card(-foreground)`, `--color-popover(-foreground)`,
`--color-accent(-foreground)`, `--color-muted-foreground`, `--color-border`, `--color-input`,
`--color-ring`, `--color-destructive`, `--color-primary-foreground`, `--color-secondary-foreground`,
and the `--radius` scale — each pointing at the matching `--ui-*` variable (e.g.
`--color-background: var(--ui-bg)`, `--color-muted-foreground: var(--ui-text-muted)`,
`--color-border: var(--ui-border)`, `--color-destructive: var(--ui-error)`). Nuxt UI keeps
`primary`, `secondary`, `muted`. Vendored Elements/shadcn components that assume
"secondary = grey" are patched in place (`bg-secondary` → `bg-elevated`); the spike inventories
every such occurrence in the components this cycle installs.

**Spike steps.**
1. Add shadcn-vue to the Nuxt app (`components.json` with aliases into `app/`; decide shadcn-nuxt
   module vs plain CLI + explicit imports — record the choice and the auto-import naming rule so
   `app/components/ui/button/Button.vue` cannot collide with Nuxt UI's `UButton`).
2. Install the Elements this cycle renders: `conversation`, `message`, `tool`, `reasoning`,
   `chain-of-thought`, `shimmer`, `code-block` (and their shadcn primitives). Record added deps
   (`vue-stream-markdown`, `vue-stick-to-bottom`, `shiki`, `@lucide/vue`, …).
3. Add the bridge CSS.
4. Build a dev-only fixture page rendering a static `UIMessage[]` that exercises every part type
   and tool state, plus a markdown body with a heading, list, table, fenced code, a link and an
   image embed `![alt](/api/images/<id>/raw)`.

**Go / no-go (all must hold).**
- Fixture page renders correctly in **light and dark**.
- **No repaint:** before/after screenshots of `/`, `/tasks`, `/documents`, `/settings` (playwright-cli)
  are visually identical.
- **Image embeds render.** `vue-stream-markdown` may harden/allow-list URLs; relative
  `/api/images/...` sources must display. If they are blocked, configure the allow-list; if that is
  impossible, no-go (or fall back to our `MdView` inside `MessageResponse`'s slot — decide here).
- `pnpm typecheck` / `pnpm build` green; **bundle-size delta recorded** in the handover (shiki is the
  expected heavy item — lazy-load or trim languages if the client bundle grows by more than ~500 KB gz).

## Architecture

### Server

**Event changes (small, additive).**
- `ai-tools.ts`: `tool-start` gains `callId` (already in scope from `execute`'s `opts.toolCallId`).
- `AgentEvent` gains `{ type: 'subagent-event', parentCallId, event: AgentEvent }`.
- `subagents.ts`: the nested `runAgent` loop forwards each nested `tool-start` / `tool-result` to
  the parent through a new optional `ctx.onNestedEvent` on the tool context (threaded from
  `buildAiTools`' hooks), instead of only counting them. The subagent's report text is **not**
  forwarded (it arrives as the tool's output).
- `AgentToolRecord` gains an optional `steps?: SubagentStep[]` (terminal states only)
  — a compact, persisted trace of a subagent's nested calls (no args/results). The model-history
  expansion (`toolBlocksFor`) ignores it, so model context is unchanged. jsonb, no migration.

**The encoder — `server/lib/agent/ui-stream.ts` (new, pure).**
`createUIChunkEncoder(messageId)` returns `{ start(), encode(ev: VoiceEvent | AgentEvent), finish(), error(text), abort() }`,
each returning `UIMessageChunk[]`. It tracks the open text/reasoning block id and closes it before
anything else opens. Mapping:

| Source event | Chunks |
|---|---|
| turn start | `start` (`messageId`, `messageMetadata: { createdAt }`), `start-step` |
| `text-delta` | `text-start` (if no text block open) → `text-delta` |
| `reasoning-delta` | `reasoning-start` (if none open) → `reasoning-delta` |
| `tool-start` | close open blocks → `tool-input-available` (`toolCallId`, `toolName`, `input: safeArgs`) |
| `tool-result`, ok | `tool-output-available` (`output: ToolEnvelope`) |
| `tool-result`, `{ error }` | `tool-output-error` (`errorText`) |
| `tool-result`, `{ denied: true }` | `tool-output-denied` — **iff** the real assembler accepts it from `input-available` (settled by test); else `tool-output-error` with `errorText: 'Denied'` |
| `subagent-event` | `data-subagent` with `id: <parentCallId>` — the full current step list, so each emission reconciles (replaces) the one before |
| `usage` | `data-usage` with fixed `id: 'usage'` — a later follow-up's usage **replaces** the first (today's overwrite rule) |
| appended image-embed text | `text-delta` (reopening a text block if needed) |
| turn end | close open blocks → `finish-step` → `finish` |
| error | close open blocks → `error` (`errorText`) |
| abort | `abort` |

`ToolEnvelope = { value: unknown; summary: string; undoToken?: string; kind?: ToolKind; images?: DisplayImage[]; truncated?: true }`.
`value` is the tool result capped for display at **16 KB** serialized (`truncated: true` when cut).
The cap applies to the wire only — persistence and the model's history are untouched.

**The turn runner.** The emission-order rules move out of `ws.ts` into a pure, testable function
(`server/lib/voice/turn-stream.ts`): it owns one encoder per turn, wraps the `emit` passed to
`handleTurn`/`handleUtterance`, and guarantees `finish` is emitted **after** `handleTurn` returns —
because the orchestrator appends image embeds *after* the speech pipeline drains, and those must
land inside the message. `ws.ts` becomes a thin caller.

**WS frames.**

| Direction | Frame | Status |
|---|---|---|
| S→C | `{ type: 'chunk', turnId, chunk: UIMessageChunk }` | **new** |
| S→C | `{ type: 'user-message', turnId, message: UIMessage }` — the STT text of a voice turn | **new** |
| S→C | `{ type: 'audio-begin', turnId, segmentId, sampleRate }` | **gains `turnId`** |
| S→C | binary PCM, `audio-end`, `state`, `approval`, `approval-resolved`, `conversation`, `error` | unchanged |
| S→C | `transcript` (assistant), `reasoning`, `tool`, `usage` | **removed** |
| C→S | all client frames | unchanged |

`turnId` is a per-connection counter assigned by `ws.ts` when a turn is scheduled. Putting it on
`audio-begin` also closes the barge-in window `useVoice` documents today ("no frame carries a turn
id — the client cannot tell whose `audio-begin` this is"): the client now discards segments from a
superseded turn outright.

### Client

**State.** `useVoice` keeps the socket, audio, VAD and playback. `transcript: TranscriptEntry[]`
becomes `messages: Ref<AgentUIMessage[]>`, where

```ts
type AgentUIMessage = UIMessage<
  { createdAt?: string; usage?: MessageUsage; interrupted?: true; errorText?: string },
  { subagent: { steps: SubagentStep[] }; usage: MessageUsage },
  AgentUITools   // tool parts' output = ToolEnvelope
>
```

`TranscriptEntry`, `pushDelta`, `pushReasoning`, `pushTool`, `setUsage` and `app/lib/voice/messages.ts`'
text/tool/reasoning/usage branches are deleted.

**Stream assembly — `app/lib/agent/turn-stream.ts` (new, pure).** Per turn: a
`ReadableStream<UIMessageChunk>` whose controller is fed by `chunk` frames with the current
`turnId`; `readUIMessageStream({ stream, onError })` yields successive message snapshots, each
replacing the in-flight assistant message in `messages`. Frames with a stale `turnId` are dropped.

- **Typed turn:** the user message (text + file parts for attachments) is appended optimistically
  on send.
- **Voice turn:** the user message arrives as `user-message`.
- `usage` is lifted from the `data-usage` part into `metadata.usage` for the actions row.

**Resume — `app/lib/agent/to-ui-messages.ts` (new, pure; replaces `buildResumeTranscript`).**
Persisted messages → `AgentUIMessage[]`: user content + attachments → text + file parts;
assistant content split at each tool record's `textOffset` into text / tool parts
(state `output-available` or `output-error` from the record), a subagent record's `steps` →
a `data-subagent` part, persisted `reasoning` → one leading reasoning part, `usage`/`createdAt` →
metadata. Legacy rows without `textOffset` keep the "tools first" fallback; the mixed-offset
all-or-nothing rule carries over.

**Rendering — `app/components/agent/Conversation.vue` (new; replaces `voice/Transcript.vue`).**
Elements `Conversation` (stick-to-bottom scroll + scroll button) → per message `Message` →
per part:

| Part | Renders as |
|---|---|
| text | `MessageResponse` (streaming markdown) |
| reasoning | `Reasoning` (auto-open while streaming) |
| `tool-*` | `Tool` + header (name, status badge) + collapsible input (`CodeBlock` JSON) + output (`envelope.value`; images from `envelope.images`) + an undo action when `envelope.undoToken` is present |
| `data-subagent` | `ChainOfThought` nested under its parent tool, one step per nested call |
| file (user) | image thumbnail / file chip, as today |

Retry, copy, timestamp and token count move onto Elements `MessageActions` / `MessageAction`
(port of our `agent/MessageActions.vue`). `app/lib/agent/retry.ts` and the undo flow are adapted from entry ids to
message ids / tool call ids. The empty state (`AgentEmptyState`) is reused as-is.

**Deleted:** `app/components/voice/Transcript.vue`, `app/components/agent/ReasoningBlock.vue`,
`app/lib/agent/transcript.ts` (+ test, ported), `app/composables/useTextChat.ts` (no caller; imports
`TranscriptEntry`), `app/composables/useAgentActivity.ts` (no caller). `MdView` stays (other
surfaces use it).

## Errors, aborts and edge cases

- **Stale chunks.** Barge-in and "typed while running" abort one turn and start the next at once;
  the aborted turn's queued frames can still arrive. The client drops any frame whose `turnId` is
  not the current turn's.
- **Normal end.** `finish` comes from the turn runner after `handleTurn` returns (see above) — never
  from `runAgent`'s `done`.
- **Model / pipeline error.** The turn runner emits an `error` chunk (and the existing `error` +
  `state:idle` frames). The partial reply stays visible with `metadata.errorText` shown inline; the
  page-level alert still fires.
- **Abort.** The client closes its own stream immediately when *it* interrupts (Stop / VAD
  barge-in) and marks `metadata.interrupted`. For server-originated aborts (a new turn superseding),
  the turn runner emits an `abort` chunk from the `AbortError` branch.
- **Dangling tools.** When a stream closes by error/abort/disconnect, any tool part not in a
  terminal state is finalized client-side as `output-error` with `errorText: 'Stopped'` — no
  spinner outlives its turn.
- **WS drop mid-turn.** Client closes the stream (`errorText: 'Connection lost'`), finalizes
  dangling tools. No resumption.
- **Assembler errors.** `readUIMessageStream`'s `onError` logs and finalizes the message; it never
  closes the socket.
- **Secrets.** `tool-input-available.input` is always the redacted `safeArgs`, never raw input.
  Nested subagent calls pass through the same `buildAiTools` wrapper, so they are redacted too.
  Results were already exposed to the browser via the resume DTO; the 16 KB wire cap bounds size.
- **Invariants preserved.** Message text is raw markdown; `toSpeakable` output reaches only TTS.
  Aborted turns are still not persisted.
- **Known asymmetry.** Live reasoning can interleave with tools; persisted reasoning is one string,
  so a resumed message shows it as a single leading block. The parity test asserts text/tool/
  subagent equivalence and reasoning *content*, not reasoning position.

## Testing

- **Encoder through the real assembler.** Fixed `AgentEvent` sequences → encoder → the SDK's actual
  `readUIMessageStream` → assertions on the final `UIMessage.parts`: text/tool ordering, every tool
  state (incl. the denied mapping — this test *decides* `tool-output-denied` vs error), envelope
  contents and the 16 KB cap, `data-subagent` reconciling running→done, `data-usage` superseding,
  embed text after the pipeline drains, error and abort endings. Each reviewer breaks one mapping
  and confirms the relevant test goes red.
- **`toUIMessages`.** Every `transcript.test.ts` case ported (textOffset split, legacy tools-first,
  mixed-offset all-or-nothing, usage on the trailing message) + subagent `steps` → `data-subagent`.
- **Live↔resume parity.** A turn encoded live and the same turn persisted (`buildTurnPersistPayload`)
  then resumed (`toUIMessages`) produce equivalent text/tool/subagent parts — the drift guard.
- **Client turn-stream.** Stale-`turnId` frames dropped; interrupt closes and finalizes dangling
  tools; disconnect; typed vs voice user-message paths; stale `audio-begin` discarded.
- **Turn runner.** `finish` after the embed append; `abort` chunk on supersede; `error` chunk on
  throw — pure, no crossws harness needed.
- **Subagent forwarding.** A fake nested run's tool events reach the parent as `subagent-event`s and
  land in the record's `steps`; `toolBlocksFor` output is unchanged by `steps` (model context guard).
- **Spike gates** as listed in Task 0.
- **Browser validation (playwright-cli, `browser-testing` skill)** on `/agent`: a typed turn with a
  tool call (running → done; expand input/output); a subagent (research) turn showing nested steps;
  an exec denial; Stop mid-tool (tool shows "Stopped", no spinner); a speak-mode turn (audio still
  plays, text still renders); resume of a legacy thread and a new one; retry; undo from a tool part;
  light and dark.
- **Gates:** `pnpm typecheck`, `pnpm test`, `pnpm build`.

## File map

| Action | Path |
|---|---|
| create | `server/lib/agent/ui-stream.ts` (+ test) |
| create | `server/lib/voice/turn-stream.ts` (+ test) |
| create | `app/lib/agent/turn-stream.ts` (+ test) |
| create | `app/lib/agent/to-ui-messages.ts` (+ test, ports `transcript.test.ts`) |
| create | `app/components/agent/Conversation.vue` |
| create | `shared/types/agent-ui.ts` (`AgentUIMessage`, `ToolEnvelope`, `SubagentStep = { callId: string; name: string; summary?: string; state: 'running' \| 'done' \| 'error' }`) |
| create | `app/components/ui/**`, `app/components/ai-elements/**`, `components.json` (CLI output) |
| create | dev-only Elements fixture page (spike) |
| modify | `server/lib/agent/run.ts` (`AgentEvent` union), `ai-tools.ts` (callId, nested hook), `subagents.ts` (forwarding), `tool-history.ts` (`steps`) |
| modify | `server/lib/voice/orchestrator.ts` (forward `subagent-event`; record `steps`) |
| modify | `server/api/voice/ws.ts` (turnId, delegate to turn runner) |
| modify | `app/composables/useVoice.ts`, `app/lib/voice/messages.ts`, `app/lib/agent/retry.ts`, `app/components/agent/MessageActions.vue` |
| modify | `app/pages/agent/index.vue` (swap transcript for `AgentConversation`; approval/undo wiring) |
| modify | `app/assets/css/main.css` (bridge), `package.json` |
| delete | `app/components/voice/Transcript.vue`, `app/components/agent/ReasoningBlock.vue`, `app/lib/agent/transcript.ts` (+ test), `app/composables/useTextChat.ts`, `app/composables/useAgentActivity.ts` |
| docs | `docs/wiki/agent.md` (protocol, UI), `docs/wiki/voice-agent.md` (frame table), handover, roadmap row, BACKLOG |

## Risks to settle in the plan

1. **Spike failure** — the whole cycle is gated on Task 0; the fallback (port onto Nuxt UI
   primitives, D2's rejected option) would be a new brainstorm, not a silent switch.
2. **`vue-stream-markdown` vs MDC.** Anything MDC rendered that plain streaming markdown does not
   (MDC component syntax, attribute syntax) — audit the agent prompt and a sample of persisted
   replies during the spike.
3. **Assembler strictness.** `readUIMessageStream` validates state transitions; the encoder tests
   against the real assembler are what prove each mapping, not the docs.
4. **Bundle weight** (shiki, stream-markdown) — measured in the spike, mitigated there.
