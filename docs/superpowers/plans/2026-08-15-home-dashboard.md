# Home Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `/` → `/documents` redirect with a dashboard that answers "what happened?" over a recent window, alongside the actionable state of the app.

**Architecture:** One `GET /api/home?range=` serves six DB-backed panels as a single payload consumed by one `['home', range]` vue-query key; rig health stays a separate query so Prometheus can die without blanking the page. All merge/group/cap logic lives in a pure, unit-tested `server/lib/home/timeline.ts`. Panels are dumb presentational components taking props — none fetch their own data.

**Tech Stack:** Nuxt 4 (SPA, `ssr: false`), Nuxt UI v4, `@tanstack/vue-query`, Drizzle + Postgres, vitest, playwright-cli.

**Spec:** [`../specs/2026-08-15-home-dashboard-design.md`](../specs/2026-08-15-home-dashboard-design.md)

## Global Constraints

- **Nuxt UI v4 for every control and container.** Buttons, inputs, cards, badges, links, alerts, skeletons are `U*` — never hand-rolled. Plain `<div>`/`<span>` are fine for grid/flex layout and for text nodes; the rule binds interactive and themed elements, not layout scaffolding. Invoke the `nuxt-ui-docs` skill before using a component — training-data knowledge of its props is stale.
- **Semantic colour tokens only.** `primary`/`error`/`neutral`, `text-muted`/`bg-elevated`/`border-default`. Never `text-gray-200`, `bg-purple-600`, `slate-*`, `zinc-*`.
- **Every timeline row is a real `<NuxtLink>` with a populated `href`.** Never a `<div @click>`. Tests assert tag + href, not presence.
- **Day boundaries are UTC.** `date_trunc('day', created_at AT TIME ZONE 'UTC')` in SQL; `.toISOString().slice(0,10)` in TS.
- **`HomeRangeKey` is its own type.** Never import or widen `RangeKey` (cycle 44) or `UsageRangeKey` (cycle 55). They collide on `7d`/`30d` and mean different things.
- **Needs attention is NOT range-scoped.** Its four counts ignore `range` entirely.
- **The value tile label is exactly "at API rates — not billed".** Never summed with LiteLLM spend.
- **Every successful mutation calls `publishChange`** (`server/utils/live-bus.ts`) after the DB commit.
- **Gates:** `pnpm typecheck` → 0, `pnpm test` → all green, `pnpm build` → clean. Lint is red repo-wide and is NOT a gate.
- **`pnpm` only.** Never npm/yarn.

---

### Task 1: Shared types and range mapping

**Files:**
- Create: `shared/types/home.ts`
- Create: `server/lib/home/range.ts`
- Test: `test/home-range.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `HOME_RANGE_KEYS`, `HomeRangeKey`, `TimelineType`, `TimelineEntry`, `TimelineDay`, `HomeTimeline`, `HomeMetrics`, `HomeAttention`, `HomeTaskRow`, `HomeProjectRow`, `HomeUsage`, `HomeResponse`; `isHomeRange(v: string): v is HomeRangeKey`, `homeRangeStart(range: HomeRangeKey, now?: Date): Date`.

- [ ] **Step 1: Write the failing test**

```ts
// test/home-range.test.ts
import { describe, it, expect } from 'vitest'
import { isHomeRange, homeRangeStart } from '../server/lib/home/range'

describe('isHomeRange', () => {
  it('accepts the four home keys', () => {
    for (const k of ['1d', '3d', '7d', '30d']) expect(isHomeRange(k)).toBe(true)
  })
  it('rejects keys from the other two range vocabularies', () => {
    // 1h/6h/24h are RangeKey (cycle 44); 90d/all are UsageRangeKey (cycle 55).
    for (const k of ['1h', '6h', '24h', '90d', 'all', '', 'garbage']) {
      expect(isHomeRange(k)).toBe(false)
    }
  })
})

