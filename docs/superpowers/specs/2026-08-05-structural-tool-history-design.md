---
title: Structural tool-history — feed the agent its own tool calls and results across turns
cycle: 43
date: 2026-08-05
status: spec — approved in brainstorm, not yet planned
branch: feat/structural-tool-history (off master c6cc68e)
task: 5cc52941 (MyMind)
related:
  - ../../handovers/2026-07-01-agent-loop-audit.md (cycle 41 — deferred this work)
  - ../../handovers/2026-06-29-multimodal-agent.md (cycle 39 — the `[image]` imitation post-mortem)
  - ../../handovers/2026-07-23-agent-self-model-hardening-phase1.md (cycle 49 — the fabrication incident)
---

# Structural tool-history

## Problem

`runAgent` builds model history from `{ role, content }` text only. The agent never sees
that it called a tool in a prior turn — only the prose it produced afterwards.

Three consequences, all observed in production:

1. **No cross-turn coherence.** It cannot know what it already searched, fetched, or
   changed, so it redoes work and cannot answer follow-ups from what it already found.
2. **History teaches fabrication.** Every prior turn in the prompt shows prose appearing
   with no tool call attached. Cycle 49's incident (`054f2560`) had the agent report
   "Done" twice with zero tool calls; cycle 39's had it reply with the literal text
   `[image]` instead of calling `edit_image`.
3. **Refusals evaporate.** A denied `exec` leaves no trace, so the agent re-proposes the
   same command on the next turn.

### Why the type is the real blocker

`AgentMessage` (`server/lib/agent/run.ts:16`) is:

```ts
export interface AgentMessage { role: 'system' | 'user' | 'assistant'; content: string | AgentContentPart[] }
```

There is no `tool` role. This is not a plumbing gap — the model has no concept of a tool
call to plumb.

### The blindness is at two seams, not one

- **Live, within a connection.** `handleTurn` returns
  `[...messages, { role: 'assistant', content: assistantText }]`
  (`server/lib/voice/orchestrator.ts`) — flattened prose. Tool events are emitted for the
  UI and then discarded.
- **On resume.** `getAgentHistory` (`server/services/conversations.ts:147`) selects
  `role` and `content` only.

Fixing either alone leaves the other broken. Any design must close both.

## Non-goals

- Conversation branching (`parent_id` stays linear).
- Subagent *internal* tool calls in parent history — the digest they already return is
  the compact form and is retained as an ordinary tool result.
- Putting `reasoning` into model history. Cycle 45's invariant holds: display and storage
  only.

## Decisions

| Decision | Choice |
|---|---|
| Retention | **Tiered by tool `kind`.** `read` results retained (capped); `create`/`destructive` already return body-free receipts (cycle 52) and are kept whole. |
| Decay | **Recent-N turns (N=3) keep results.** Older turns keep the *call* and elide the *result*. |
| Representation | **Approach B — our own normalized record, mapped to AI SDK `ModelMessage[]` at the boundary.** |
| In scope | Inline tool-chip ordering on resume; model-side attachment restoration on resume. |

### Why not the alternatives

**A — native AI SDK passthrough.** Store and replay the SDK's own `ModelMessage` shape
end-to-end. Highest fidelity, least mapping code, but it welds the *database* format to an
SDK internal type. AI SDK v7 is already a deferred item; under A that upgrade becomes a
data migration rather than a one-function change.

**C — synthetic text digest** (`[you called web_search("…") → 8 results]`). Cheapest, no
schema or type churn — and **rejected**. It re-runs a failure mode this codebase has hit
twice. The `llm-imitates-history-representations` finding is that *any* textual marker in
history gets copied; cycle 39 proved a 7-character `[image]` placeholder was enough to
make the model emit the marker instead of calling the tool. C also leaves fabrication
untouched, because the model still never sees a real call.

## Data model

```ts
interface AgentToolRecord {
  callId: string      // AI SDK execute() opts.toolCallId — the pairing key
  name: string
  kind: 'read' | 'create' | 'destructive'
  args: Record<string, unknown>
  result: unknown     // exec.result, capped at ~8KB on write; tier decides the tighter replay cap
  summary: string     // existing chip text
  undoToken?: string
  textOffset: number  // assistantText.length when the call fired
}
```

`AgentMessage` gains **one optional field** — no new role:

```ts
| { role: 'assistant'; content: string | AgentContentPart[]; toolRecords?: AgentToolRecord[] }
```

This keeps `AgentMessage[]` 1:1 with conversation turns, which is exactly the DB shape
(one assistant row, one `tool_calls` jsonb array). All protocol complexity lives in the
mapper instead of leaking into the type, its tests, and `subagents.ts`.

`kind` is **stored, not looked up at replay** — a tool renamed or removed later still
replays correctly instead of crashing or silently retiering.

`textOffset` is the ordering fix: one integer, captured free at call time.

### Persistence and back-compat

`conversation_messages.tool_calls` is untyped `jsonb`, so the new keys are **additive and
require no migration**. Existing rows are `{ name, summary, undoToken }`; a record with no
`callId` replays as **shape-only** — the chip renders as it does today and the record
contributes nothing to model history. Old conversations degrade to current behaviour. No
backfill.

