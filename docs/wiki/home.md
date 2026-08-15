---
title: Home dashboard — the app's front door
status: shipped (unmerged — branch feat/home-dashboard)
cycle: 56
updated: 2026-08-15
---

# Home dashboard — `/`

**status: shipped, unmerged.** Built on `feat/home-dashboard` (cycle 56); not yet merged to
master, not yet deployed. Gates green (typecheck 0 / test 1158 across 150 files / build
clean) and browser-validated on dev. See the [roadmap](../superpowers/plans/00-roadmap.md)
row 56 and the [cycle-56 handover](../handovers/2026-08-15-home-dashboard.md).

`/` used to redirect straight to `/documents`, reopening whatever markdown file was last
open (`mm.lastDoc`). It now renders a dashboard: an awareness surface answering "what
happened?" over a recent window, plus the actionable state of the app beside it. It is a
**read/glance surface, not a triage board** — mutating actions live on their own pages
(`/tasks`, `/review`, `/activity`); Home links out to them rather than duplicating their UI.

## Route and range

`app/pages/index.vue` is the dashboard — the redirect is gone. Two places used to send you
there and both had to change: the page component itself, **and** a `'/': { redirect:
'/documents' }` entry in `nuxt.config.ts`'s `routeRules`. A `routeRules` redirect pre-empts
the page component entirely, so removing only the component would have shipped an
unreachable dashboard. `nuxt.config.ts` now only redirects `/voice` → `/agent`.
`app/pages/login.vue`'s post-login `navigateTo` also retargets to `/` (was `/documents`).
`/documents` is unchanged otherwise — it keeps its own `mm.lastDoc` restore, it just isn't
the front door anymore.

Four range buttons in the navbar (`UFieldGroup`, not `UButtonGroup` — that component doesn't
exist in the installed Nuxt UI v4): **`1d 3d 7d 30d`**, default **`3d`**, persisted in a
`mm.home.range` cookie (`shared/types/home.ts` → `HOME_RANGE_KEYS` / `HOME_RANGE_DEFAULT`).

**This is a third, deliberately separate range vocabulary.** The app now has three:

| Type | Values | Backing |
|---|---|---|
| `RangeKey` (cycle 44) | `1h 6h 24h 7d` | Prometheus, step-derived |
| `UsageRangeKey` (cycle 55) | `7d 30d 90d all` | Postgres, daily buckets |
| `HomeRangeKey` (this cycle) | `1d 3d 7d 30d` | Postgres, daily buckets |

All three spell `7d` (two spell `30d`) and none mean the same query. They stay separate
types with separate refs — a shared ref would typecheck while silently querying the wrong
window the moment two surfaces' selections diverged.

## Data — one endpoint

`GET /api/home?range=1d|3d|7d|30d` (`server/api/home.get.ts`, thin: validates the range via
`isHomeRange`, 400s on anything else, delegates to `getHome()`) returns every DB-backed panel
in one `HomeResponse` payload (`server/services/home.ts`): metrics + deltas, usage, timeline,
attention, active tasks, recent projects. One round trip, one `['home', range]` query key, one
skeleton, one error state — the alternative (a `useQuery` per panel on the app's most-visited
page) would be eight skeletons and eight failure modes.

**Rig health is deliberately NOT part of that payload.** `app/components/home/RigHealth.vue`
self-fetches `['analytics', 'snapshot']` (the cycle-44 endpoint, which hits Prometheus) with
`retry: false`, so a dead rig degrades to one "Unavailable" tile instead of failing the whole
page. `up === false` renders red (`✕`), `up === true` green (`✓`), `up === null` (unscraped,
not down) neutral (`–`) — collapsing that three-way state into a boolean would misreport "no
data" as "down". Each badge carries an `aria-label` (`"<service>: <state>"`) — the `title`
attribute alone is hover-only and unreachable on touch/screen readers.