describe('homeRangeStart', () => {
  const now = new Date('2026-08-15T09:30:00.000Z')

  it('truncates to UTC midnight and subtracts the range in days', () => {
    expect(homeRangeStart('1d', now).toISOString()).toBe('2026-08-14T00:00:00.000Z')
    expect(homeRangeStart('3d', now).toISOString()).toBe('2026-08-12T00:00:00.000Z')
    expect(homeRangeStart('7d', now).toISOString()).toBe('2026-08-08T00:00:00.000Z')
    expect(homeRangeStart('30d', now).toISOString()).toBe('2026-07-16T00:00:00.000Z')
  })

  it('is unaffected by the time of day', () => {
    const early = new Date('2026-08-15T00:00:01.000Z')
    const late = new Date('2026-08-15T23:59:59.000Z')
    expect(homeRangeStart('3d', early).toISOString()).toBe(homeRangeStart('3d', late).toISOString())
  })

  it('crosses a month boundary correctly', () => {
    expect(homeRangeStart('3d', new Date('2026-03-01T12:00:00.000Z')).toISOString())
      .toBe('2026-02-26T00:00:00.000Z')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/home-range.test.ts`
Expected: FAIL — `Failed to resolve import "../server/lib/home/range"`

- [ ] **Step 3: Write `shared/types/home.ts`**

```ts
// Shared client/server DTOs for the home dashboard. No logic here.

/**
 * Ranges for the home dashboard. DELIBERATELY separate from `RangeKey` in
 * ./analytics.ts (`1h|6h|24h|7d`, Prometheus) and `UsageRangeKey` in ./usage.ts
 * (`7d|30d|90d|all`, Postgres daily buckets). All three spell `7d`; none of them
 * mean the same query. A shared ref would typecheck and silently query wrong.
 */
export const HOME_RANGE_KEYS = ['1d', '3d', '7d', '30d'] as const
export type HomeRangeKey = typeof HOME_RANGE_KEYS[number]

export const HOME_RANGE_DEFAULT: HomeRangeKey = '3d'

export type TimelineType =
  | 'session' | 'memory' | 'document' | 'image'
  | 'clipboard' | 'task' | 'conflict' | 'error'

export interface TimelineEntry {
  id: string
  type: TimelineType
  /** ISO timestamp. */
  at: string
  title: string
  subtitle?: string
  projectSlug?: string
  /** Always populated — every row renders as a real link. */
  href: string
  /** Present iff this row is a collapsed group of `count` events. */
  count?: number
}

export interface TimelineDay {
  /** 'YYYY-MM-DD', UTC. */
  day: string
  entries: TimelineEntry[]
}

export interface HomeTimeline {
  days: TimelineDay[]
  /** Rows actually returned. */
  shown: number
  /** Rows that would exist uncapped (post-grouping). `shown < total` ⇒ disclose it. */
  total: number
}

export interface HomeCount { total: number, delta: number }

export interface HomeMetrics {
  sessions: HomeCount
  memories: HomeCount
  documents: HomeCount
  images: HomeCount
}

/** Absolute backlog. NEVER range-scoped — see the spec. */
export interface HomeAttention {
  conflicts: number
  unreviewedMemories: number
  unackedErrors: number
  unfiledCaptures: number
}

export interface HomeUsage {
  tokens: number
  cacheReadPct: number
  /** API-equivalent value, not money. Label: "at API rates — not billed". */
  valueUsd: number
  /** Non-empty ⇒ some models had no price row (cold start); never render 0 for these. */
  unpricedModels: string[]
}

export interface HomeTaskRow {
  id: string
  title: string
  status: string
  dueDate: string | null
  overdue: boolean
  projectSlug: string | null
  href: string
}

export interface HomeProjectRow {
  slug: string
  name: string
  color: string | null
  sessions: number
  memories: number
  lastActivityAt: string
  href: string
}

export interface HomeResponse {
  range: HomeRangeKey
  generatedAt: string
  metrics: HomeMetrics
  usage: HomeUsage
  timeline: HomeTimeline
  attention: HomeAttention
  tasks: HomeTaskRow[]
  projects: HomeProjectRow[]
}
```

- [ ] **Step 4: Write `server/lib/home/range.ts`**

```ts
import { HOME_RANGE_KEYS } from '../../../shared/types/home'
import type { HomeRangeKey } from '../../../shared/types/home'

const DAYS: Record<HomeRangeKey, number> = { '1d': 1, '3d': 3, '7d': 7, '30d': 30 }

export function isHomeRange(v: string): v is HomeRangeKey {
  return (HOME_RANGE_KEYS as readonly string[]).includes(v)
}

/**
 * Lower bound for a range, truncated to UTC midnight. Unlike `rangeStart` in
 * server/services/usage.ts this never returns null — home has no `all` key.
 */
export function homeRangeStart(range: HomeRangeKey, now = new Date()): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  d.setUTCDate(d.getUTCDate() - DAYS[range])
  return d
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run test/home-range.test.ts`
Expected: PASS — 5 tests

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm typecheck
git add shared/types/home.ts server/lib/home/range.ts test/home-range.test.ts
git commit -m "feat(home): shared DTOs + UTC range mapping"
```

---

### Task 2: Timeline builder (pure merge/group/cap)

**Files:**
- Create: `server/lib/home/timeline.ts`
- Test: `test/home-timeline.test.ts`

**Interfaces:**
- Consumes: `TimelineType`, `TimelineEntry`, `TimelineDay`, `HomeTimeline` from Task 1.
- Produces: `RawEvent`, `buildTimeline(events: RawEvent[], opts?: { cap?: number }): HomeTimeline`, `utcDay(d: Date): string`, `NEVER_COLLAPSE`, `COLLAPSE_THRESHOLD`, `TIMELINE_CAP`.

- [ ] **Step 1: Write the failing test**

```ts
// test/home-timeline.test.ts
import { describe, it, expect } from 'vitest'
import { buildTimeline, utcDay, COLLAPSE_THRESHOLD, TIMELINE_CAP } from '../server/lib/home/timeline'
import type { RawEvent } from '../server/lib/home/timeline'
import type { TimelineType } from '../shared/types/home'

const ev = (
  type: TimelineType, iso: string, title: string, extra: Partial<RawEvent> = {}
): RawEvent => ({ id: `${type}-${iso}-${title}`, type, at: new Date(iso), title, href: `/x/${title}`, ...extra })

describe('utcDay', () => {
  it('buckets by UTC, not local time', () => {
    expect(utcDay(new Date('2026-08-15T23:59:59.000Z'))).toBe('2026-08-15')
    expect(utcDay(new Date('2026-08-16T00:00:00.000Z'))).toBe('2026-08-16')
  })
})

describe('buildTimeline grouping', () => {
  it('leaves a collapsible type alone at exactly the threshold', () => {
    const evs = Array.from({ length: COLLAPSE_THRESHOLD }, (_, i) =>
      ev('memory', `2026-08-15T0${i}:00:00.000Z`, `mem${i}`))
    const { days } = buildTimeline(evs)
    expect(days[0]!.entries).toHaveLength(COLLAPSE_THRESHOLD)
    expect(days[0]!.entries.every(e => e.count === undefined)).toBe(true)
  })

  it('collapses one over the threshold into a single summary row', () => {
    const evs = Array.from({ length: COLLAPSE_THRESHOLD + 1 }, (_, i) =>
      ev('memory', `2026-08-15T0${i}:00:00.000Z`, `mem${i}`))
    const { days } = buildTimeline(evs)
    expect(days[0]!.entries).toHaveLength(1)
    const row = days[0]!.entries[0]!
    expect(row.count).toBe(4)
    expect(row.title).toBe('4 memories learned')
    expect(row.href).toBe('/memories')
    // newest two named, remainder counted
    expect(row.subtitle).toBe('mem3, mem2, +2')
  })

  it('NEVER collapses sessions or errors, however many there are', () => {
    const evs = [
      ...Array.from({ length: 9 }, (_, i) => ev('session', `2026-08-15T0${i}:00:00.000Z`, `s${i}`)),
      ...Array.from({ length: 9 }, (_, i) => ev('error', `2026-08-15T1${i}:00:00.000Z`, `e${i}`))
    ]
    const { days } = buildTimeline(evs)
    expect(days[0]!.entries).toHaveLength(18)
    expect(days[0]!.entries.every(e => e.count === undefined)).toBe(true)
  })

  it('groups per day, not across days', () => {
    const evs = [
      ...Array.from({ length: 4 }, (_, i) => ev('memory', `2026-08-15T0${i}:00:00.000Z`, `a${i}`)),
      ...Array.from({ length: 4 }, (_, i) => ev('memory', `2026-08-14T0${i}:00:00.000Z`, `b${i}`))
    ]
    const { days } = buildTimeline(evs)
    expect(days.map(d => d.day)).toEqual(['2026-08-15', '2026-08-14'])
    expect(days[0]!.entries[0]!.title).toBe('4 memories learned')
    expect(days[1]!.entries[0]!.title).toBe('4 memories learned')
  })

  it('groups per type, not across types', () => {
    const evs = [
      ...Array.from({ length: 4 }, (_, i) => ev('memory', `2026-08-15T0${i}:00:00.000Z`, `m${i}`)),
      ...Array.from({ length: 4 }, (_, i) => ev('image', `2026-08-15T1${i}:00:00.000Z`, `i${i}`))
    ]
    const { days } = buildTimeline(evs)
    expect(days[0]!.entries.map(e => e.title)).toEqual(['4 images added', '4 memories learned'])
  })
})

describe('buildTimeline ordering', () => {
  it('orders days and entries newest first', () => {
    const evs = [
      ev('session', '2026-08-13T10:00:00.000Z', 'old'),
      ev('session', '2026-08-15T10:00:00.000Z', 'new'),
      ev('session', '2026-08-15T08:00:00.000Z', 'mid')
    ]
    const { days } = buildTimeline(evs)
    expect(days.map(d => d.day)).toEqual(['2026-08-15', '2026-08-13'])
    expect(days[0]!.entries.map(e => e.title)).toEqual(['new', 'mid'])
  })

  it('sorts a collapsed group by its newest member', () => {
    const evs = [
      ev('session', '2026-08-15T05:00:00.000Z', 'session-row'),
      ...Array.from({ length: 4 }, (_, i) => ev('memory', `2026-08-15T0${i}:00:00.000Z`, `m${i}`))
    ]
    // newest memory is 03:00, which is older than the 05:00 session
    const { days } = buildTimeline(evs)
    expect(days[0]!.entries.map(e => e.title)).toEqual(['session-row', '4 memories learned'])
  })
})

describe('buildTimeline cap', () => {
  it('caps rows and reports the uncapped total so truncation can be disclosed', () => {
    const evs = Array.from({ length: 10 }, (_, i) =>
      ev('session', `2026-08-15T${String(i).padStart(2, '0')}:00:00.000Z`, `s${i}`))
    const t = buildTimeline(evs, { cap: 4 })
    expect(t.shown).toBe(4)
    expect(t.total).toBe(10)
    expect(t.days.flatMap(d => d.entries)).toHaveLength(4)
  })

  it('keeps the NEWEST rows when capping', () => {
    const evs = Array.from({ length: 5 }, (_, i) =>
      ev('session', `2026-08-15T0${i}:00:00.000Z`, `s${i}`))
    const t = buildTimeline(evs, { cap: 2 })
    expect(t.days[0]!.entries.map(e => e.title)).toEqual(['s4', 's3'])
  })

  it('counts POST-grouping rows in total, not raw events', () => {
    const evs = Array.from({ length: 20 }, (_, i) =>
      ev('memory', `2026-08-15T${String(i).padStart(2, '0')}:00:00.000Z`, `m${i}`))
    const t = buildTimeline(evs)
    expect(t.total).toBe(1)   // 20 memories collapse to one row
    expect(t.shown).toBe(1)
  })

  it('defaults the cap to TIMELINE_CAP', () => {
    const evs = Array.from({ length: TIMELINE_CAP + 25 }, (_, i) =>
      ev('session', new Date(Date.UTC(2026, 7, 15, 0, i)).toISOString(), `s${i}`))
    const t = buildTimeline(evs)
    expect(t.shown).toBe(TIMELINE_CAP)
    expect(t.total).toBe(TIMELINE_CAP + 25)
  })

  it('empty input -> empty timeline, not a crash', () => {
    expect(buildTimeline([])).toEqual({ days: [], shown: 0, total: 0 })
  })
})

describe('buildTimeline entry shape', () => {
  it('carries href, subtitle and projectSlug through for ungrouped rows', () => {
    const t = buildTimeline([
      ev('session', '2026-08-15T10:00:00.000Z', 'Usage tab', {
        href: '/sessions/abc', subtitle: '216 messages', projectSlug: 'mymind'
      })
    ])
    expect(t.days[0]!.entries[0]).toMatchObject({
      type: 'session', title: 'Usage tab', href: '/sessions/abc',
      subtitle: '216 messages', projectSlug: 'mymind', at: '2026-08-15T10:00:00.000Z'
    })
  })

  it('omits subtitle/projectSlug keys when absent rather than setting undefined', () => {
    const t = buildTimeline([ev('session', '2026-08-15T10:00:00.000Z', 'bare')])
    expect('subtitle' in t.days[0]!.entries[0]!).toBe(false)
    expect('projectSlug' in t.days[0]!.entries[0]!).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/home-timeline.test.ts`
Expected: FAIL — `Failed to resolve import "../server/lib/home/timeline"`

- [ ] **Step 3: Write `server/lib/home/timeline.ts`**

```ts
import type { HomeTimeline, TimelineDay, TimelineEntry, TimelineType } from '../../../shared/types/home'

export interface RawEvent {
  id: string
  type: TimelineType
  at: Date
  title: string
  subtitle?: string
  projectSlug?: string
  href: string
}

/**
 * Types whose every occurrence is individually actionable, so they are never
 * summarised. `embeddings:all-failed` sat unseen for nine days — it must never
 * be folded into "3 errors". Sessions are the headline units of "work I did".
 */
export const NEVER_COLLAPSE: ReadonlySet<TimelineType> = new Set<TimelineType>(['session', 'error'])

/** A day holding MORE than this many of one collapsible type becomes one summary row. */
export const COLLAPSE_THRESHOLD = 3

/** Max rows after grouping. Overflow is DISCLOSED via `total`, never silently dropped. */
export const TIMELINE_CAP = 60

const GROUP_LABEL: Record<TimelineType, string> = {
  session: 'sessions',
  error: 'errors',
  memory: 'memories learned',
  document: 'documents saved',
  image: 'images added',
  clipboard: 'clipboard items',
  task: 'task updates',
  conflict: 'memory conflicts flagged'
}

const GROUP_HREF: Record<TimelineType, string> = {
  session: '/sessions',
  error: '/activity',
  memory: '/memories',
  document: '/documents',
  image: '/gallery',
  clipboard: '/clipboard',
  task: '/tasks',
  conflict: '/review'
}

/** 'YYYY-MM-DD' in UTC — pinned so bucketing can't drift with the server timezone. */
export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function toEntry(e: RawEvent): TimelineEntry {
  return {
    id: e.id,
    type: e.type,
    at: e.at.toISOString(),
    title: e.title,
    ...(e.subtitle ? { subtitle: e.subtitle } : {}),
    ...(e.projectSlug ? { projectSlug: e.projectSlug } : {}),
    href: e.href
  }
}

export function buildTimeline(events: RawEvent[], opts: { cap?: number } = {}): HomeTimeline {
  const cap = opts.cap ?? TIMELINE_CAP

  // 1. bucket by (UTC day, type)
  const byDay = new Map<string, Map<TimelineType, RawEvent[]>>()
  for (const e of events) {
    const day = utcDay(e.at)
    let types = byDay.get(day)
    if (!types) { types = new Map(); byDay.set(day, types) }
    const list = types.get(e.type)
    if (list) list.push(e)
    else types.set(e.type, [e])
  }

  // 2. collapse each (day, type) bucket where allowed
  const rows: (TimelineEntry & { _at: number })[] = []
  for (const [day, types] of byDay) {
    for (const [type, list] of types) {
      list.sort((a, b) => b.at.getTime() - a.at.getTime())

      if (NEVER_COLLAPSE.has(type) || list.length <= COLLAPSE_THRESHOLD) {
        for (const e of list) rows.push({ ...toEntry(e), _at: e.at.getTime() })
        continue
      }

      const newest = list[0]!
      const named = list.slice(0, 2).map(e => e.title).join(', ')
      const rest = list.length - 2
      rows.push({
        id: `group:${day}:${type}`,
        type,
        at: newest.at.toISOString(),
        title: `${list.length} ${GROUP_LABEL[type]}`,
        subtitle: rest > 0 ? `${named}, +${rest}` : named,
        href: GROUP_HREF[type],
        count: list.length,
        _at: newest.at.getTime()
      })
    }
  }

  // 3. newest first, then cap — `total` is the uncapped post-grouping row count
  rows.sort((a, b) => b._at - a._at)
  const total = rows.length
  const kept = rows.slice(0, cap)

  // 4. regroup into day sections, preserving order
  const days: TimelineDay[] = []
  for (const row of kept) {
    const { _at, ...entry } = row
    void _at
    const day = entry.at.slice(0, 10)
    const last = days[days.length - 1]
    if (last && last.day === day) last.entries.push(entry)
    else days.push({ day, entries: [entry] })
  }

  return { days, shown: kept.length, total }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/home-timeline.test.ts`
Expected: PASS — 14 tests

- [ ] **Step 5: Prove the tests actually bite (mutation check)**

Temporarily change `COLLAPSE_THRESHOLD` from `3` to `99` in `server/lib/home/timeline.ts` and re-run.
Expected: the two collapse tests FAIL. **Revert the change.** Then change `rows.sort((a, b) => b._at - a._at)` to `a._at - b._at` and re-run.
Expected: the ordering and cap tests FAIL. **Revert the change.**

A test that stays green under both mutations is not testing anything — fix it before moving on.

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm typecheck
git add server/lib/home/timeline.ts test/home-timeline.test.ts
git commit -m "feat(home): pure timeline merge/group/cap"
```

---

### Task 3: `messages.created_at` index and the `getUsageSince` split

**Files:**
- Modify: `server/db/schema/messages.ts:22-24` (add index)
- Modify: `server/services/usage.ts:47` (split `getUsage`)
- Create: `server/db/migrations/<generated>.sql` (via `pnpm db:generate`)
- Test: existing `test/analytics-*.test.ts` must stay green

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `getUsageSince(start: Date | null): Promise<UsageResponse>` — the existing `getUsage(range: UsageRangeKey)` keeps its signature and delegates.

**Why:** `server/services/usage.ts:51` filters `messages.created_at >= start`, and `messages` has only `messages_session_idx` and a unique on `(session_id, external_uuid)`. That is a sequential scan over ~147k prod rows, which home would run on every landing-page load. Cycle 55's handover logged this as a follow-up.

- [ ] **Step 1: Add the index to the Drizzle schema**

In `server/db/schema/messages.ts`, extend the index array:

```ts
}, (t) => [
  index('messages_session_idx').on(t.sessionId),
  // Home (cycle 56) and the Usage tab (cycle 55) both filter `created_at >= start`.
  // Without this it is a seq scan over ~147k prod rows on the landing page.
  index('messages_created_at_idx').on(t.createdAt.desc()),
  uniqueIndex('messages_session_extuuid_uidx').on(t.sessionId, t.externalUuid)
])
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: a new file under `server/db/migrations/` containing `CREATE INDEX ... ON "messages" ("created_at" DESC)`.

Read the generated SQL and confirm it contains **only** that index. If `db:generate` also emits drops for the three `project_id` FKs that exist in prod but are not modelled in Drizzle (a known cycle-27 note), delete those statements from the migration before continuing.

- [ ] **Step 3: Apply and verify locally**

```bash
pnpm db:migrate
```

Then confirm the index exists and is used:

```bash
psql "$DATABASE_URL" -c "\di messages_created_at_idx"
psql "$DATABASE_URL" -c "explain select count(*) from messages where created_at >= now() - interval '3 days';"
```

Expected: the index is listed, and the plan shows an index scan rather than `Seq Scan on messages`.

- [ ] **Step 4: Split `getUsage` without changing its signature**

Three edits in `server/services/usage.ts`. `getUsage` keeps its exact public signature so every
existing caller and test is untouched. `getUsageSince` returns `Omit<UsageResponse, 'range'>`
because it no longer knows the range key — `getUsage` puts it back.

**(a)** Replace the single line `export async function getUsage(range: UsageRangeKey): Promise<UsageResponse> {` with this block (note the wrapper closes, then the new function opens):

```ts
/**
 * Range-key entry point for the Usage tab (cycle 55). Home (cycle 56) has its own
 * range vocabulary and calls `getUsageSince` directly with a Date — the two surfaces
 * must NOT share a range enum (see the comment in shared/types/usage.ts).
 */
export async function getUsage(range: UsageRangeKey): Promise<UsageResponse> {
  return { range, ...(await getUsageSince(rangeStart(range))) }
}

/** `start === null` means no lower bound (the Usage tab's `all`). */
export async function getUsageSince(start: Date | null): Promise<Omit<UsageResponse, 'range'>> {
```

**(b)** Delete the now-shadowed `const start = rangeStart(range)` line inside that body — `start` is the parameter now.

**(c)** In that body's final `return { ... }`, remove the `range` property. Everything else in the return object stays exactly as-is.

- [ ] **Step 5: Run the existing analytics tests to prove nothing regressed**

Run: `pnpm vitest run test/analytics-`
Expected: PASS — every existing analytics test, unchanged.

- [ ] **Step 6: Typecheck, build, commit**

```bash
pnpm typecheck && pnpm build
git add server/db/schema/messages.ts server/db/migrations server/services/usage.ts
git commit -m "perf(usage): index messages.created_at; split getUsage into getUsageSince(Date)"
```

---

### Task 4: Home service and endpoint

**Files:**
- Create: `server/services/home.ts`
- Create: `server/api/home.get.ts`
- Test: `test/home-endpoint.db.test.ts` (`.db.` — needs Postgres, runs via `pnpm test:db`, excluded from the CI gate by `vitest.config.ts`)

**Interfaces:**
- Consumes: `homeRangeStart`, `isHomeRange` (Task 1); `buildTimeline`, `RawEvent` (Task 2); `getUsageSince` (Task 3).
- Produces: `getHome(range: HomeRangeKey): Promise<HomeResponse>`; `GET /api/home?range=`.

- [ ] **Step 1: Write `server/services/home.ts`**

All panel queries run in parallel. Attention counts deliberately ignore `range`.

```ts
import { sql } from 'drizzle-orm'
import { useDb } from '../db'
import { homeRangeStart } from '../lib/home/range'
import { buildTimeline } from '../lib/home/timeline'
import type { RawEvent } from '../lib/home/timeline'
import { getUsageSince } from './usage'
import type {
  HomeRangeKey, HomeResponse, HomeMetrics, HomeAttention,
  HomeTaskRow, HomeProjectRow, HomeUsage
} from '../../shared/types/home'

/** Rows pulled per source before grouping. Generous — grouping collapses the noise. */
const PER_SOURCE_LIMIT = 200

// Written out per table rather than via a helper that `sql.raw`s identifiers —
// the table/column names would be the only interpolated parts, and this file
// should contain zero raw interpolation so a reviewer never has to reason about it.
async function metrics(db: ReturnType<typeof useDb>, start: Date): Promise<HomeMetrics> {
  const iso = start.toISOString()
  const one = (r: { rows: unknown[] }) => {
    const row = (r.rows as Record<string, unknown>[])[0] ?? {}
    return { total: Number(row.total ?? 0), delta: Number(row.delta ?? 0) }
  }
  const [ses, mem, doc, img] = await Promise.all([
    db.execute(sql`select count(*) as total, count(*) filter (where started_at >= ${iso}) as delta
                   from sessions`),
    db.execute(sql`select count(*) as total, count(*) filter (where created_at >= ${iso}) as delta
                   from memories where archived_at is null`),
    db.execute(sql`select count(*) as total, count(*) filter (where created_at >= ${iso}) as delta
                   from documents where deleted_at is null`),
    db.execute(sql`select count(*) as total, count(*) filter (where created_at >= ${iso}) as delta
                   from images`)
  ])
  return { sessions: one(ses), memories: one(mem), documents: one(doc), images: one(img) }
}

/** NOT range-scoped — absolute backlog. See the spec. */
async function attention(db: ReturnType<typeof useDb>): Promise<HomeAttention> {
  const r = await db.execute(sql`
    select
      (select count(*) from review_queue where status = 'pending')                        as conflicts,
      (select count(*) from memories where reviewed_at is null and archived_at is null)   as unreviewed,
      (select count(*) from activity_log where severity = 'error' and acked_at is null)   as errors,
      (select count(*) from documents where path like '/input/%' and deleted_at is null)  as unfiled`)
  const row = (r.rows as Record<string, unknown>[])[0] ?? {}
  return {
    conflicts: Number(row.conflicts ?? 0),
    unreviewedMemories: Number(row.unreviewed ?? 0),
    unackedErrors: Number(row.errors ?? 0),
    unfiledCaptures: Number(row.unfiled ?? 0)
  }
}

async function timelineEvents(db: ReturnType<typeof useDb>, start: Date): Promise<RawEvent[]> {
  const iso = start.toISOString()
  const [ses, mem, doc, img, clip, task, conf, err] = await Promise.all([
    db.execute(sql`select id, title, project, message_count, tool_count, started_at
                   from sessions where started_at >= ${iso}
                   order by started_at desc limit ${PER_SOURCE_LIMIT}`),
    db.execute(sql`select id, content, project, created_at from memories
                   where created_at >= ${iso} and archived_at is null
                   order by created_at desc limit ${PER_SOURCE_LIMIT}`),
    db.execute(sql`select id, path, title, project, created_at from documents
                   where created_at >= ${iso} and deleted_at is null
                   order by created_at desc limit ${PER_SOURCE_LIMIT}`),
    db.execute(sql`select id, original_name, summary, created_at from images
                   where created_at >= ${iso}
                   order by created_at desc limit ${PER_SOURCE_LIMIT}`),
    db.execute(sql`select id, body_text, kind, created_at from clip_messages
                   where created_at >= ${iso}
                   order by created_at desc limit ${PER_SOURCE_LIMIT}`),
    db.execute(sql`select id, title, status, project, coalesce(completed_at, created_at) as at
                   from tasks where coalesce(completed_at, created_at) >= ${iso} and deleted_at is null
                   order by at desc limit ${PER_SOURCE_LIMIT}`),
    db.execute(sql`select id, created_at from review_queue
                   where created_at >= ${iso} and status = 'pending'
                   order by created_at desc limit ${PER_SOURCE_LIMIT}`),
    db.execute(sql`select id, name, status, created_at from activity_log
                   where created_at >= ${iso} and severity = 'error'
                   order by created_at desc limit ${PER_SOURCE_LIMIT}`)
  ])

  const rows = (r: { rows: unknown[] }) => r.rows as Record<string, unknown>[]
  const str = (v: unknown) => (v == null ? '' : String(v))
  const trim = (v: unknown, n = 90) => {
    const s = str(v).replace(/\s+/g, ' ').trim()
    return s.length > n ? `${s.slice(0, n - 1)}…` : s
  }
  const proj = (v: unknown) => (v == null ? {} : { projectSlug: String(v) })

  return [
    ...rows(ses).map((r): RawEvent => ({
      id: `session:${str(r.id)}`, type: 'session', at: new Date(str(r.started_at)),
      title: str(r.title) || '(untitled session)',
      subtitle: `${Number(r.message_count ?? 0)} messages · ${Number(r.tool_count ?? 0)} tools`,
      href: `/sessions/${str(r.id)}`, ...proj(r.project)
    })),
    ...rows(mem).map((r): RawEvent => ({
      id: `memory:${str(r.id)}`, type: 'memory', at: new Date(str(r.created_at)),
      title: trim(r.content), href: '/memories', ...proj(r.project)
    })),
    ...rows(doc).map((r): RawEvent => ({
      id: `document:${str(r.id)}`, type: 'document', at: new Date(str(r.created_at)),
      title: str(r.title) || str(r.path).split('/').pop() || 'Untitled',
      subtitle: str(r.path), href: `/documents?doc=${str(r.id)}`, ...proj(r.project)
    })),
    ...rows(img).map((r): RawEvent => ({
      id: `image:${str(r.id)}`, type: 'image', at: new Date(str(r.created_at)),
      title: str(r.original_name) || trim(r.summary) || 'Image', href: '/gallery'
    })),
    ...rows(clip).map((r): RawEvent => ({
      id: `clipboard:${str(r.id)}`, type: 'clipboard', at: new Date(str(r.created_at)),
      title: str(r.kind) === 'file' ? 'File shared' : trim(r.body_text) || 'Clipboard item',
      href: '/clipboard'
    })),
    ...rows(task).map((r): RawEvent => ({
      id: `task:${str(r.id)}`, type: 'task', at: new Date(str(r.at)),
      title: str(r.status) === 'completed' ? `Completed: ${str(r.title)}` : str(r.title),
      href: '/tasks', ...proj(r.project)
    })),
    ...rows(conf).map((r): RawEvent => ({
      id: `conflict:${str(r.id)}`, type: 'conflict', at: new Date(str(r.created_at)),
      title: 'Memory conflict flagged', href: '/review'
    })),
    ...rows(err).map((r): RawEvent => ({
      id: `error:${str(r.id)}`, type: 'error', at: new Date(str(r.created_at)),
      title: str(r.name), subtitle: str(r.status), href: `/activity/${str(r.id)}`
    }))
  ]
}

async function activeTasks(db: ReturnType<typeof useDb>): Promise<HomeTaskRow[]> {
  const now = new Date().toISOString()
  const r = await db.execute(sql`
    select id, title, status, due_date, project,
           (due_date is not null and due_date < ${now} and status <> 'completed') as overdue
    from tasks
    where deleted_at is null and status in ('in_progress', 'todo', 'blocked')
    order by overdue desc, due_date asc nulls last, "order" asc
    limit 5`)
  return (r.rows as Record<string, unknown>[]).map(t => ({
    id: String(t.id),
    title: String(t.title),
    status: String(t.status),
    dueDate: t.due_date ? new Date(String(t.due_date)).toISOString() : null,
    overdue: t.overdue === true,
    projectSlug: t.project == null ? null : String(t.project),
    href: '/tasks'
  }))
}

async function recentProjects(db: ReturnType<typeof useDb>, start: Date): Promise<HomeProjectRow[]> {
  const iso = start.toISOString()
  const r = await db.execute(sql`
    with touched as (
      select project as slug, started_at as at from sessions where started_at >= ${iso} and project is not null
      union all
      select project, created_at from memories  where created_at >= ${iso} and project is not null and archived_at is null
      union all
      select project, created_at from documents where created_at >= ${iso} and project is not null and deleted_at is null
      union all
      select project, created_at from tasks     where created_at >= ${iso} and project is not null and deleted_at is null
    )
    select p.slug, p.name, p.color,
           max(t.at)                                        as last_at,
           count(*) filter (where t.at is not null)          as touches,
           (select count(*) from sessions s where s.project = p.slug and s.started_at >= ${iso}) as sessions,
           (select count(*) from memories m where m.project = p.slug and m.created_at >= ${iso} and m.archived_at is null) as memories
    from touched t join projects p on p.slug = t.slug
    group by p.slug, p.name, p.color
    order by last_at desc
    limit 5`)
  return (r.rows as Record<string, unknown>[]).map(p => ({
    slug: String(p.slug),
    name: String(p.name),
    color: p.color == null ? null : String(p.color),
    sessions: Number(p.sessions ?? 0),
    memories: Number(p.memories ?? 0),
    lastActivityAt: new Date(String(p.last_at)).toISOString(),
    href: `/projects/${String(p.slug)}`
  }))
}

export async function getHome(range: HomeRangeKey): Promise<HomeResponse> {
  const db = useDb()
  const start = homeRangeStart(range)

  const [m, a, events, tasks, projects, usageRaw] = await Promise.all([
    metrics(db, start),
    attention(db),
    timelineEvents(db, start),
    activeTasks(db),
    recentProjects(db, start),
    getUsageSince(start)
  ])

  const usage: HomeUsage = {
    tokens: usageRaw.totals.tokens,
    cacheReadPct: usageRaw.totals.cacheReadPct,
    valueUsd: usageRaw.totals.valueUsd,
    unpricedModels: usageRaw.unpriced.models
  }

  return {
    range,
    generatedAt: new Date().toISOString(),
    metrics: m,
    usage,
    timeline: buildTimeline(events),
    attention: a,
    tasks,
    projects
  }
}
```

- [ ] **Step 2: Write `server/api/home.get.ts`**

```ts
import { getHome } from '../services/home'
import { isHomeRange } from '../lib/home/range'
import { HOME_RANGE_DEFAULT } from '../../shared/types/home'

export default defineEventHandler(async (event) => {
  // Auth is already enforced by server/middleware/auth.ts for all /api/** routes.
  const range = String(getQuery(event).range ?? HOME_RANGE_DEFAULT)
  if (!isHomeRange(range)) {
    throw createError({ statusCode: 400, statusMessage: `Unknown range: ${range}` })
  }
  return await getHome(range)
})
```

- [ ] **Step 3: Write the endpoint test**

```ts
// test/home-endpoint.db.test.ts
import { describe, it, expect } from 'vitest'
import { getHome } from '../server/services/home'
import { HOME_RANGE_KEYS } from '../shared/types/home'

describe('getHome', () => {
  it('returns a complete payload for every range key', async () => {
    for (const range of HOME_RANGE_KEYS) {
      const r = await getHome(range)
      expect(r.range).toBe(range)
      expect(r.timeline.days).toBeInstanceOf(Array)
      expect(r.timeline.shown).toBeLessThanOrEqual(r.timeline.total)
      expect(r.tasks.length).toBeLessThanOrEqual(5)
      expect(r.projects.length).toBeLessThanOrEqual(5)
      expect(typeof r.attention.conflicts).toBe('number')
      expect(typeof r.metrics.sessions.total).toBe('number')
    }
  })

  it('attention counts are IDENTICAL across ranges (absolute backlog, not range-scoped)', async () => {
    const a = await getHome('1d')
    const b = await getHome('30d')
    expect(a.attention).toEqual(b.attention)
  })

  it('a wider range never yields fewer timeline rows than a narrower one', async () => {
    const narrow = await getHome('1d')
    const wide = await getHome('30d')
    expect(wide.timeline.total).toBeGreaterThanOrEqual(narrow.timeline.total)
  })

  it('every timeline entry carries a non-empty href', async () => {
    const r = await getHome('30d')
    const entries = r.timeline.days.flatMap(d => d.entries)
    for (const e of entries) expect(e.href.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 4: Run the DB test**

Run: `pnpm test:db home-endpoint`
Expected: PASS — 4 tests. (Needs the local Postgres from `.env`'s `DATABASE_URL`.)

- [ ] **Step 5: Verify the endpoint over HTTP**

With `pnpm dev` running and a logged-in browser session:

```bash
playwright-cli eval "async () => {
  const ok  = await fetch('/api/home?range=3d').then(r => r.json());
  const bad = await fetch('/api/home?range=90d').then(r => r.status);
  return { range: ok.range, days: ok.timeline.days.length, shown: ok.timeline.shown, total: ok.timeline.total, badStatus: bad };
}"
```

Expected: `range: '3d'`, a numeric `shown`/`total`, and `badStatus: 400`.

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm typecheck
git add server/services/home.ts server/api/home.get.ts test/home-endpoint.db.test.ts
git commit -m "feat(home): single /api/home endpoint serving six panels"
```

---

### Task 5: Live invalidation for the home key

**Files:**
- Modify: `app/utils/live-dispatch.ts:8-36`
- Test: `test/live-dispatch.test.ts` (extend the existing file)

**Interfaces:**
- Consumes: nothing.
- Produces: `HOME_DEBOUNCE_MS` export; `['home']` invalidation on nine resources.

- [ ] **Step 1: Write the failing test**

Append to `test/live-dispatch.test.ts`:

```ts
import { HOME_DEBOUNCE_MS } from '../app/utils/live-dispatch'

describe('home invalidation', () => {
  const HOME_RESOURCES = [
    'document', 'image', 'memory', 'review',
    'project', 'task', 'session', 'clipboard', 'activity'
  ] as const

  it('every home-feeding resource eventually invalidates ["home"]', async () => {
    for (const resource of HOME_RESOURCES) {
      const calls: unknown[][] = []
      const client = { invalidateQueries: (a: unknown) => { calls.push([a]); return Promise.resolve() } }
      dispatchLiveEvent(client, { v: 1, resource, action: 'created', id: 'x', at: Date.now() })
      await new Promise(r => setTimeout(r, HOME_DEBOUNCE_MS + 60))
      const keys = calls.map(c => JSON.stringify((c[0] as { queryKey: unknown }).queryKey))
      expect(keys, `resource=${resource}`).toContain(JSON.stringify(['home']))
    }
  })

  it('collapses a burst into a single ["home"] invalidation', async () => {
    const calls: unknown[][] = []
    const client = { invalidateQueries: (a: unknown) => { calls.push([a]); return Promise.resolve() } }
    for (let i = 0; i < 12; i++) {
      dispatchLiveEvent(client, { v: 1, resource: 'memory', action: 'created', id: `m${i}`, at: Date.now() })
    }
    await new Promise(r => setTimeout(r, HOME_DEBOUNCE_MS + 60))
    const homeCalls = calls.filter(c =>
      JSON.stringify((c[0] as { queryKey: unknown }).queryKey) === JSON.stringify(['home']))
    expect(homeCalls).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/live-dispatch.test.ts`
Expected: FAIL — `HOME_DEBOUNCE_MS` is not exported, and `['home']` is never invalidated.

- [ ] **Step 3: Modify `app/utils/live-dispatch.ts`**

Correct the now-false comment on `GRAPH_DEBOUNCE_MS` and add the home debouncer:

```ts
// A burst of graph-invalidating events (e.g. the enrich-memories cron firing many
// memory events within a few seconds) would otherwise refetch the whole ~1,900-node
// galaxy graph + rebuild all GPU buffers once per event. Trailing-debounce so a burst
// collapses into ONE ['graph'] refetch. The home dashboard below is debounced for the
// same reason; every other resource's invalidateQueries call stays immediate.
export const GRAPH_DEBOUNCE_MS = 700

// Home (cycle 56) is a cross-type view keyed on ['home'] and fed by nine resources.
// A Claude Code session streaming in produces the same burst shape the graph sees, so
// it gets the same treatment and the same figure — there is no reason for two.
export const HOME_DEBOUNCE_MS = 700

const debouncedInvalidateGraph = useDebounceFn(
  (c: Invalidator) => c.invalidateQueries({ queryKey: ['graph'] }),
  GRAPH_DEBOUNCE_MS
)
const invalidateGraph = (c: Invalidator) => { void debouncedInvalidateGraph(c) }

const debouncedInvalidateHome = useDebounceFn(
  (c: Invalidator) => c.invalidateQueries({ queryKey: ['home'] }),
  HOME_DEBOUNCE_MS
)
const invalidateHome = (c: Invalidator) => { void debouncedInvalidateHome(c) }
```

Then extend `OVERRIDES` so all nine home-feeding resources call it:

```ts
const OVERRIDES: Partial<Record<ResourceName, (c: Invalidator, e: LiveEvent) => void>> = {
  memory: (c) => { c.invalidateQueries({ queryKey: ['memory', 'count'] }); invalidateGraph(c); invalidateHome(c) },
  review: (c) => { c.invalidateQueries({ queryKey: ['review', 'count'] }); invalidateHome(c) },
  activity: (c) => { c.invalidateQueries({ queryKey: ['activity', 'count'] }); invalidateHome(c) },
  // A skill is a document (type='skill') — a background agent write needs the
  // /settings/skills list to refresh too, not just the document graph/detail.
  document: (c) => { c.invalidateQueries({ queryKey: ['skills'] }); invalidateGraph(c); invalidateHome(c) },
  image: (c) => { invalidateGraph(c); invalidateHome(c) },
  session: (c) => { invalidateGraph(c); invalidateHome(c) },
  project: (c) => { invalidateGraph(c); invalidateHome(c) },
  task: (c) => invalidateHome(c),
  clipboard: (c) => invalidateHome(c),
  graph: (c) => invalidateGraph(c)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/live-dispatch.test.ts`
Expected: PASS — including the pre-existing tests in that file.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm typecheck
git add app/utils/live-dispatch.ts test/live-dispatch.test.ts
git commit -m "feat(home): debounced ['home'] invalidation across nine resources"
```

---

### Task 6: Page shell, range switch, metrics strip, rig health

**Files:**
- Modify: `app/pages/index.vue` (replace the redirect entirely)
- Create: `app/components/home/MetricsStrip.vue`
- Create: `app/components/home/RigHealth.vue`
- Modify: `app/pages/login.vue:77` (`navigateTo('/documents')` → `navigateTo('/')`)

**Interfaces:**
- Consumes: `HomeResponse`, `HomeRangeKey`, `HOME_RANGE_KEYS`, `HOME_RANGE_DEFAULT` (Task 1); `GET /api/home` (Task 4).
- Produces: `<HomeMetricsStrip :metrics :usage />`, `<HomeRigHealth />` (self-fetching, deliberately — it is the one separate query).

- [ ] **Step 1: Invoke the `nuxt-ui-docs` skill**

Confirm current v4 props for `UDashboardPanel`, `UDashboardNavbar`, `UDashboardSidebarCollapse`, `UButtonGroup`, `UButton`, `USkeleton`, `UAlert`, `UCard`. Do not write component markup from memory.

- [ ] **Step 2: Replace `app/pages/index.vue`**

```vue
<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { HOME_RANGE_KEYS, HOME_RANGE_DEFAULT } from '~~/shared/types/home'
import type { HomeRangeKey, HomeResponse } from '~~/shared/types/home'

definePageMeta({ title: 'Home' })

// Range persists across visits, like the existing mm.documents.* prefs.
const range = useCookie<HomeRangeKey>('mm.home.range', { default: () => HOME_RANGE_DEFAULT })

const { data, isPending, error, refetch } = useQuery({
  // Reactive key — the getter alone would have stable identity and never refetch.
  queryKey: computed(() => ['home', range.value]),
  queryFn: () => $fetch<HomeResponse>('/api/home', { query: { range: range.value } })
})
</script>

<template>
  <UDashboardPanel id="home" grow>
    <template #header>
      <UDashboardNavbar title="Home">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #right>
          <!-- shrink-0 + wrapping guard: the Tasks page's CTA currently clips
               20px off-screen at 390px. This must not. -->
          <UButtonGroup size="xs" class="shrink-0">
            <UButton
              v-for="k in HOME_RANGE_KEYS"
              :key="k"
              :color="range === k ? 'primary' : 'neutral'"
              :variant="range === k ? 'solid' : 'outline'"
              :label="k"
              @click="range = k"
            />
          </UButtonGroup>
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div
        v-if="error"
        class="p-6"
      >
        <UAlert
          color="error"
          icon="i-lucide-circle-alert"
          title="Couldn't load your dashboard"
          :description="(error as Error).message"
          :actions="[{ label: 'Retry', onClick: () => refetch() }]"
        />
      </div>

      <div
        v-else-if="isPending"
        class="flex flex-col gap-4 p-4 sm:p-6"
      >
        <USkeleton class="h-20 w-full" />
        <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <USkeleton class="h-96 lg:col-span-2" />
          <USkeleton class="h-96" />
        </div>
      </div>

      <div
        v-else-if="data"
        class="flex flex-col gap-4 p-4 sm:p-6"
      >
        <HomeMetricsStrip
          :metrics="data.metrics"
          :usage="data.usage"
        />

        <div class="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
          <div class="lg:col-span-2 min-w-0">
            <HomeTimeline
              :timeline="data.timeline"
              :range="data.range"
            />
          </div>
          <div class="flex flex-col gap-4 min-w-0">
            <HomeNeedsAttention :attention="data.attention" />
            <HomeQuickCapture />
            <HomeAskBrain />
            <HomeActiveTasks :tasks="data.tasks" />
            <HomeRecentProjects :projects="data.projects" />
          </div>
        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>
```

Note: Nuxt auto-imports directory-prefix component names, so `app/components/home/MetricsStrip.vue` is `<HomeMetricsStrip>`. Task 7-9 create the remaining five referenced components; until they exist the page will not render — that is expected and is why those tasks follow immediately.

- [ ] **Step 3: Write `app/components/home/MetricsStrip.vue`**

The metrics row: four tiles on desktop, one horizontally scrollable row below `sm` (mobile treatment 2 — DOM order preserved, compacted).

```vue
<script setup lang="ts">
import type { HomeMetrics, HomeUsage } from '~~/shared/types/home'

const props = defineProps<{ metrics: HomeMetrics, usage: HomeUsage }>()

const fmt = (n: number) => n >= 1_000_000
  ? `${(n / 1_000_000).toFixed(1)}M`
  : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n)

