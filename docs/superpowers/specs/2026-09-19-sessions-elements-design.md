---
title: "/sessions/[id] on AI Elements — paginated, virtualized, filterable (cycle 66)"
cycle: 66
date: 2026-09-19
status: spec
supersedes: null
mymind_task: 14d0074b
---

# `/sessions/[id]` on AI Elements (cycle 66)

Cycle 3 of the four-cycle "agent surfaces on AI Elements" program. Cycle 64 moved `/agent`'s
conversation onto AI SDK `UIMessage`s rendered with AI Elements Vue; cycle 65 rebuilt the `/agent`
page around them. This cycle brings the **session transcript** — the read-only view of ingested
Claude Code sessions — onto the same row-level components, and fixes the three things that make it
slow to work with today.

Cycle 67 (voice studio + Home) remains after this.

## Why this cycle exists

`/sessions/[id]` renders transcripts of sessions ingested from Claude Code. It was built before the
Elements components existed, so it hand-rolls everything: a fixed-height virtual list, plain-text
bodies clamped at 300 characters, and tool calls reduced to a warning badge plus `args`/`result`
truncated to 500 characters of raw JSON in a `<pre>`.

The owner uses this page to **scan and audit at speed** — jump in, find something, spot a tool call,
check an error — not to read sessions end to end. Three things get in the way, all named by the
owner during brainstorming:

1. **Tool calls are unreadable.** A badge and truncated JSON. You cannot tell what a tool did or
   whether it worked without leaving the row.
2. **There is no filtering.** One flat stream, including 5,099 sidechain (subagent) messages, with
   no way to narrow by tool or find text.
3. **The whole session loads at once.** Every message and every tool event, in one query, however
   large the session.

## What the data actually looks like

Measured against prod on 2026-09-19. These numbers drive the design; they are not estimates.

| Metric | Value |
| --- | --- |
| Sessions | 671 |
| Messages per session | p50 **112** · p95 **1,300** · max **5,622** |
| Sessions over 500 messages | 143 |
| Sessions over 2,000 messages | 13 |
| Tool events per session | avg 170 · max **3,122** |
| Largest single message | **279,751 chars** (avg 239) |
| Messages total | 228,692 (42,084 carry `thinking`, 5,099 are sidechain) |

**The finding that shapes the API:** 58,417 messages — **26% of all messages** — share a `created_at`
with another message in the same session, and the largest single tie group holds **615 messages at
one identical timestamp**. The transcript currently orders by `created_at` alone, so the order
within those groups is already unspecified and may differ between requests. A timestamp-only
pagination cursor would silently skip or repeat entire blocks.

Existing indexes: `messages` has `session_id`, `created_at DESC`, a content trigram index
(`messages_content_trgm`) and an HNSW embedding index — but **no `(session_id, created_at)`
composite**. `tool_events` has `session_id` and `tool_name` indexes. 163 distinct tool names exist
across all sessions.

## Decisions locked during brainstorming

| Decision | Choice |
| --- | --- |
| Primary use | Scanning / auditing at speed, not end-to-end reading |
| Open position | **Newest first**; infinite scroll loads **older** pages upward |
| Retention | **Keep virtualizing** — pages accumulate in memory, only the visible window is in the DOM |
| Message bodies | **Markdown, clamped, expandable in place** |
| Filters in scope | Hide sidechain · by tool name · find-in-session |
| Filters rejected | "Only tools / only errors" role filter — not worth its place |
| Read-around-a-search-hit | **Deferred** (see Out of scope) |

## Architecture

### 1. Ordering and the cursor

Every query orders by **`(created_at, id)`**. `id` is a UUID — an arbitrary but *stable* tiebreak.
This makes ordering deterministic for the 26% of rows in tie groups, which is a correctness fix in
its own right, independent of pagination.

The pagination cursor is that same composite, opaque to the client:

```
cursor := base64("<createdAt ISO>|<id>")
```

Encoding and decoding are pure functions in `shared/utils/session-cursor.ts`, unit-tested including
a malformed-cursor case (which must be rejected, not coerced).

A migration adds `index on messages (session_id, created_at desc, id desc)`. Keyset pagination over
a 5,622-row session without it is a scan.

### 2. The paginated endpoint

`GET /api/sessions/:id/messages` gains:

| Param | Meaning |
| --- | --- |
| `before` | cursor; return the page immediately **older** than it |
| `limit` | page size, default **100**, hard-capped at 200 |
| `hideSidechain` | `is_sidechain = false` |
| `tool` | messages having a tool event with this `tool_name` |
| `q` | `content ILIKE %q%`, using `messages_content_trgm` |

It returns:

```ts
{
  messages: SessionMessageDTO[]   // newest-first within the page
  toolEvents: SessionToolEventDTO[] // ONLY those whose messageId is in this page
  nextCursor: string | null        // null when exhausted
}
```

`?since=` is unchanged and keeps serving live-tail. The two modes are mutually exclusive; passing
both is a 400 rather than a guess.

**Page order vs display order.** The endpoint returns each page **newest-first**, because that is the
direction pagination walks. The transcript still *displays* chronologically, oldest at the top — a
session reads top-down. So the client reverses each page and prepends it above what it already holds.
Stated explicitly because getting these two backwards is the easiest way to build a transcript that
reads in reverse.

**Tool events stop shipping wholesale.** Today `getSessionMessages` fetches *every* tool event for
the session on *every* request regardless of `since` — up to 3,122 rows — and the client de-dups by
id to cope. Each page now carries only its own messages' tool events, and the client-side de-dup is
deleted along with the behaviour that required it.

**Filters are server-side, never client-side.** With pagination, filtering in the client would make
"load 100" yield an arbitrary number of visible rows. Every filter is a `WHERE` clause, so a page is
always `limit` visible rows (or the end of the session).