`getHome()` fans out `metrics`, `attention`, `timelineEvents`, `activeTasks`,
`recentProjects`, and `getUsageSince(start)` via `Promise.all`. Every DB query is written out
by hand per table (no `sql.raw`'d identifiers anywhere in the file, so nothing there ever
needs review for injection). Every soft-deletable source (`documents`, `images`, `tasks`)
filters `deleted_at is null`; `memories` filters `archived_at is null`. Per-source event rows
are capped at `PER_SOURCE_LIMIT = 200` before grouping, each with its own `order by ... desc
limit 200` **inside** the CTE branch, so a cap takes the newest rows of that source, not an
arbitrary 200.

### The usage split — `getUsageSince`

`/api/analytics/usage` only accepts `UsageRangeKey` and 400s on `1d`/`3d`. Rather than widen
that enum (which would put `1d`/`3d` buttons on the Analytics tab where they don't belong),
`server/services/usage.ts` was split: `getUsage(range: UsageRangeKey)` now derives its start
date and delegates to `getUsageSince(start: Date | null)`, which does the real work and is
callable directly with any `Date`. Home calls `getUsageSince(homeRangeStart(range))` and reads
only `.totals` and `.unpriced` off the result — each surface owns its own range vocabulary and
passes a `Date`, no shared enum, no duplicated pricing math. `getUsage`'s signature and every
existing caller are unchanged.

### The required index

`messages.created_at` had no index — every `getUsage`/`getUsageSince` call was a sequential
scan over the full `messages` table (~147k rows in prod), and Home puts that query on the
landing page, on every load. Migration `0032` adds
`messages_created_at_idx` (`btree`, `created_at desc nulls last`). No other schema change in
this cycle.

## Timeline grouping — `server/lib/home/timeline.ts`

`buildTimeline(events, opts?)` is a pure function: date-filtered `RawEvent[]` in, an ordered
`HomeTimeline` out. No DB access, no Date.now() dependency beyond what's passed in — fully
unit-tested.

1. **Bucket** every event by `(UTC day, type)`. Day boundaries are pinned to UTC
   (`utcDay()` = `date.toISOString().slice(0, 10)`) — the cycle-55 lesson about day-bucketing
   drifting with server timezone.
2. **Collapse** each bucket if its type allows it and it holds more than the threshold:
   - `session` and `error` **never collapse** — each is individually actionable. Sessions
     are the headline units of "work I did"; an error like `embeddings:all-failed` must never
     become "3 events" (that's the exact failure that motivated this whole page — it sat as a
     grey `41` in the sidebar for 9 days before anyone read it as 41 individual failures).
   - `memory`, `document`, `image`, `clipboard`, `task`, `conflict` collapse when a day holds
     **more than `COLLAPSE_THRESHOLD` (3)** of that type — 4+ becomes one row ("7 memories
     learned"), naming the newest two by title and linking to the filtered list. Exactly 3
     renders as 3 individual rows.
3. **Sort** newest-first across the whole set, then **cap** at `TIMELINE_CAP` (60). `total` on
   the response is the uncapped post-grouping count — truncation is always disclosed
   ("Showing 60 of 214") via `HomeTimeline.shown < HomeTimeline.total`, never silently
   dropped.
4. **Re-group** the capped, sorted rows back into `TimelineDay[]` sections, preserving order.

Entry shape: `{ id, type, at, title, subtitle?, projectSlug?, href, count? }` — `count` is
present iff the row is a collapsed group. Every row's `href` is always populated; the UI never
renders a bare `<div @click>` (the audit found `/tasks` and `/projects` do exactly that, with
zero focusable elements in `main`).

## Live reactivity

`['home', range]` (actually invalidated as the whole `['home']` key, matching every range at
once) is touched by nine of the twelve `ResourceName` members: `document`, `image`, `memory`,
`review`, `project`, `task`, `session`, `clipboard`, `activity`. Each of those entries in the
`OVERRIDES` map in `app/utils/live-dispatch.ts` calls a shared `invalidateHome()` helper on
top of its existing default (detail + list) invalidation — no pre-existing per-resource
invalidation was dropped.

`invalidateHome` is **trailing-debounced at `HOME_DEBOUNCE_MS = 700`** (`useDebounceFn`),
matching the pre-existing `GRAPH_DEBOUNCE_MS`. Both collapse the same burst shape — a Claude
Code session streaming in fires many resource events in a few seconds, and without debouncing
that would refetch the whole dashboard once per event. The comment above
`GRAPH_DEBOUNCE_MS` that used to claim "this is the ONLY invalidation debounced here" was
corrected in the same change — it no longer is. `HomeQuickCapture.vue` also calls
`invalidateQueries({ queryKey: ['home'] })` directly (undebounced) right after its own POST
succeeds, so the acting tab's own capture shows up immediately rather than waiting on the
debounce window for the server-side `publishChange` round trip.

## Panels

Layout: metrics strip across the top, timeline in the wide left column (`lg:col-span-2`),
five panels stacked in a right rail. Below `lg` the rail drops under the timeline in the same
DOM order (not reordered, not tabbed).

| Panel | Component | Range-scoped |
|---|---|---|
| Metrics strip | `MetricsStrip.vue` | totals no, deltas yes |
| Rig health | `RigHealth.vue` (self-fetches, separate query) | no |
| Timeline ("What happened") | `Timeline.vue` / `TimelineRow.vue` | **yes** |
| Needs attention | `NeedsAttention.vue` | **no** |
| Quick capture | `QuickCapture.vue` | — |
| Ask the brain | `AskBrain.vue` | — |
| Active tasks | `ActiveTasks.vue` | no (always the current 5) |
| Recent projects | `RecentProjects.vue` | yes |

All eight are dumb presentational components taking props from the single `/api/home`
payload (`RigHealth` is the one exception — it fetches its own snapshot). None fetch panel
data of their own, which keeps the one-query invariant enforceable.

**Metrics strip.** Sessions / Memories / Documents tiles (`fmt()`: `k`/`M` suffixed) plus a
Tokens tile carrying cycle 55's **API-equivalent value** ("at API rates — not billed" — Claude
Code is subscription-billed, this is never real spend) and Rig health. If any usage model has
no `model_prices` row (cold start after a fresh deploy), the tile shows "N model(s) unpriced —
value pending" instead of a bare `$0.00`.

**Needs attention — deliberately not range-scoped.** Four absolute-backlog counts: unacked
errors (`activity_log`, severity `error`, `acked_at is null`), memory conflicts
(`review_queue`, `status = 'pending'`), unreviewed memories (`reviewed_at is null`), unfiled
captures (`documents` under `/input/%`). 13 conflicts is 13 conflicts whether you're looking
at 1d or 30d — scoping it to the selected range would make the queue appear to clear as you
narrow the window, which is the exact failure this page exists to prevent. Verified live: the
attention panel's text is byte-identical between `range=1d` and `range=30d` while the timeline
underneath it changes completely. Each row is `n === 1 ? one : many` (irregulars spelled out,
not `+ 's'`), zero-filtered, and the header badge is the **sum** of outstanding items across
categories, not the count of non-zero categories — a page built because a quiet "2" badge
let 71 unacked errors hide for nine days must not repeat that with its own badge.

**Active tasks.** In-progress/todo/blocked, capped at 5, overdue-first (`order by overdue
desc, due_date asc nulls last`). Overdue renders as a colored **text** badge ("overdue"), not
color alone.

**Recent projects.** Up to 5 projects with at least one session, memory, document, or task
whose activity falls inside the range ("touched"), ranked by most recent activity. The
`touched` CTE unions four branches, each capped at `PER_SOURCE_LIMIT` (200) with its own
`order by ... desc limit 200` inside the branch. That cap is **global across projects, not
per-project** — a project can in principle drop out of a source's top-200 if 200+ more recent
rows from *other* projects exist in the same window; accepted as very unlikely at this app's
scale.

**Quick capture / Ask the brain.** Neither fetches data. Quick capture posts to
`/api/capture/note` and invalidates `['home']` directly on success (see Live reactivity
above). Ask the brain never calls a model itself — see next section.

## The `/agent?q=` hand-off

Ask the brain does `navigateTo({ path: '/agent', query: { q } })` — **navigate only, never
send.** `/agent`'s page (`app/pages/agent/index.vue`) reads `?q=` and passes it as an
`initialText` prop into `app/components/voice/Composer.vue`, a new optional prop
(`initialText?: string`) that seeds the composer's private `text` ref
(`ref(props.initialText ?? '')`) plus a non-immediate `watch` on `initialText` so a second
Ask hand-off while already on `/agent` (same route, new `?q=`) also lands, which a simpler
`onMounted`-only seed would have missed. The user still has to press send — auto-sending
straight from a URL was rejected because it would fire a real model call on any bookmark or
back-button navigation into `/agent?q=...`.

## Errors and empty states

- `/api/home` fails → page-level `UAlert` with a Retry button, driven off the query's `error`
  ref (per the live-data convention: watch `error`, never `isFetching`).
- Rig snapshot fails → that one tile reads "Unavailable"; the other panels are unaffected
  (`retry: false` on its own query so a down rig can't retry-storm).
- No usage price rows (post-deploy cold start, see cycle 55) → the value tile shows the
  unpriced note, never a bare `$0.00`.
- Empty range → "Nothing in the last {range}. Try a wider range." (not the command palette's
  bare "No data").
- Zero attention items → "Nothing waiting."
- Zero active tasks → "Nothing in progress."
- Zero recent projects → "No project activity in this range."

## Mobile (< `sm`, validated at 390×844)

DOM order is unchanged from desktop — nothing is reordered or tabbed:

- **Metrics strip** becomes a horizontally-scrollable row (`overflow-x-auto` below `sm`,
  `grid` at `sm+`) rather than wrapping or shrinking tiles illegibly. This is why a raw
  "does any element's right edge exceed the viewport" scan reports non-zero at 390px — those
  elements are metrics tiles inside their own scrollable container, confirmed contained (the
  container's own right edge sits inside the viewport, and `document.documentElement`'s
  `scrollWidth === clientWidth`, i.e. no page-level horizontal scroll).
- **Timeline** caps its visible rows at `MOBILE_PREVIEW = 12` with a "Show N more" / "Show
  less" toggle (`Timeline.vue`) — progressive disclosure of rows the server already sent, not
  a second re-grouping of server data. This is orthogonal to the server-side 60-row cap and
  its "Showing X of Y" disclosure, which still applies underneath it.
- **Range buttons** sit in a `shrink-0` `UFieldGroup` in the navbar specifically so they don't
  clip past the viewport — the Tasks page's "New task" CTA currently does exactly that
  (clips ~20px off-screen at 390px) and Home must not repeat it.
- Every actionable element (rig badges, range buttons, timeline rows, Capture button, task
  rows) is a real interactive element with real text/aria content — none rely on `:hover` to
  become visible or reachable (the Clipboard page's 16 Copy buttons are all `opacity: 0` on
  touch; Home has zero elements matching that pattern).

## Files

`app/pages/index.vue` (layout + range state) · `app/components/home/{MetricsStrip,
RigHealth, Timeline, TimelineRow, NeedsAttention, QuickCapture, AskBrain, ActiveTasks,
RecentProjects}.vue` · `server/api/home.get.ts` · `server/services/home.ts` ·
`server/lib/home/{timeline,range}.ts` · `shared/types/home.ts` · migration
`0032_abandoned_carlie_cooper.sql` (`messages_created_at_idx`) · `server/services/usage.ts`
(`getUsageSince` split, `getUsage` unchanged) · `app/utils/live-dispatch.ts`
(`invalidateHome`, `HOME_DEBOUNCE_MS`) · `app/components/voice/Composer.vue`
(`initialText` prop) · `app/pages/agent/index.vue` (`?q=` read) · `nuxt.config.ts`
(`/` redirect removed) · `app/pages/login.vue` (post-login target).

Tests: `test/home-range.test.ts`, `test/home-timeline.test.ts`,
`test/live-dispatch.test.ts` (existing file, extended for `HOME_DEBOUNCE_MS`/`invalidateHome`),
`test/home-endpoint.db.test.ts` (real-Postgres, `pnpm test:db` only — not in the CI/deploy
gate, same pattern as the cycle-55 `.db.test.ts` files).