const money = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`

const tiles = computed(() => [
  { label: 'Sessions', value: fmt(props.metrics.sessions.total), delta: props.metrics.sessions.delta, to: '/sessions' },
  { label: 'Memories', value: fmt(props.metrics.memories.total), delta: props.metrics.memories.delta, to: '/memories' },
  { label: 'Documents', value: fmt(props.metrics.documents.total), delta: props.metrics.documents.delta, to: '/documents' }
])
</script>

<template>
  <div class="flex gap-3 overflow-x-auto sm:grid sm:grid-cols-2 lg:grid-cols-5 sm:overflow-visible">
    <ULink
      v-for="t in tiles"
      :key="t.label"
      :to="t.to"
      class="shrink-0 min-w-36 sm:min-w-0 rounded-lg border border-default bg-elevated/40 p-3 hover:bg-elevated transition-colors"
    >
      <p class="text-xl font-semibold text-highlighted">{{ t.value }}</p>
      <p class="text-xs text-muted uppercase tracking-wide">{{ t.label }}</p>
      <p v-if="t.delta > 0" class="text-xs text-primary mt-0.5">+{{ t.delta }} this range</p>
    </ULink>

    <ULink
      to="/analytics"
      class="shrink-0 min-w-36 sm:min-w-0 rounded-lg border border-default bg-elevated/40 p-3 hover:bg-elevated transition-colors"
    >
      <p class="text-xl font-semibold text-highlighted">{{ fmt(usage.tokens) }}</p>
      <p class="text-xs text-muted uppercase tracking-wide">Tokens</p>
      <!-- Cycle 55: this is API-EQUIVALENT value, never money, never summed with LiteLLM spend. -->
      <p v-if="usage.unpricedModels.length === 0" class="text-xs text-dimmed mt-0.5">
        {{ money(usage.valueUsd) }} at API rates — not billed
      </p>
      <p v-else class="text-xs text-warning mt-0.5">
        {{ usage.unpricedModels.length }} model(s) unpriced — value pending
      </p>
    </ULink>

    <HomeRigHealth />
  </div>
</template>
```