## Capture

`ai-tools.ts:31` currently ignores `execute`'s second argument, which is where the AI SDK
supplies `toolCallId`:

```ts
execute: async (input, { toolCallId }) => { … }
```

`RunHooks.onEvent`'s `tool-result` carries `callId`, `args`, `result`, and `kind`.

This is the correct seam because **every** path funnels through it, including the two
failure paths already emitting today: approval denial (`ai-tools.ts:44`) and a thrown
handler (`ai-tools.ts:62`). Their `{ denied: true }` / `{ error }` payloads are small and
are retained — that is what stops the agent re-proposing a refused command.

## Replay

### `toModelMessages()`

One assistant turn expands into up to three AI SDK messages:

1. `assistant` with `tool-call` parts
2. `tool` with `tool-result` parts
3. `assistant` with the text

Records are grouped by `textOffset`, so a genuine multi-step turn (call → text → call →
text) replays as successive blocks rather than one flattened batch. Several calls sharing
one offset — parallel calls the model issued in a single step — group into **one** block
with multiple `tool-call` parts and multiple `tool-result` parts, which is the shape the
SDK produced in the first place. Same seam and spirit as the existing `toModelContent`
(`run.ts:25`).

### Policy — one pure function

A **turn** here means one assistant message carrying `toolRecords` — user messages and
assistant messages without tool calls do not consume the window. Walking newest-to-oldest:

- **The call always survives, for the life of the conversation.** Only the *result*
  decays. The call is the anti-fabrication signal and costs ~50 tokens.
- Last 3 tool-bearing turns: results kept. `read` results capped at ~1500 chars (matching
  `session-read.ts`'s existing `CONTENT_CAP` precedent); `create`/`destructive` kept whole.
- Older: result replaced with `{ elided: true, bytes: n }`.

### Single call site

Policy and mapping run **inside `runAgent`**, immediately before `modelMessages` is built.
Live history and resumed history therefore cannot diverge — there is one call site, and no
future edit to `orchestrator.ts` or `ws.ts` can forget to apply it. This is deliberate
given `subagent-build-wiring-gap`: make the wiring structurally impossible to miss rather
than documented.

### The pairing invariant

**An elided result still emits its `tool` message.** Never drop a result while keeping its
call — providers reject an unpaired `toolCallId`. This is enforced by test, not comment.

## UI

### Chip ordering on resume

`app/pages/agent/index.vue:70-72` documents the defect in its own comment: *"Exact stream
position isn't stored (one assistant row per turn), so chips render before the reply they
belong to."*

`resume()` splits `m.content` at each record's `textOffset` and interleaves text bubble →
chip → text bubble — the shape the live path already produces (`useVoice.ts:73`, *"resumes
in a NEW bubble after each inline tool chip — true stream order"*). The stale comment is
deleted with the fix.

### Attachments on resume

Smaller than the task implies: `index.vue:77` already restores attachments to the
**transcript**. The gap is **model-side only** — `getAgentHistory` drops them, so a
resumed agent goes blind to an image it could previously see.

Rehydrate via `buildUserMessageParts` for the last N turns, using the same window as tool
results. **Older attachments drop silently — no placeholder text.** A marker is exactly
the trap cycle 39 fixed by removing the artifact entirely; it is not reintroduced in a new
location.

## Error handling

- Malformed or absent `tool_calls` jsonb → zero records, never throws. Resume degrades,
  never fails.
- Non-serializable result → persisted as `{ unserializable: true }`.
- Results capped generously (~8KB) at write, tightly (~1500) at replay, so the replay cap
  can be retuned later without a backfill.

## Testing

Six tests, each written so it can actually go red (per
`vacuous-tests-pass-without-reaching-code`):

1. **Pairing** — every `tool` message's `toolCallId` has a matching call, *including when
   elided*. Mutation check: dropping the elided result must fail this.
2. **Decay** — turn N−4's result is elided while its call survives; turn N−1's is intact.
3. **Image invariant** — assert on *serialized model messages* (not the record) that no
   `generate_image`/`edit_image` URL appears.
4. **Legacy rows** — `{ name, summary, undoToken }` replays shape-only and produces no
   unpaired `tool` message.
5. **Wiring** — history with stale results, fed through `runAgent`, comes out elided.
   Catches the `subagent-build-wiring-gap` class.
6. **Live/resume parity** — identical conversation state through both seams yields
   identical `modelMessages`. The strongest test in the set; it encodes the property the
   design rests on.

The `.vue` change is browser-validated with `playwright-cli` via the `browser-testing`
skill — typecheck and build cannot catch a mis-split transcript.

## Risks

- **ID pairing across persist → reload → replay** is the main correctness risk; test 1
  guards it.
- **Prompt growth.** The call-shape floor grows with conversation length (~50 tokens per
  retained call). Bounded in practice by conversation length; if it ever bites, the
  follow-up is to elide *calls* beyond some far horizon too.
- **AI SDK v6 → v7** may change `ModelMessage` part shapes. Approach B confines that blast
  radius to `toModelMessages()`.
