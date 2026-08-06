---
title: Structural tool-history — the agent sees its own tool calls and results across turns (cycle 43)
cycle: 43
date: 2026-08-05
status: >
  🔨 BUILT, NOT MERGED. 13 commits on `feat/structural-tool-history` (branched from master
  `c6cc68e`), every task's per-task review clean (3 fix rounds across the branch — Tasks 4,
  7, and 8, one round each — all re-reviewed clean), no whole-branch review run yet. NOT
  merged, NOT pushed, NOT deployed.
  Gates at HEAD `9ee44a2`, re-run fresh for this handover on 2026-08-06 (not copied from the
  execution ledger — the numbers moved during the cycle): **typecheck 0 errors / test 1027
  passed across 139 files / build clean (65.7 MB, 19.5 MB gzip)**. No migration — additive
  jsonb only.
branch: feat/structural-tool-history (off master c6cc68e; 13 commits, ad5025f..9ee44a2)
spec: ../superpowers/specs/2026-08-05-structural-tool-history-design.md
plan: ../superpowers/plans/2026-08-05-structural-tool-history.md
docs:
  - ../wiki/agent.md (new "Tool history (cycle 43)" section; corrected 3 now-stale
    references — the "known structural gap" note in Entry point, the `tool_calls jsonb`
    column description in Conversation store, and the resume chip-ordering note in
    Transcript rendering invariants)
  - ../superpowers/plans/00-roadmap.md (cycle-43 row inserted between 42 and 44 — there was
    no row for 43 before this)
related:
  - ../handovers/2026-07-01-agent-loop-audit.md (cycle 41 — first deferred this work)
  - ../handovers/2026-06-29-multimodal-agent.md (cycle 39 — the `[image]` imitation
    post-mortem this design is built to not repeat)
  - ../handovers/2026-07-23-agent-self-model-hardening-phase1.md (cycle 49 — the "Done" ×2
    zero-tool-call fabrication incident, the other half of the motivation)
problem: >
  `runAgent` built model history from `{ role, content }` text only — the agent never saw
  that it had called a tool in a prior turn, only the prose it produced afterward. Three
  consequences, all observed in production: no cross-turn coherence (it redid searches it
  had already run), history that taught fabrication (prose appearing with no tool call
  attached — cycle 49's "Done" ×2 with zero tool calls, cycle 39's literal `[image]` reply
  instead of a real `edit_image` call), and refusals evaporating (a denied `exec` left no
  trace, so the agent re-proposed the same command next turn). The blindness sat at TWO
  seams — live, within a WS connection, and on resume from Postgres — and fixing one while
  leaving the other broken would still leave the agent blind half the time.
keydecision: >
  Approach B: a normalized `AgentToolRecord[]` rides as one new optional field on the
  assistant `AgentMessage` (no new `tool` role), persists additively onto the existing
  `conversation_messages.tool_calls` jsonb (no migration), and is expanded into paired AI
  SDK tool-call/tool-result messages by a single pure function (`toolBlocksFor`) applied at
  ONE call site inside `runAgent` (`buildModelMessages`) — so live history and resumed
  history are structurally incapable of diverging; a future edit to `orchestrator.ts` or
  `ws.ts` cannot forget to apply the policy, because neither of them applies it directly.
  Retention is tiered: the tool CALL survives for the life of the conversation (the
  anti-fabrication signal, ~50 tokens), but only the last 3 tool-bearing turns keep their
  RESULT — older turns elide to `{ elided: true, bytes: n }`, still emitting the paired
  `tool` message (providers reject an unpaired `toolCallId`). A synthetic-text digest
  (`[you called web_search(...) → 8 results]`) was rejected outright in the spec brainstorm
  — it repeats the exact failure mode `llm-imitates-history-representations` names: any
  textual marker in history gets copied back by the model, which is precisely how cycle
  39's 7-character `[image]` placeholder became a habit instead of a tool call.
