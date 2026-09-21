---
title: "Agent chat affordances — branching, metrics, a visible action row (cycle 68)"
cycle: 68
date: 2026-09-21
status: spec
supersedes: null
mymind_task: b32af98d
---

# Agent chat affordances (cycle 68)

`/agent` was rebuilt on AI Elements across cycles 64-67, but it still lacks affordances every
comparable chat UI has. This cycle adds them — and finishes the branching model cycle 28 reserved
and deferred, whose edge has been sitting unread in the schema ever since
(`conversation_messages.parent_id`, with a comment pointing at "the spec").

## What is actually missing, measured

The originating complaint was "no copy button, no fork, missing lots of stuff". Reading the code
first changed the shape of the work:

| Affordance | Reality before this cycle |
| --- | --- |
| Copy message | **Exists** — `ReplyActions.vue`, hidden behind `opacity-0 group-hover:opacity-100` |
| Regenerate (retry) | **Exists** — same hover row, assistant only, and **destructive** (`truncateForRetry`) |
| Token count + timestamp | **Exists** — same hover row, total tokens only |
| tok/s and duration | **Missing** — no timing is captured anywhere |
| Fork at a message | **Missing** — `parent_id` is written linearly and read by nothing |
| Edit and resend | **Missing** |

So a third of the complaint is a **discoverability defect**, not a feature gap: the row is invisible
until hover and therefore unreachable on a touch device, where there is no hover at all.

**Both read paths are flat today.** `getAgentHistory` (what the model sees) and `getConversation`
(what the user sees) each do `ORDER BY created_at` across every row in the thread. Introducing
branches changes what "the conversation" *is*, which is why this cycle is architectural rather than
additive.

**The existing chain is continuous.** `appendMessages` chains each new message from the thread's
current newest row, across turns — so every existing conversation is already a valid linear path and
can be backfilled, with no legacy/branched split in the code.

## Decisions locked during brainstorming

| Decision | Choice |
| --- | --- |
| Scope | All five items in one cycle (decomposition was offered and declined) |
| Action row | **Always visible**, low contrast — not hover-revealed |
| Regenerate | **Branches**; the previous reply stays reachable |
| Edit a user message | **New branch from the same parent**; the original stays reachable |
| Metrics shown inline | **tok/s + duration**; token breakdown and model move to the hover detail |
| Branch UI | AI Elements' branch components, used as **presentation only** |

## Architecture

### 1. The branching model

**Schema.** `conversations.active_leaf_id` (uuid, nullable) names the leaf of the branch currently
displayed. `conversation_messages.parent_id` is unchanged — it is already correct, merely unread.

**Both read paths walk the active path.** Start at `active_leaf_id`, follow `parent_id` to the root,
reverse. A single Postgres `WITH RECURSIVE` does the walk per thread rather than N round-trips.

> **`getAgentHistory` and `getConversation` must return the same path.** If they diverge, the model
> answers a different conversation than the one on screen, and nothing in the UI would reveal it.
> This is the single sharpest failure mode in the cycle and is asserted directly against a branched
> fixture.

**Migration.** Backfill `active_leaf_id` to each thread's newest message. Because the chain is
continuous, every existing conversation becomes a valid single-branch tree — no special-casing.
The column stays nullable purely as a safety net: null falls back to today's flat read rather than
rendering an empty thread.

**One primitive, three operations.** Each appends a child to a chosen parent and re-points
`active_leaf_id` at the new leaf. Nothing is ever deleted or overwritten:

| Operation | Parent of the new message |
| --- | --- |
| Fork at a message | that message |
| Edit a user message | that message's parent |
| Regenerate a reply | that reply's parent |

**Branch count is sibling count** — children sharing a `parent_id`. That feeds the `‹ 2/3 ›` pager;
switching re-points `active_leaf_id` at the chosen sibling's deepest descendant.

**Writes must chain from the active leaf, not the thread's newest row.** `appendMessages` currently
selects the newest row as the parent, which stops being correct the moment the active branch is not
the newest. The WS turn path and the unfinished-turn rescue added in `8998085` both have to pass the
leaf.

**`conversations.message_count`** keeps counting *all* rows in the thread, including inactive
branches, because it is an incrementing counter and re-deriving it per read would cost a walk on
every rail query. It therefore may exceed the number of messages displayed once a thread is
branched. Stated here because it is a visible oddity, not a bug.

