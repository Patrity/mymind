---
title: Home dashboard — the app's front door
cycle: 56
date: 2026-08-15
status: spec — approved in brainstorm, not yet planned
related:
  - ../../explorations/2026-08-15-ux-audit-product.md (the audit that motivated this — finding P1)
  - ../../wiki/analytics.md (cycles 44 + 55 — the usage + rig-health data this reuses)
  - ../../wiki/projects.md (the `/projects/[slug]` dashboard whose shape this follows)
  - ../specs/2026-06-12-live-reactivity-design.md (the `publishChange` contract this rides)
  - ../../handovers/2026-08-14-token-cost-analytics.md (cycle 55 — most recent)
---

# Home dashboard (cycle 56)

## Why

MyMind's stated purpose is "a centralized entry point to all of it." Today `/` redirects to
`/documents`, which restores a `mm.lastDoc` cookie and reopens the last markdown file you had
open. The front door is a text editor scoped to one of seven content types.

The cost is measurable. At the moment the audit ran, the app knew all of this and surfaced
none of it on arrival:

| Signal | Value |
|---|---|
| Memory conflicts awaiting a decision | 13 |
| Unreviewed memories | 15 |
| Unacked activity events | 41 |
| Newest error | `embeddings:all-failed`, 9 days old |

Embeddings failing wholesale is fatal for a semantic-search brain. It surfaced as a grey `41`
next to a nav item. Every one of those numbers is already a live query — the sidebar badges
prove it.

## What this is

A dashboard at `/` answering **"what happened?"** over a recent window, with the actionable
state of the app beside it. Decided in brainstorm:

- **Job:** an awareness surface, not a triage board. You read it and move on.
- **Streams:** all four — work done, what the brain learned, what you saved, work state + health.
- **Window:** default **3 days**, switchable 1 / 7 / 30. No last-visit tracking — no hidden
  state, no last-seen timestamp to persist.
- **Timeline shape:** one interleaved river, newest first, day headers. Not grouped-by-stream,
  not day-cards.
- **Page shape:** metrics strip on top, timeline in the wide left column, actionable panels in
  a right rail.
- **Mobile:** same DOM order, compacted. Not reordered, not tabbed.

## Layout

```
┌────────────────────────────────────────────────────────────┐
│ Home                                   1d · [3d] · 7d · 30d│
├──────────────┬──────────────┬──────────────┬───────────────┤
│ Sessions 597 │ Memories 1.2k│ 1.4B · $312  │ Rig ✓✕✓✓✓     │
├──────────────┴──────────────┴──────┬───────┴───────────────┤
│ What happened            last 3 days│ Needs attention    4  │
│ ● embeddings:all-failed             │ Quick capture         │
│ ● [mymind] Token & cost analytics   │ Ask the brain         │
│ ● 3 memories learned                │ Active tasks       3  │
│ ● Postgres pool note                │ Projects              │
│ ● [2d-rpg] Story-quest engine       │                       │
└─────────────────────────────────────┴───────────────────────┘
```

Below `md`: metrics become a horizontally scrollable row, the rail collapses under the
timeline, the timeline caps with "Show more". DOM order is unchanged between breakpoints.

## Panels

| Panel | Content | Range-scoped |
|---|---|---|
| Metrics strip | Sessions · Memories · Tokens + value · Rig health | deltas yes, totals no |
| Timeline | the interleaved river | **yes** |
| Needs attention | conflicts · unreviewed · unacked errors · unfiled `/input` | **no** |
| Quick capture | note + ⌘↵ | — |
| Ask the brain | input → `/agent?q=` | — |
| Active tasks | in-progress + overdue, 5 rows total (overdue first) | no |
| Recent projects | 5 most recently touched, ranked by newest activity | yes |

"Touched" for Recent projects means the project has at least one session, memory, document, or
task with activity inside the range.

**Needs attention is deliberately not range-scoped.** 13 conflicts is 13 conflicts whether
you're looking at 1d or 30d. Scoping it would make the queues appear to clear as you narrow
the range — the exact failure this page exists to prevent.

**The value tile keeps cycle 55's label, "at API rates — not billed."** Claude Code is
subscription-billed; that figure is what the usage *would* cost. Summing it with LiteLLM
spend is a bug, per the cycle-55 handover.