- [ ] **Step 4: Write `app/components/home/RigHealth.vue`**

The one panel that fetches its own data, so Prometheus dying degrades this tile alone.

The real shape is `ServiceHealth = { id: string, label: string, up: boolean | null }` from
`shared/types/analytics.ts:23`. **`up: null` means "no data", which is NOT the same as down** —
treating null as down would report a false outage whenever Prometheus has a gap.

```vue
<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import type { SnapshotResponse } from '~~/shared/types/analytics'

const { data, error } = useQuery({
  queryKey: ['analytics', 'snapshot'],
  queryFn: () => $fetch<SnapshotResponse>('/api/analytics/snapshot'),
  // Home must not go red because the homelab is off. Fail quietly into one tile.
  retry: false
})

const services = computed(() => data.value?.services ?? [])
// `up === null` is "no data", deliberately excluded from the down count.
const down = computed(() => services.value.filter(s => s.up === false).length)

const colorFor = (up: boolean | null) => up === false ? 'error' as const
  : up === true ? 'success' as const
  : 'neutral' as const
const glyphFor = (up: boolean | null) => up === false ? '✕' : up === true ? '✓' : '–'
</script>

<template>
  <ULink
    to="/analytics"
    class="shrink-0 min-w-36 sm:min-w-0 rounded-lg border border-default bg-elevated/40 p-3 hover:bg-elevated transition-colors"
  >
    <p class="text-xs text-muted uppercase tracking-wide mb-1">Rig</p>
    <p v-if="error" class="text-xs text-dimmed">Unavailable</p>
    <div v-else class="flex flex-wrap gap-1">
      <UBadge
        v-for="s in services"
        :key="s.id"
        :color="colorFor(s.up)"
        variant="subtle"
        size="sm"
        :label="glyphFor(s.up)"
        :title="s.label"
      />
    </div>
    <p v-if="!error && down > 0" class="text-xs text-error mt-1">{{ down }} down</p>
  </ULink>
</template>
```