### 2. The UI

**The AI Elements branch components are used as presentation only.** `MessageBranch` collects VNodes
from its default slot and pages between them — it expects every variant rendered client-side at
once. Ours live server-side and only the active path is fetched, so `MessageBranchPrevious`, `Page`
and `Next` are driven from our own state and the collecting wrapper is skipped. This is the same
call cycle 67 made about `PromptInput`: take the primitives when the wrapper's model does not match.

**The pager renders only on messages that have siblings**, so an unbranched thread looks exactly as
it does today.

**Switching a branch is a server round-trip** — `PATCH` the conversation's `active_leaf_id`, then
invalidate the query. Everything below the switch point changes, so re-reading beats patching the
list client-side; it also makes a switch survive reload and stay consistent across devices, matching
the rest of the app's live-by-default behaviour.

**Entry points:**
- **Regenerate** — today's retry button, rewired from `truncateForRetry` to a branch. This is a
  behaviour change to an existing control: retry stops destroying the previous reply.
- **Edit** — a pencil on user messages; opens inline, resubmits as a new branch.
- **Fork** — available on any message; starts a fresh branch from that point.

**Unchanged:** the thread rail lists conversations, not branches. Branches are a within-thread
concept, and surfacing them in the rail would be a second navigation model for the same thing.

### 3. Metrics, the action row, and Persona

**Timing is captured in the WS turn and stored in the existing `usage` jsonb** — no new column,
since `usage` already carries per-message model and token data. Three fields: `startedAt`,
`ttftMs` (start → first assistant token) and `durationMs` (start → finish). The `emit` closure
already observes every `transcript` event, which is where the first token lands.

**A stated inaccuracy rather than a hidden one:** a turn with tool calls spends most of its
wall-clock waiting on tools, so `outputTokens ÷ duration` understates generation speed. tok/s is
computed over `durationMs − ttftMs`, which still includes tool gaps, and **duration is displayed
beside it** so a slow figure is attributable. Accumulating only streaming intervals would be more
accurate and more machinery than a monitoring readout justifies; if the numbers prove misleading in
use, that is a follow-up with real data behind it.

**The action row drops `opacity-0 group-hover:opacity-100`** and is permanently visible in
`text-dimmed`. It carries copy, regenerate (assistant), edit (user), fork (any), and inline
duration + tok/s. The token breakdown and model move into the existing hover detail.

**Persona** goes from `size-40` to roughly `size-56 sm:size-72` at the hero, keeping
`aspect-square` and the cycle-65 invariant that exactly one Rive canvas is mounted at a time. The
composer's inline `size-7` is unchanged — it is a status dot, not a portrait.

## Testing

**Pure:** path-walking (tree + leaf → path), sibling indexing for the pager, and the tok/s maths
including divide-by-zero, missing timing, and a zero-output turn.

**DB (`*.db.test.ts`, `pnpm test:db`):**
- each of the three operations produces the correct `parent_id` edge and leaf
- the recursive CTE returns exactly the same rows as a hand-walked chain
- the backfill leaves every pre-existing thread on its true last message
- **`getAgentHistory` and `getConversation` return identical paths** for a branched fixture

**Browser (`playwright-cli`, never the MCP):** create a branch and switch between branches; reload
and confirm the switch persisted; regenerate leaves the previous reply reachable; edit leaves the
original question reachable; metrics render on a real turn; the action row is visible without
hovering; Persona at both sizes; light and dark; 1440 and 375 px.

## Out of scope

- Branches in the thread rail; deleting, merging or renaming branches. Fork is the primitive;
  managing forks is a later cycle if it is ever wanted.
- Re-deriving `message_count` per branch.
- Anything on `/sessions/[id]` or the voice studio.

## Risks

1. **The two read paths drifting apart.** Mitigated by asserting them equal on a branched fixture,
   but it is the failure that would be least visible in use.
2. **Writes chaining from the wrong parent.** `appendMessages`, the WS turn, and the rescue path all
   need the leaf; missing one silently grafts a turn onto the wrong branch.
3. **A behaviour change to an existing control.** Retry becomes non-destructive. Desirable, but
   someone relying on the old truncation semantics would be surprised; it belongs in the handover.
4. **Scope.** Five items including a data-model change in one cycle. Decomposition was offered and
   declined; the branching work will dominate the review surface, and the smaller items should not
   be allowed to ride through review on its coat-tails.