The `tool` dropdown needs the session's own tool names, not all 163. The session meta response
(`GET /api/sessions/:id`) gains `toolNames: string[]` — a `select distinct tool_name … where
session_id = $1`, which the existing `tool_events_session_idx` already covers.

### 3. The transcript component

**Elements row primitives, not the Elements `Conversation`.** `Conversation` owns its own scroll
container and stick-to-bottom behaviour, which fights a virtualizer. `SessionTranscript` keeps
ownership of scrolling and adopts the row-level components, which is where the visual gain is:

| Row | Renders with |
| --- | --- |
| user / assistant body | `Message`, `MessageContent`, `MessageResponse` (markdown) |
| `thinking` | `Reasoning`, `ReasoningTrigger`, `ReasoningContent` |
| tool event | `Tool`, `ToolHeader`, `ToolContent`, `ToolInput`, `ToolOutput` |

**An adapter, not a shared component.** `/agent` renders AI SDK tool parts, whose `state` is a
machine (`input-available` → `output-available` / `output-error`). A session tool event has
`args`, `result`, `exitStatus` and `phase` instead. A pure function bridges them:

```ts
// app/lib/sessions/tool-state.ts
sessionToolState(event: SessionToolEventDTO): {
  state: 'output-available' | 'output-error'
  input: unknown
  output: unknown
}
```

It lives beside cycle 64's `toolOutcome` / `toolEnvelope` helpers in spirit, is unit-tested, and
keeps `SessionTranscript` from growing a second tool-rendering dialect. `ToolHeader` is reused
as-is — it already accepts a `dynamic-tool` type with an explicit `toolName`.

**Virtualizer swap.** `@vueuse/core`'s `useVirtualList` assumes a fixed row height (today a 140px
guess, with a comment admitting rows are height-bounded to make the guess survivable). Rendered tool
cards, markdown and expand-in-place make heights genuinely variable, so this moves to
**`@tanstack/vue-virtual`**, which measures rows via `measureElement` and supports reverse /
bottom-anchored lists. Same family as the `@tanstack/vue-query` already in the app.

Per the repo's bundle-weight rule, the change is measured: compare `.output/public/_nuxt/*.js` count
and gzip total before and after, and build once at 4096 MB. `@vueuse/core` stays (used widely
elsewhere); only this one usage moves.

**Scroll anchoring is the load-bearing detail.** When a page of older messages is prepended, the
viewport must stay on the row being read. This is the piece that makes upward infinite scroll feel
broken when it is subtly wrong, and it is built test-first and proven in a browser.

**Row bodies clamp and expand in place**, with a hard character cap on the expanded form so the
279,751-char message cannot blow out the list even when opened. Expanding triggers re-measurement.

### 4. Live-tail

The page already watches `meta.messageCount` and fetches a `since` delta when it grows. That
survives, with one change: **the delta request carries the active filter params**, so a session
still being ingested does not start appending rows the current filter excludes.

New messages land at the bottom (the newest end), which is where the view opens — so live-tail and
the open position agree.

### 5. Error handling

A failed older-page fetch **must not discard loaded pages**. The list keeps what it has and shows a
retry affordance at the top. The current component has no page-level failure state because it has no
pages; this is new behaviour, and it is tested.

A malformed or unknown cursor returns 400. The client treats that as "start over", not as an empty
session, so a stale bookmarked state cannot render as "no messages".

## Testing

**Unit (pure functions):**
- cursor encode/decode round-trip, plus rejection of malformed input
- `sessionToolState` across `exitStatus` values, missing results, and non-string results
- filter params → query conditions

**Server:**
- pagination walks a session with **no gaps and no repeats** — asserted against a tie group, using
  the real shape from prod (615 rows at one timestamp) as the fixture. A timestamp-only cursor must
  fail this test; that is the point of it.
- each page's `toolEvents` contains exactly the events for that page's messages
- `before` + `since` together → 400

**Browser (`playwright-cli`, per the project rule — never the MCP):**
- scroll anchoring holds when an older page is prepended
- expand-in-place re-measures without jumping the viewport
- each filter narrows the list and resets to a clean first page
- a large session (one of the 13 over 2,000 messages) scrolls smoothly

## What gets deleted

- the fixed-height `useVirtualList` wiring and its 140px estimate
- the 300-character line clamp on message bodies
- the raw `<pre>` JSON dumps of tool `args` / `result`
- the client-side tool-event de-dup, and the whole-session tool-event fetch that required it

## Out of scope

- **Read-around-a-search-hit.** Landing on a specific message from global search and loading context
  around it is a different cursor mode (N before and N after an anchor). Explicitly deferred; the
  `q` filter narrows the list to matches instead.
- The `/sessions` index page — unchanged this cycle.
- Session summarization, embeddings, project reassignment — unrelated subsystems.
- Cycle 67 (voice studio + Home) — its own spec.

## Risks

1. **Scroll anchoring on prepend.** The most likely thing to ship subtly wrong. Mitigated by
   test-first construction and browser proof; it is also the one item that would justify its own fix
   round.
2. **A new virtualization dependency.** `@tanstack/vue-virtual` is small and well-maintained, but the
   repo has been bitten twice by build memory (cycle 64 shiki, cycle 65 Tailwind). Measure the
   bundle and build at 4096 MB before believing it is free.
3. **The composite index on a 228k-row table.** Creating it is fast at this size, but the migration
   runs on prod eventually; it is additive and non-blocking, and should be stated as such in the
   handover.
4. **Ordering changes for 26% of rows.** Adding `id` as a tiebreak means some tie-group rows will
   render in a different order than before. This is a fix, not a regression — but it is a visible
   change and belongs in the handover.