- [ ] **Step 5: Retarget the post-login landing**

In `app/pages/login.vue`, change the success branch:

```ts
    } else {
      await navigateTo('/')
    }
```

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm typecheck
git add app/pages/index.vue app/components/home/MetricsStrip.vue app/components/home/RigHealth.vue app/pages/login.vue
git commit -m "feat(home): page shell, range switch, metrics strip, rig tile"
```

---

### Task 7: Timeline components

**Files:**
- Create: `app/components/home/Timeline.vue`
- Create: `app/components/home/TimelineRow.vue`

**Interfaces:**
- Consumes: `HomeTimeline`, `TimelineEntry`, `TimelineType`, `HomeRangeKey` (Task 1).
- Produces: `<HomeTimeline :timeline :range />`, `<HomeTimelineRow :entry />`.

- [ ] **Step 1: Write `app/components/home/TimelineRow.vue`**

**Every row is a real link.** This is the constraint that keeps home from repeating the `/tasks` and `/projects` bug where `main` has zero focusable elements.

```vue
<script setup lang="ts">
import type { TimelineEntry, TimelineType } from '~~/shared/types/home'

defineProps<{ entry: TimelineEntry }>()

// Semantic tokens only — no raw palette classes.
const DOT: Record<TimelineType, string> = {
  session: 'bg-info',
  memory: 'bg-primary',
  document: 'bg-success',
  image: 'bg-success',
  clipboard: 'bg-success',
  task: 'bg-warning',
  conflict: 'bg-primary',
  error: 'bg-error'
}

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
</script>