deferred: >
  Not merged, pushed, or deployed — awaiting a whole-branch review and Tony's merge
  decision. The live path was never exercised end-to-end with a real tool call in this
  cycle's browser validation (the homelab AI backend at 192.168.2.25:8004 is unreachable
  from the build sandbox, a pre-existing LAN-visibility limitation — see cycle 49);
  validation instead seeded real DB rows in the exact shape Task 5's persistence writes and
  drove them through the real `getConversation` → `resume()` path. A live smoke test before
  merge is recommended. One open question was deliberately left unresolved this cycle — the
  live-path `[attachment unavailable]` marker can still be written permanently into stored
  user content on a failed read — and is tracked as MyMind task (see "Open question" below),
  not fixed here.
---

# Structural tool-history (cycle 43)

## Status, plainly

**Built, not merged.** `feat/structural-tool-history` has 13 commits off master `c6cc68e`
(`ad5025f` spec/plan docs → `9ee44a2` HEAD). Every one of the 9 plan tasks passed its
per-task review (Tasks 4, 7, and 8 needed fix rounds — all re-reviewed clean; Task 4 needed
one round, Task 7 one round, Task 8 one round). No whole-branch final review has run yet.
The branch is **not merged to master, not pushed, and not deployed**. There is **no
migration** — `conversation_messages.tool_calls` is untyped jsonb, so every new key added
this cycle is additive and every legacy row still loads.

## What shipped

The agent now sees its own prior tool calls and results across turns, closing the
blindness at both seams the spec identified:

- **Capture** (`server/lib/agent/ai-tools.ts`). `buildAiTools`' `execute` now threads the AI
  SDK's `toolCallId` and the tool's `kind` through all three emit sites — success, approval
  denial, and a thrown handler — into an enriched `tool-result` `AgentEvent` carrying
  `callId`, `args`, `result`, `kind`. Denials and thrown errors are captured exactly like
  successes; that is what stops the agent re-proposing a refused command on the next turn.
- **Records** (`server/lib/agent/tool-history.ts`, new). `AgentToolRecord { callId, name,
  kind, args, result, summary, undoToken?, textOffset }`. `orchestrator.ts` collects these
  onto the assistant turn as `toolRecords?: AgentToolRecord[]` — one new optional field on
  `AgentMessage`'s assistant arm, no new role. `textOffset` (`assistantText.length` at call
  time) is the ordering fix that both the model-replay grouping and the UI resume-splitting
  depend on.