**Every timeline row is a real `<NuxtLink>` with an `href`** — never a `<div @click>`. The
audit found `main` on `/tasks` and `/projects` contains zero focusable elements because both
use bare clickable divs. Building home this way makes that regression structurally impossible.

## Timeline grouping

`server/lib/home/timeline.ts` — a pure function over already-date-filtered event arrays,
returning ordered entries with day boundaries. Collapse thresholds vary by type because
significance does:

- **Errors — never collapse.** Each is individually actionable. This is the reason the page
  exists; `embeddings:all-failed` must never become "3 events".
- **Sessions — never collapse.** They are the headline units of "work I did".
- **Memories, documents, images, clipboard, tasks, conflicts — collapse when a day holds more
  than 3 of that type** (4+ collapses; exactly 3 renders as 3 rows) into one row ("7 memories
  learned"), naming the top two and linking to the filtered list.

Global cap of **60 entries** after grouping. Truncation is **disclosed** — "showing 60 of 214,
see the full log" — never silent.

Entry shape: `{ id, type, at, title, subtitle?, projectSlug?, href, count? }`.
Day boundaries are pinned to **UTC** (cycle 55's day-bucketing lesson).

## Data

**One endpoint** — `GET /api/home?range=` returns the six DB-backed panel payloads (brain
counts + deltas, usage, timeline, needs attention, active tasks, recent projects) in a single
response: one round trip, one skeleton, one error state, one `['home', range]` key. Quick
capture and Ask the brain carry no fetched data. The alternative — an independent `useQuery`
per panel on the app's most-visited page — costs eight skeletons and eight failure modes.

**Rig health stays separate** (`['analytics','snapshot']`, cycle 44) because it hits
Prometheus. A dead rig must degrade one tile, not blank the page.

### Range vocabulary

```ts
// shared/types/home.ts
export const HOME_RANGE_KEYS = ['1d', '3d', '7d', '30d'] as const
export type HomeRangeKey = typeof HOME_RANGE_KEYS[number]
```

This is the **third** range vocabulary in the app and it collides on `7d`/`30d` while meaning
something different from both:

| Type | Values | Backing |
|---|---|---|
| `RangeKey` (cycle 44) | `1h 6h 24h 7d` | Prometheus, step-derived |
| `UsageRangeKey` (cycle 55) | `7d 30d 90d all` | Postgres, daily buckets |
| `HomeRangeKey` (this cycle) | `1d 3d 7d 30d` | Postgres, daily buckets |

They must stay separate types with separate refs. `shared/types/usage.ts` already carries the
warning: a shared ref "would typecheck while producing wrong queries." `HomeRangeKey` gets the
same comment.

Persisted in a `mm.home.range` cookie, alongside the existing `mm.documents.*` prefs.

### The usage collision

`/api/analytics/usage` accepts only `UsageRangeKey` and **400s on `1d` and `3d`**. Rather than
widen `USAGE_RANGE_KEYS` — which would put `1d`/`3d` buttons on the Analytics tab where they
don't belong — refactor `getUsage(range)` in `server/services/usage.ts` to derive its start
date and delegate to a new `getUsageSince(start: Date)`. Each surface then owns its own range
vocabulary and passes a `Date`. No shared enum, no duplicated pricing math.

### Required index

`server/services/usage.ts:51` filters `messages.created_at >= start`. The `messages` table has
only `messages_session_idx` and a unique on `(session_id, external_uuid)` — **no index on
`created_at`**. That is a sequential scan over ~147k prod rows, on the landing page, on every
load.

Cycle 55's handover logged this as a follow-up. This cycle makes it urgent and adds it:

```ts
index('messages_created_at_idx').on(t.createdAt)
```

## Live reactivity

`['home', range]` is a cross-type key touched by ~9 of the 12 `ResourceName` members
(`document`, `image`, `memory`, `review`, `project`, `task`, `session`, `clipboard`,
`activity`). It joins the existing `OVERRIDES` map in `app/utils/live-dispatch.ts` with an
`invalidateHome` helper, **trailing-debounced** via `HOME_DEBOUNCE_MS = 700` — matching
`GRAPH_DEBOUNCE_MS`, since both collapse the same burst shape and there's no reason for two
different figures.

This follows the `invalidateGraph` precedent exactly: `['graph']` is already a cross-type view
debounced at 700ms because an enrichment burst would otherwise refetch a ~1,900-node graph once
per event. A Claude Code session streaming in produces the same burst shape here.

The comment above `GRAPH_DEBOUNCE_MS` stating "this is the ONLY invalidation debounced here"
must be corrected in the same change — it stops being true.

## Errors and empty states

- `/api/home` fails → page-level error with retry, driven by watching the query's `error` ref.
  (The live-data rule: `error`, not `isFetching`.)
- Rig snapshot fails → that tile reads "unavailable"; the other eight panels are unaffected.
- `model_prices` empty → the value tile shows cycle 55's unpriced note, never a bare `$0.00`.
  That is the documented cold-start state after any deploy and reads as a bug if unlabelled.
- Quiet range → a real message ("Nothing in the last day — try 7d"), not the command palette's
  `No data`, which reads as a failure.
- Zero attention items → "Nothing waiting."

## Structure

```
app/pages/index.vue                 layout + range state only (replaces the redirect)
app/components/home/MetricsStrip.vue
app/components/home/Timeline.vue
app/components/home/TimelineRow.vue
app/components/home/NeedsAttention.vue
app/components/home/QuickCapture.vue
app/components/home/AskBrain.vue
app/components/home/ActiveTasks.vue
app/components/home/RecentProjects.vue
app/components/home/RigHealth.vue
server/api/home.get.ts              thin: validate range → service
server/services/home.ts             parallel per-panel queries
server/lib/home/timeline.ts         PURE merge/group/cap
shared/types/home.ts                DTOs + HomeRangeKey
```

Panels are dumb presentational components taking props from the single payload. None fetch
their own data — that keeps the one-query invariant enforceable and each panel independently
testable.

## Routing changes

- `app/pages/index.vue` stops redirecting; becomes the dashboard.
- `app/pages/login.vue` retargets its post-login `navigateTo('/documents')` to `/`.
- `app/middleware/auth.global.ts` is unchanged in behaviour (still sends unauthenticated users
  to `/login`); only the post-login landing moves.
- `/documents` keeps its `mm.lastDoc` restore untouched. It stops being the front door; it does
  not change.
- `/agent` gains a `?q=` param that **prefills the composer without sending** — the user still
  presses send. Auto-sending from a URL would fire a model call on any bookmark or back-button
  navigation. This is the one dependency home creates outside itself.

## Testing

**Unit**
- `buildTimeline`: collapse thresholds; errors and sessions never collapsing; ordering within
  and across days; the cap disclosing truncation rather than trimming silently; day boundaries
  in UTC.
- Range → date-window mapping for all four keys.

**Endpoint**
- `/api/home` payload shape; unknown range → 400.

**Browser (playwright-cli, 1280×800 and 390×844)**
- Every timeline row asserts as a real `<a>` with a populated `href` — tag and attribute, not
  presence. (The `ProjectBadge` bug passed every gate while rendering an inert `<nuxtlink>`.)
- Quick capture round-trips and the new item appears in the timeline via live invalidation.
- The range switch changes the timeline but leaves *Needs attention* unmoved.
- At 390px: no horizontal page scroll; the range switch does not clip (Tasks' "New task"
  currently runs 20px past the viewport); no action hidden behind hover (Clipboard's 16 Copy
  buttons are all `opacity: 0` on touch).

## Out of scope

Adjacent audit findings, each its own cycle. Folding any of them in makes this unshippable:

- **Titling captures.** `/input/9O8RQk4EOZ.md` — 3 of 3 user captures are machine-named, so
  browsing the inbox is impossible. The single highest-value follow-up.
- **Sidebar IA.** Four inboxes, four activity surfaces, conversations split across two stores
  under three names.
- **Login deep-link preservation.** `navigateTo('/login')` carries no `redirect`, so a
  bookmarked `/projects/mymind` lands you on the default page.
- **The document editor's silent data loss.** 1.5s autosave debounce, no dirty indicator, no
  navigation guard — reproduced losing typed text. Unrelated to home but the most severe open
  bug in the app.