<template>
  <ULink
    :to="entry.href"
    class="flex items-start gap-3 py-2 px-1 -mx-1 rounded hover:bg-elevated/60 transition-colors"
  >
    <span
      class="size-2 rounded-full shrink-0 mt-1.5"
      :class="DOT[entry.type]"
    />
    <div class="flex-1 min-w-0">
      <p class="text-sm text-default flex items-center gap-2 min-w-0">
        <ProjectBadge
          v-if="entry.projectSlug"
          :slug="entry.projectSlug"
          :name="entry.projectSlug"
          :to="null"
        />
        <!-- title="" so a truncated row is still readable on hover — the audit
             found 0 of 24 truncated labels in this app carry one. -->
        <span class="truncate" :title="entry.title">{{ entry.title }}</span>
      </p>
      <p
        v-if="entry.subtitle"
        class="text-xs text-muted truncate"
        :title="entry.subtitle"
      >
        {{ entry.subtitle }}
      </p>
    </div>
    <span class="text-xs text-dimmed shrink-0 tabular-nums">{{ time(entry.at) }}</span>
  </ULink>
</template>
```

- [ ] **Step 2: Write `app/components/home/Timeline.vue`**

```vue
<script setup lang="ts">
import type { HomeTimeline, HomeRangeKey } from '~~/shared/types/home'

const props = defineProps<{ timeline: HomeTimeline, range: HomeRangeKey }>()

// Mobile treatment 2: cap the list and expand on demand rather than reordering.
const MOBILE_PREVIEW = 12
const expanded = ref(false)

const flat = computed(() => props.timeline.days.flatMap(d => d.entries.map(e => ({ day: d.day, entry: e }))))
const visible = computed(() => expanded.value ? flat.value : flat.value.slice(0, MOBILE_PREVIEW))
const hasMore = computed(() => flat.value.length > MOBILE_PREVIEW)

const dayLabel = (day: string) => {
  const today = new Date().toISOString().slice(0, 10)
  const yest = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  if (day === today) return 'Today'
  if (day === yest) return 'Yesterday'
  return new Date(`${day}T00:00:00.000Z`).toLocaleDateString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC'
  })
}