- **Decay policy** (`applyHistoryPolicy`, pure, unit-tested). Walking newest-to-oldest and
  counting only tool-*bearing* assistant turns (plain chat turns don't consume the window):
  the call always survives; the last 3 tool-bearing turns keep their result (`read` capped
  1500 chars on replay / 8192 chars at write; `create`/`destructive` — already body-free
  receipts since cycle 52 — kept whole); older turns elide the result to
  `{ elided: true, bytes: n }` while keeping the call.
- **Replay — the single call site** (`buildModelMessages`, `server/lib/agent/run.ts`).
  `runAgent` runs `applyHistoryPolicy` then `toolBlocksFor` immediately before building the
  model messages. `toolBlocksFor` groups records by `textOffset` into paired
  `assistant`(tool-call)/`tool`(tool-result) message blocks — parallel calls sharing an
  offset group into one block; calls at different offsets emit successive blocks, so a
  multi-step turn (call → text → call → text) replays in step order. An elided result still
  emits its paired `tool` message; a legacy record with no `callId` emits nothing at all
  (never an unpaired half).
- **Persistence** (`server/services/conversations.ts`, `server/api/voice/ws.ts`). Records
  ride `conversation_messages.tool_calls` directly off the assistant message that owns them
  — the old side-array `toolCalls` accumulator in `ws.ts` is gone, removing a second source
  of truth rather than adding one. `rowToAgentMessage` rebuilds `AgentMessage` from a row,
  never throwing on malformed jsonb. Legacy rows (`{ name, summary, undoToken }`, no
  `callId`) degrade to shape-only: the resume chip still renders, the record contributes
  nothing to model history.
- **Attachments on resume** (`hydrateAttachments`, `conversations.ts`). `getAgentHistory`
  rehydrates image/file bytes for the same 3-turn window, using the same
  `getImageBytes`/`getFileBytes` readers the live path uses. Turns outside the window
  degrade to plain text with no placeholder. A within-window read that fails has its
  `[attachment unavailable...]` note stripped before the message re-enters history
  (`stripUnavailableMarkers`) — this was added in a fix round (see Task 7 below).
- **UI: inline chip ordering on resume** (`app/pages/agent/index.vue`). `resume()` splits a
  resumed assistant message at each record's `textOffset`, interleaving text → chip → text
  the same way the live stream already renders. Split only fires when *every* tool call on
  the message carries an offset (all-or-nothing); any offset-less record, mixed or alone,
  falls back to the pre-existing chips-first render. A trailing chip (offset at the very end
  of the message) doesn't leave a floating empty reply bubble, but still carries
  `reasoning`/`attachments` when the message has them.

## The spec is now wrong in two places — read this before trusting Testing items 3 and 6

The spec (frozen at brainstorm time, per project convention) is superseded by two human
rulings made during the build. **Do not implement against spec Testing items 3 or 6 as
written — implement against the code and this handover instead.**

**Testing item 3 ("image invariant") was vacuous as specified, and is now a different
test at a different seam.** The spec asked for an assertion on serialized model messages
that no `generate_image`/`edit_image` URL appears. As written (Task 4), the fixture's
`generate_image` result never contained a URL to begin with, and `toolBlocksFor` round-trips
`result` verbatim with no scrubbing — so the assertion could not fail no matter what the
code did. **Ruling:** delete it; add `'keeps display image URLs OUT of the model-facing
result'` to `server/lib/agent/ai-tools.test.ts`, asserting at the real seam this cycle
newly exposes — `buildAiTools`' `execute` — that a tool's `display.images` URL reaches
`ev.images` and never `ev.result`. Before this cycle that distinction was cosmetic (tool
results never entered model history at all); after this cycle a URL sitting in `result`
would newly leak straight into the model's context on the next turn. Mutation-tested:
merging `display` into `result` at the execute site flips the test red on exactly the
right assertion.

**Testing item 6 (live/resume parity) had a fixture that could not detect the field
it exists to protect.** The spec's parity fixture used a single tool call. `textOffset`
only changes replay output when it *splits* a turn into multiple block pairs — one call
never splits anything — so the plan's own mandated mutation check ("drop `textOffset`,
confirm RED") was a silent no-op on that fixture; it would have passed while proving
nothing. **Ruling:** widen the fixture to two calls at different offsets. This both
satisfies the plan's own stated intent (the test must be able to fail) and additionally
exercises the multi-block expansion path the resumed-chip-ordering fix (Task 8) depends
on. Confirmed genuinely RED on the widened fixture before the fix; confirmed genuinely
GREEN after.

## Open question this cycle deliberately did NOT resolve

**The live path can still write a permanent `[attachment unavailable]` marker into stored
user content.** On the live path, a failed attachment read inside a turn emits
`[attachment unavailable: <name>]` via `buildUserMessageParts`
(`server/lib/agent/attachments.ts`), and `ws.ts` persists `messageText(m.content)` — so
that marker gets written into `conversation_messages.content` permanently, where it will
replay forever on every future turn of that conversation regardless of the tool-history
window (the window governs *tool results*, not raw persisted user text).

This is **pre-existing behavior**, wider than this cycle's scope, and touching it changes
shipped behavior beyond what this cycle set out to do — so it was deliberately left alone.
The **resume** path got the equivalent fix this cycle (`stripUnavailableMarkers`, Task 7
fix round 1): a durably-missing blob no longer re-injects the marker into replayed history
on every resume. The **live** path's first-write behavior is untouched.

This needs a decision, not just a doc line, so it is tracked as a MyMind task:
**`4ef76235-b5ff-454b-9629-7af03cddc183`** — "Live-path `[attachment unavailable]` marker
can be written permanently into stored user content." A future session should decide
whether to also strip it at the live write site (and whether that changes what a user sees
about a failed attachment).

## Six defects were in the PLAN itself, not the build

All six were caught by review or by the plan's own mandated mutation-check steps
("break it, watch it go red, revert") — **not by the test suite, which stayed green
throughout every one of them.**

1. **(Task 4) Vacuous image-invariant test** — spec Testing item 3, covered above.
2. **(Task 6) A mutation check with nothing to detect** — spec Testing item 6's
   single-call parity fixture, covered above.
3. **(Task 7) A `readBytes` type that could never satisfy its own call site.** The brief's
   `hydrateAttachments` signature used `readBytes: (a) => Promise<Uint8Array>`, but
   `buildUserMessageParts`'s real `ReadBytes` type is
   `(a) => Promise<{bytes: Buffer; mime: string} | null>` — and the *real* readers
   (`getImageBytes`/`getFileBytes`) the brief itself said to reuse could never have
   satisfied the brief's own declared type either. The implementer proved this concretely
   (3× `TS2345`/`TS2322` reverting to the brief's literal signature) before correcting it.
4. **(Task 7) A dead assertion regex.** The brief's own test used
   `/\[attachment\]/` — which requires the literal substring `[attachment]` and can never
   match the real emitted text, `[attachment unavailable: <name>]`. Corrected to
   `/\[image\]|\[attachment unavailable/`.
5. **(Task 8) An unconditional trailing push produced a floating empty reply bubble.** The
   brief's `resume()` code always pushed a final transcript entry even when a tool call's
   `textOffset` landed exactly at the end of the message (i.e., no trailing commentary) —
   producing an empty-text "Bridget" bubble the live path never renders. Fixed by gating the
   trailing push on non-empty text OR `reasoning` OR `attachments` (a naive
   `cursor < content.length` guard would have silently dropped a trailing reasoning block or
   attachment chips on any turn ending in a tool call — avoided deliberately).
6. **(Task 8) Offset-less records could silently vanish when mixed with offset-bearing
   ones.** The brief's code filtered to only offset-bearing records before splitting, so a
   message mixing one offset-bearing and one offset-less tool call would drop the
   offset-less chip with no fallback and no error. Currently unreachable (every write path
   in the app sets an offset on every push today) but latent. Fixed by making the split
   branch all-or-nothing: any record missing an offset routes the *whole* message through
   the legacy chips-first branch.

**The lesson worth carrying forward.** Four of these six shared one species: an assertion
or check that *could not fail* by construction — a fixture holding no URL to catch (#1), a
mutation that was a silent no-op on an under-sized fixture (#2), a regex that could never
match the real marker text (#4), and (closest in kind) resume-split logic that had *no*
unit test at all, so the automated gates gave zero signal on either Task 8 finding — both
were caught purely by reviewer hand-trace (#5, #6). All four were caught only because the
plan mandated an explicit "break it and watch it go red" step, or because a reviewer
independently hand-traced the logic — never because the test suite itself turned red. This
repo has been bitten by this exact shape before: the `vacuous-tests-pass-without-reaching-code`
memory finding, and cycle 52's CAS test that mutated the row before invoking the handler
under review, so the code path it existed to protect was called zero times across 973
passing tests. The recurring fix is the same one this plan applied deliberately: a
mandatory, scripted "break the assertion, confirm RED, revert" step is not optional
process theater — it is the only thing in this cycle that caught 4 of 6 plan defects that a
fully green suite hid.

## Gates (re-run fresh for this handover, 2026-08-06, HEAD `9ee44a2`)

| Gate | Result |
|---|---|
| `pnpm typecheck` | 0 errors |
| `pnpm test` | **1027 passed**, 139 test files |
| `pnpm build` | clean — 65.7 MB total (19.5 MB gzip); only pre-existing, unrelated Rollup/Tailwind sourcemap warnings |

Do not reuse the numbers recorded in individual task reports in
`.superpowers/sdd/2026-08-05-structural-tool-history/` — they were correct at the time each
task closed but moved as later tasks landed (e.g. 1020 after Task 4, 1025 after Task 5, 1027
from Task 7 onward). These are the numbers at the branch's current HEAD.

## Browser validation — what was and wasn't proven live

Task 8's UI fix (inline chip ordering on resume) could not be validated against a real live
turn: the homelab AI backend at `192.168.2.25:8004` (and the embeddings host at `:8882`) is
unreachable from the build sandbox — a known LAN-visibility limitation, same as cycle 49.
Sending a real message hung at `thinking` and never produced an assistant reply.

The substitute used instead, twice (once per fix round, 2 + 4 fixtures respectively): seed
real rows directly into the dev Postgres database in the exact DTO shape
`getConversation`/`msgToDTO` reads — i.e., exactly what Task 5's persistence would have
written for a real turn — then navigate to `/agent?c=<id>` and drive the actual
`resume()`/`Transcript.vue` code a real resume would exercise. This proved the rendering
logic against real rows through the real code path, but it did **not** prove the full
capture→persist→resume round trip end-to-end from a live model turn. A live smoke test
("send a message that triggers a tool, reload, resume") is recommended before merge, once a
network path to the homelab AI stack is available.

## Deferred / follow-ups

- **Merge decision.** No whole-branch review has run. Recommended next step before merge:
  run a final whole-branch review, then a live smoke test per the browser-validation note
  above.
- **The live-path attachment marker** (see "Open question" above) — tracked as a MyMind
  task, not fixed in this cycle.
- **Minor, deferred by task (from the execution ledger, not exhaustive — see
  `.superpowers/sdd/2026-08-05-structural-tool-history/progress.md` for the full list):**
  - `capResult`'s byte-length computation is duplicated between the cap path and the elided
    branch (`tool-history.ts`); worth extracting if the file grows.
  - The parity test (Task 6) structurally cannot protect `summary`/`undoToken` (chip/UI-only
    fields, never read by `toolBlocksFor`/`toModelContent`) — a round-trip bug dropping them
    would pass Task 6's test but break resumed chips; only Task 8's browser validation is a
    net for those.
  - `rowToAgentMessage` still takes an `attachments` parameter it never itself reads —
    `hydrateAttachments` reads the raw DB rows directly instead, bypassing it for that field.
    By design (documented in the Task 7 report), not a bug, but worth a second look if
    `rowToAgentMessage`'s signature is ever refactored.
  - A resumed turn with both `reasoning` and a tool split shows the reasoning block in a
    different position than the equivalent live turn — a DTO-level limitation (one
    `reasoning` blob per message, no position marker), not fixable inside this cycle.
  - `Transcript.vue` still only renders attachments in the non-assistant branch, so an
    attachment on an *assistant* row could never display — pre-existing, inert today
    (nothing writes attachments onto assistant rows), untouched by this cycle.

## Files touched (by task)

- Task 1 — `server/lib/agent/tool-history.ts` (new), `tool-history.test.ts` (new)
- Task 2 — `server/lib/agent/ai-tools.ts`, `types.ts`, `run.ts`, `ai-tools.test.ts`
- Task 3 — `server/lib/voice/orchestrator.ts`, `run.ts`, `test/orchestrator.test.ts`
- Task 4 — `server/lib/agent/run.ts`, `run-history.test.ts` (new), `ai-tools.test.ts`
- Task 5 — `shared/types/conversation.ts`, `server/services/conversations.ts`,
  `conversations.test.ts` (new), `server/api/voice/ws.ts`
- Task 6 — `server/lib/agent/run-history.test.ts` (extended)
- Task 7 — `server/services/conversations.ts`, `conversations.test.ts`
- Task 8 — `app/pages/agent/index.vue`
- Task 9 (this) — `docs/wiki/agent.md`, `docs/handovers/2026-08-05-structural-tool-history.md`
  (new), `docs/superpowers/plans/00-roadmap.md`