// Show a day header only when the day changes as we walk the flat list.
const showHeader = (i: number) => i === 0 || visible.value[i]!.day !== visible.value[i - 1]!.day
</script>

<template>
  <UCard :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <div class="flex items-center justify-between">
        <h2 class="text-sm font-semibold text-highlighted">What happened</h2>
        <span class="text-xs text-muted">last {{ range }}</span>
      </div>
    </template>

    <div
      v-if="flat.length === 0"
      class="flex flex-col items-center justify-center gap-2 py-12 text-muted"
    >
      <UIcon name="i-lucide-wind" class="size-8 text-dimmed" />
      <p class="text-sm">Nothing in the last {{ range }}.</p>
      <p class="text-xs text-dimmed">Try a wider range.</p>
    </div>

    <div v-else class="px-4 pb-3">
      <template
        v-for="(row, i) in visible"
        :key="row.entry.id"
      >
        <p
          v-if="showHeader(i)"
          class="text-xs font-semibold uppercase tracking-wide text-dimmed mt-4 mb-1 first:mt-2"
        >
          {{ dayLabel(row.day) }}
        </p>
        <HomeTimelineRow :entry="row.entry" />
      </template>

      <div class="flex items-center justify-between pt-3">
        <UButton
          v-if="hasMore"
          size="xs"
          variant="ghost"
          color="neutral"
          :label="expanded ? 'Show less' : `Show ${flat.length - MOBILE_PREVIEW} more`"
          @click="expanded = !expanded"
        />
        <!-- Truncation is DISCLOSED, never silent. -->
        <span
          v-if="timeline.shown < timeline.total"
          class="text-xs text-dimmed ml-auto"
        >
          Showing {{ timeline.shown }} of {{ timeline.total }}
        </span>
      </div>
    </div>
  </UCard>
</template>
```

- [ ] **Step 3: Verify in the browser that rows are real anchors**

With `pnpm dev` running and logged in:

```bash
playwright-cli goto "http://localhost:3000/"
playwright-cli eval "() => {
  const rows = [...document.querySelectorAll('a')].filter(a => a.closest('[class*=grid]'));
  const bad = rows.filter(a => !a.getAttribute('href'));
  return { anchors: rows.length, missingHref: bad.length, sample: rows.slice(0,3).map(a => ({ tag: a.tagName, href: a.getAttribute('href') })) };
}"
```

Expected: `anchors > 0`, `missingHref: 0`, and every sample shows `tag: 'A'` with a populated `href`. A `<nuxtlink>` tag here means the same latent bug `ProjectBadge` shipped with — fix before committing.

- [ ] **Step 4: Typecheck and commit**

```bash
pnpm typecheck
git add app/components/home/Timeline.vue app/components/home/TimelineRow.vue
git commit -m "feat(home): timeline with day headers and disclosed truncation"
```

---

### Task 8: Rail panels — attention, tasks, projects

**Files:**
- Create: `app/components/home/NeedsAttention.vue`
- Create: `app/components/home/ActiveTasks.vue`
- Create: `app/components/home/RecentProjects.vue`

**Interfaces:**
- Consumes: `HomeAttention`, `HomeTaskRow`, `HomeProjectRow` (Task 1).
- Produces: `<HomeNeedsAttention :attention />`, `<HomeActiveTasks :tasks />`, `<HomeRecentProjects :projects />`.

- [ ] **Step 1: Write `app/components/home/NeedsAttention.vue`**

```vue
<script setup lang="ts">
import type { HomeAttention } from '~~/shared/types/home'

const props = defineProps<{ attention: HomeAttention }>()

// Static class strings — Tailwind scans source text, so a constructed
// `bg-${color}` would be purged from the build and render colourless.
const rows = computed(() => [
  { key: 'errors', n: props.attention.unackedErrors, label: 'errors unacked', to: '/activity', dot: 'bg-error' },
  { key: 'conflicts', n: props.attention.conflicts, label: 'memory conflicts to resolve', to: '/review', dot: 'bg-primary' },
  { key: 'unreviewed', n: props.attention.unreviewedMemories, label: 'memories unreviewed', to: '/memories', dot: 'bg-primary' },
  { key: 'unfiled', n: props.attention.unfiledCaptures, label: 'captures still in /input', to: '/documents', dot: 'bg-success' }
].filter(r => r.n > 0))

const total = computed(() => rows.value.length)
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex items-center justify-between">
        <h2 class="text-sm font-semibold text-highlighted">Needs attention</h2>
        <UBadge
          v-if="total > 0"
          color="error"
          variant="subtle"
          size="sm"
          :label="String(total)"
        />
      </div>
    </template>

    <div
      v-if="rows.length === 0"
      class="flex items-center gap-2 text-sm text-muted"
    >
      <UIcon name="i-lucide-check" class="size-4 text-success" />
      Nothing waiting.
    </div>

    <div v-else class="flex flex-col">
      <ULink
        v-for="r in rows"
        :key="r.key"
        :to="r.to"
        class="flex items-center gap-2 py-1.5 text-sm hover:text-primary transition-colors"
      >
        <span class="size-2 rounded-full shrink-0" :class="r.dot" />
        <span class="font-semibold tabular-nums">{{ r.n }}</span>
        <span class="text-muted truncate">{{ r.label }}</span>
      </ULink>
    </div>
  </UCard>
</template>
```

- [ ] **Step 2: Write `app/components/home/ActiveTasks.vue`**

```vue
<script setup lang="ts">
import type { HomeTaskRow } from '~~/shared/types/home'

defineProps<{ tasks: HomeTaskRow[] }>()

const due = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : null
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex items-center justify-between">
        <h2 class="text-sm font-semibold text-highlighted">Active tasks</h2>
        <ULink to="/tasks" class="text-xs text-primary">All</ULink>
      </div>
    </template>

    <p v-if="tasks.length === 0" class="text-sm text-muted">
      Nothing in progress.
    </p>

    <div v-else class="flex flex-col">
      <ULink
        v-for="t in tasks"
        :key="t.id"
        :to="t.href"
        class="flex items-center gap-2 py-1.5 text-sm hover:text-primary transition-colors min-w-0"
      >
        <span class="truncate flex-1" :title="t.title">{{ t.title }}</span>
        <!-- Overdue carries a TEXT badge, not colour alone. -->
        <UBadge
          v-if="t.overdue"
          color="error"
          variant="subtle"
          size="sm"
          label="overdue"
        />
        <span v-else-if="due(t.dueDate)" class="text-xs text-dimmed shrink-0">{{ due(t.dueDate) }}</span>
      </ULink>
    </div>
  </UCard>
</template>
```

- [ ] **Step 3: Write `app/components/home/RecentProjects.vue`**

```vue
<script setup lang="ts">
import type { HomeProjectRow } from '~~/shared/types/home'

defineProps<{ projects: HomeProjectRow[] }>()

// "1 session" not "1 sessions" — the audit found 11 hard-coded plurals across 5 files.
// Irregulars are explicit; naive +'s' would render "1.2k memorys".
const PLURALS: Record<string, string> = { session: 'sessions', memory: 'memories' }
const plural = (n: number, word: string) =>
  `${n} ${n === 1 ? word : (PLURALS[word] ?? `${word}s`)}`
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex items-center justify-between">
        <h2 class="text-sm font-semibold text-highlighted">Projects</h2>
        <ULink to="/projects" class="text-xs text-primary">All</ULink>
      </div>
    </template>

    <p v-if="projects.length === 0" class="text-sm text-muted">
      No project activity in this range.
    </p>

    <div v-else class="flex flex-col gap-1.5">
      <ULink
        v-for="p in projects"
        :key="p.slug"
        :to="p.href"
        class="flex items-center gap-2 min-w-0 hover:opacity-80 transition-opacity"
      >
        <ProjectBadge
          :slug="p.slug"
          :name="p.name"
          :color="p.color"
          :to="null"
        />
        <span class="text-xs text-dimmed truncate">
          {{ plural(p.sessions, 'session') }} · {{ plural(p.memories, 'memory') }}
        </span>
      </ULink>
    </div>
  </UCard>
</template>
```

- [ ] **Step 4: Typecheck and commit**

```bash
pnpm typecheck
git add app/components/home/NeedsAttention.vue app/components/home/ActiveTasks.vue app/components/home/RecentProjects.vue
git commit -m "feat(home): attention, active tasks and recent projects panels"
```

---

### Task 9: Quick capture, ask the brain, and `/agent?q=`

**Files:**
- Create: `app/components/home/QuickCapture.vue`
- Create: `app/components/home/AskBrain.vue`
- Modify: `app/pages/agent/index.vue` (accept `?q=`)

**Interfaces:**
- Consumes: `POST /api/capture/note` with `{ text: string, title?: string }` returning `DocumentDTO`.
- Produces: `<HomeQuickCapture />`, `<HomeAskBrain />`.

- [ ] **Step 1: Write `app/components/home/QuickCapture.vue`**

```vue
<script setup lang="ts">
import { useQueryClient } from '@tanstack/vue-query'
import type { DocumentDTO } from '~~/shared/types/documents'

const text = ref('')
const saving = ref(false)
const toast = useToast()
const qc = useQueryClient()

async function capture() {
  const body = text.value.trim()
  if (!body || saving.value) return
  saving.value = true
  try {
    const doc = await $fetch<DocumentDTO>('/api/capture/note', {
      method: 'POST',
      body: { text: body }
    })
    text.value = ''
    toast.add({ color: 'success', title: 'Captured', description: doc.path })
    // The server publishes a `document` change, which debounce-invalidates ['home'].
    // Invalidate directly too so the row appears immediately for the acting tab.
    await qc.invalidateQueries({ queryKey: ['home'] })
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Capture failed', description: err.data?.statusMessage ?? err.message })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UCard>
    <UTextarea
      v-model="text"
      :rows="2"
      autoresize
      placeholder="Write a note…"
      class="w-full"
      @keydown.meta.enter="capture"
      @keydown.ctrl.enter="capture"
    />
    <div class="flex items-center justify-between mt-2">
      <span class="text-xs text-dimmed">⌘↵ to capture</span>
      <UButton
        size="xs"
        color="primary"
        icon="i-lucide-zap"
        label="Capture"
        :loading="saving"
        :disabled="!text.trim()"
        @click="capture"
      />
    </div>
  </UCard>
</template>
```

- [ ] **Step 2: Write `app/components/home/AskBrain.vue`**

```vue
<script setup lang="ts">
const q = ref('')

// Navigates only — it never sends. See the agent page change below.
function ask() {
  const query = q.value.trim()
  if (!query) return
  navigateTo({ path: '/agent', query: { q: query } })
}
</script>

<template>
  <UCard>
    <UInput
      v-model="q"
      icon="i-lucide-sparkles"
      placeholder="Ask about anything you've saved…"
      class="w-full"
      @keydown.enter="ask"
    />
  </UCard>
</template>
```

- [ ] **Step 3: Accept `?q=` on the agent page**

In `app/pages/agent/index.vue`, find the ref backing the composer input (the one bound to the "Type a message…" field) and prefill it on mount. Add near the top of `<script setup>`:

```ts
// Home's "Ask the brain" box hands the question over via ?q=. PREFILL ONLY —
// never auto-send: a bookmark or a back-button navigation would otherwise fire
// a model call with no user intent.
const route = useRoute()
onMounted(() => {
  const q = route.query.q
  if (typeof q === 'string' && q.trim()) {
    draft.value = q          // rename `draft` to the actual composer ref in this file
  }
})
```

Read the file first and use its real ref name. Do **not** call the send function here.

- [ ] **Step 4: Verify the capture round-trip in the browser**

```bash
playwright-cli goto "http://localhost:3000/"
playwright-cli snapshot | grep -i "Write a note"
# fill the textarea by its ref, then:
playwright-cli click <captureButtonRef>
playwright-cli eval "async () => {
  await new Promise(r => setTimeout(r, 1500));
  return { inTimeline: document.body.innerText.includes('PLAN_PROBE') };
}"
```

Expected: `inTimeline: true` — the captured note appears in the timeline without a manual reload.

Then delete the probe document:

```bash
playwright-cli eval "async () => {
  const docs = await fetch('/api/documents').then(r => r.json());
  const d = docs.find(x => (x.content||'').includes('PLAN_PROBE'));
  return d ? (await fetch('/api/documents/' + d.id, { method: 'DELETE' })).status : 'not found';
}"
```

- [ ] **Step 5: Verify `?q=` prefills without sending**

```bash
playwright-cli goto "http://localhost:3000/agent?q=what%20did%20I%20learn%20about%20postgres"
playwright-cli eval "() => {
  const i = [...document.querySelectorAll('input,textarea')].find(e => /message/i.test(e.placeholder||''));
  return { value: i?.value, messagesRendered: document.querySelectorAll('[data-role=message]').length };
}"
```

Expected: `value` contains the question, and no message was sent (the transcript is unchanged). If the transcript grew, the prefill is auto-sending — fix it.

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm typecheck
git add app/components/home/QuickCapture.vue app/components/home/AskBrain.vue app/pages/agent/index.vue
git commit -m "feat(home): quick capture + ask-the-brain handoff to /agent"
```

---

### Task 10: Full-gate run, responsive validation, and docs

**Files:**
- Create: `docs/wiki/home.md`
- Modify: `docs/superpowers/plans/00-roadmap.md` (cycle 56 row)
- Modify: `docs/BACKLOG.md` (mark the home item, list the deferred audit findings)
- Create: `docs/handovers/2026-08-15-home-dashboard.md`

- [ ] **Step 1: Run every gate**

```bash
pnpm typecheck && pnpm test && pnpm build
```

Expected: typecheck 0 errors; the full suite green with the new `home-range`, `home-timeline` and `live-dispatch` tests included; build clean. Record the exact test count for the handover.

- [ ] **Step 2: Validate at 1280×800**

```bash
playwright-cli resize 1280 800
playwright-cli goto "http://localhost:3000/"
playwright-cli screenshot --filename=/tmp/home-desktop.png
```

Read the PNG. Confirm: metrics strip on top, timeline in the wide left column, five rail panels on the right, no overlapping or clipped content.

- [ ] **Step 3: Prove the range switch drives the timeline but NOT attention**

```bash
playwright-cli eval "async () => {
  const read = () => ({
    attention: [...document.querySelectorAll('a')].map(a=>a.textContent.trim()).filter(t=>/conflicts|unreviewed|unacked|input/.test(t)),
    rows: document.querySelectorAll('[href^=\"/sessions/\"],[href^=\"/activity/\"]').length
  });
  return read();
}"
# click the 30d button by ref, wait, then re-read
```

Expected: `attention` strings are byte-identical between `1d` and `30d`; `rows` differs. If attention changes, the service is range-scoping it — a spec violation.

- [ ] **Step 4: Validate at 390×844 (mobile treatment 2)**

```bash
playwright-cli resize 390 844
playwright-cli goto "http://localhost:3000/"
playwright-cli eval "() => {
  const d = document.documentElement;
  const over = [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > d.clientWidth + 2);
  const hidden = [...document.querySelectorAll('button,a')].filter(e => getComputedStyle(e).opacity === '0');
  return { horizontalScroll: d.scrollWidth > d.clientWidth, scrollW: d.scrollWidth, clientW: d.clientWidth, overflowing: over.length, hoverGated: hidden.length };
}"
playwright-cli screenshot --filename=/tmp/home-mobile.png
```

Expected: `horizontalScroll: false`, `overflowing: 0`, `hoverGated: 0`. All three are audit regressions this page must not repeat — Tasks' CTA clips 20px past the viewport, and Clipboard's 16 Copy buttons are all `opacity: 0` on touch. Read the PNG and confirm DOM order is preserved (metrics row first, scrollable sideways).

- [ ] **Step 5: Write `docs/wiki/home.md`**

One page describing what the home dashboard does **today**: the route, the four range keys and the `mm.home.range` cookie, the single `/api/home` payload vs the separate rig query, the timeline collapse rules and cap, the non-range-scoped attention counts, and the debounced `['home']` invalidation. Set `status: shipped` on the wiki ladder. Mirror it to MyMind (`save_document` to `/projects/mymind/wiki/home.md`) per the standing rule.

- [ ] **Step 6: Update the roadmap and backlog**

Add the cycle 56 row to `docs/superpowers/plans/00-roadmap.md` following the existing format (status, spec link, plan link, handover link). In `docs/BACKLOG.md`, record the four deferred audit findings as named follow-ups: capture titling, sidebar IA, login deep-link preservation, and the document-editor data loss.

- [ ] **Step 7: Write the handover**

`docs/handovers/2026-08-15-home-dashboard.md` with accurate frontmatter (`title`, `cycle: 56`, `date`, `status`, `branch`, `spec`, `plan`, `docs`, `task: 071804bd-62e2-42fa-bdc3-984235cfe227`). Record the measured gate numbers, the two shipped-code corrections (the `messages_created_at_idx` migration and the `getUsageSince` split), the screenshots, and anything that surprised you during the build.

- [ ] **Step 8: Commit**

```bash
git add docs/
git commit -m "docs(cycle-56): home dashboard wiki, roadmap row, backlog, handover"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: routing + range → 1, 6; timeline grouping → 2; the usage split + index → 3; the single endpoint → 4; live reactivity → 5; panels → 6, 7, 8, 9; errors and empty states → 6 (page error/skeleton), 7 (quiet range), 8 (nothing waiting), 6 (unpriced + rig unavailable); mobile → 6 (scroll row), 7 (show more), 10 (validation); testing → 1, 2, 4, 5, 10. The four out-of-scope items are recorded in Task 10 Step 6 rather than silently dropped.

**Placeholder scan.** No TBD/TODO. Every code step carries real code. The two places that say "read the file first and use its real name" (the agent composer ref in Task 9, the snapshot response shape in Task 6) are deliberate — those are existing symbols the plan cannot safely guess, and each names the exact file and what to look for.

**Type consistency.** `HomeRangeKey`, `HomeResponse`, `HomeTimeline`, `TimelineEntry`, `RawEvent`, `HomeAttention`, `HomeTaskRow`, `HomeProjectRow`, `HomeUsage` are defined once in Task 1 and used with the same shapes in Tasks 2, 4, 6, 7, 8. `buildTimeline(events, opts)` is declared in Task 2 and called with one argument in Task 4 (cap defaults). `getUsageSince(start)` is produced in Task 3 and consumed in Task 4, and Task 3 returns `Omit<UsageResponse, 'range'>` — Task 4 reads only `.totals` and `.unpriced`, both of which survive the Omit. `HOME_DEBOUNCE_MS` is produced in Task 5 and imported by its own test only.

**One thing a reviewer should watch:** Task 6 Step 2 references five components that Tasks 7-9 create. The page will not render between Task 6 and Task 9. If tasks are executed by separate subagents, Task 6's reviewer must not treat the broken render as a defect — it is resolved by Task 9.
