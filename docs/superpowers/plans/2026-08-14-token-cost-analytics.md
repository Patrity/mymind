# Token & Cost Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a **Usage** tab to `/analytics` showing historical token consumption and API-equivalent value across Claude Code sessions and LiteLLM, with per-model breakdown, cache economics, and agent-dispatch composition.

**Architecture:** No new collection — `messages.usage` has carried the data since April. Two new tables (`model_prices`, `litellm_daily`) supply pricing and durable LiteLLM history. A **pure, unit-tested cost function** turns usage + rates into value; aggregation queries join `messages` to `model_prices`; two new endpoints follow the existing `server/api/analytics/*` shape; the page gains tabs.

**Tech Stack:** Nuxt 4 / Nitro, Drizzle + Postgres, `@tanstack/vue-query`, `@unovis/vue`, Nuxt UI v4, Vitest.

## Global Constraints

- **`pnpm` only.** Gates: `pnpm typecheck`, `pnpm test`, `pnpm build` — all clean.
- **Do not modify the ingest.** `server/db/schema/messages.ts`, `sessions.ts`, `tool-events.ts` and anything writing them are **read-only** for this cycle. If a panel needs a field we don't store, cut the panel and report it — do not widen the ingest.
- **No new Postgres dependency in `pnpm test`.** CI has no database and `deploy` needs `test`. DB-touching tests go in `*.db.test.ts` (picked up only by `pnpm test:db`).
- **The figure is "API-equivalent value", never "cost"/"spend"** on any Claude Code surface. LiteLLM spend IS real money and must stay visually and semantically distinct. **Never sum the two into one headline number.**
- **Unpriced models are never silently zeroed** — they aggregate into an explicit bucket with their token count.
- **The two tabs must not share a `range` ref.** `RangeKey` (`1h|6h|24h|7d`, Prometheus) and `UsageRangeKey` (`7d|30d|90d|all`, daily buckets) are disjoint value spaces that happen to spell `7d` the same.
- **Charts follow the existing palette convention** in `app/components/analytics/TimeSeriesChart.vue` (the `CATEGORICAL_LIGHT`/`CATEGORICAL_DARK` arrays and `chromeVars` light/dark theming). Do not invent a new palette or re-derive one.
- Every mutation-free read endpoint is already auth-gated by `server/middleware/auth.ts`. Do not add or bypass auth.

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `server/db/schema/model-prices.ts` | Create | `model_prices` table |
| `server/db/schema/litellm-daily.ts` | Create | `litellm_daily` table |
| `server/db/schema/index.ts` | Modify | Export both |
| `server/db/migrations/0031_*.sql` | Generated | Migration |
| `shared/types/usage.ts` | Create | Client/server DTOs + `USAGE_RANGE_KEYS` |
| `server/lib/analytics/cost.ts` | Create | **Pure** usage-parsing + value maths (no DB, no I/O) |
| `test/usage-cost.test.ts` | Create | Unit tests for the above |
| `server/lib/analytics/prices.ts` | Create | Price-map fetch + extraction (pure extraction split from I/O) |
| `test/usage-prices.test.ts` | Create | Extraction tests on a fixture |
| `server/tasks/sync-model-prices.ts` | Create | Scheduled price upsert |
| `server/tasks/rollup-litellm-daily.ts` | Create | Scheduled LiteLLM daily rollup |
| `server/services/usage.ts` | Create | Aggregation queries |
| `server/api/analytics/usage.get.ts` | Create | Tiles + series endpoint |
| `server/api/analytics/dispatches.get.ts` | Create | Dispatch composition endpoint |
| `nuxt.config.ts` | Modify | Register the two scheduled tasks |
| `app/composables/useAnalytics.ts` | Modify | `useUsage` / `useDispatches` query hooks |
| `app/components/analytics/UsageTiles.vue` | Create | The 4 tiles |
| `app/components/analytics/UsageStackedChart.vue` | Create | Daily stacked bars by model |
| `app/components/analytics/UsageBreakdownBars.vue` | Create | Value-by-model + fleet composition |
| `app/pages/analytics.vue` | Modify | Tabs; move range control into each tab |
| `docs/wiki/analytics.md` | Modify | Usage section |
| `docs/superpowers/plans/00-roadmap.md` | Modify | Cycle 55 row |

**Reference:** the design spec is `docs/superpowers/specs/2026-08-14-token-cost-analytics-design.md`. Read it for rationale; this plan is the executable form.

---

### Task 1: Schema + migration

**Files:**
- Create: `server/db/schema/model-prices.ts`, `server/db/schema/litellm-daily.ts`
- Modify: `server/db/schema/index.ts`
- Generated: `server/db/migrations/0031_*.sql`

**Interfaces:**
- Produces: `modelPrices`, `litellmDaily` tables + `ModelPrice`/`NewModelPrice`, `LitellmDaily`/`NewLitellmDaily` types, imported by Tasks 3, 4, 5.

- [ ] **Step 1: Branch**

```bash
git checkout -b feat/usage-analytics
```

⚠️ If other Claude Code sessions are running in this working directory, a checkout moves `HEAD` for all of them. Use a git worktree if that's a risk.

- [ ] **Step 2: Create `server/db/schema/model-prices.ts`**

```ts
import { pgTable, text, numeric, timestamp } from 'drizzle-orm/pg-core'

/**
 * Per-model token rates, mirrored from LiteLLM's public price map.
 *
 * Stored rather than fetched per render for three reasons: the upstream map is ~1.7 MB (far too
 * heavy for a page load), storing it keeps the value tile working when the network is unreachable,
 * and it leaves an auditable record of which rate produced a given number.
 *
 * `numeric` (not `real`) because these are ~1e-7 magnitudes multiplied by billions of tokens —
 * float drift is visible at that scale.
 */
export const modelPrices = pgTable('model_prices', {
  model: text('model').primaryKey(),
  inputCostPerToken: numeric('input_cost_per_token').notNull(),
  outputCostPerToken: numeric('output_cost_per_token').notNull(),
  cacheReadCostPerToken: numeric('cache_read_cost_per_token').notNull(),
  cacheCreationCostPerToken: numeric('cache_creation_cost_per_token').notNull(),
  cacheCreationAbove1hCostPerToken: numeric('cache_creation_above_1h_cost_per_token').notNull(),
  source: text('source').notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow()
})

export type ModelPrice = typeof modelPrices.$inferSelect
export type NewModelPrice = typeof modelPrices.$inferInsert
```

- [ ] **Step 3: Create `server/db/schema/litellm-daily.ts`**

```ts
import { pgTable, text, date, bigint, numeric, primaryKey } from 'drizzle-orm/pg-core'

/**
 * Daily rollup of LiteLLM traffic, sourced from the Prometheus metrics the live panels already
 * query (`litellm_total_spend` / `litellm_total_tokens` / `litellm_requests_total`).
 *
 * A deliberate, scoped exception to the cycle-44 rule that "MyMind collects and stores no metrics".
 * That rule stands for live telemetry; it is also exactly what caps usable history at Prometheus
 * retention. Persisting a daily rollup buys unbounded history AND lets the combined chart be one
 * Postgres query instead of a Postgres-join-Prometheus per render. Do not "fix" this back.
 *
 * `spend` here is REAL MONEY, unlike the API-equivalent value computed for Claude Code usage.
 */
export const litellmDaily = pgTable('litellm_daily', {
  day: date('day').notNull(),
  model: text('model').notNull(),
  tokens: bigint('tokens', { mode: 'number' }).notNull().default(0),
  spend: numeric('spend').notNull().default('0'),
  requests: bigint('requests', { mode: 'number' }).notNull().default(0)
}, (t) => [
  primaryKey({ columns: [t.day, t.model] })
])

export type LitellmDaily = typeof litellmDaily.$inferSelect
export type NewLitellmDaily = typeof litellmDaily.$inferInsert
```

- [ ] **Step 4: Export both from the schema index**

Append to `server/db/schema/index.ts`:

```ts
export * from './model-prices'
export * from './litellm-daily'
```

- [ ] **Step 5: Generate and apply the migration**

```bash
pnpm db:generate
pnpm db:migrate
```

Expected: a new `server/db/migrations/0031_*.sql` creating both tables. **Read the generated SQL before continuing** — confirm it only CREATEs the two new tables and does not ALTER or DROP anything existing. If it touches any other table, STOP and report.

- [ ] **Step 6: Verify the tables exist**

```bash
psql "postgres://mymind:mymind@localhost:5433/mymind" -c "\d model_prices" -c "\d litellm_daily"
```

Expected: both tables, `model_prices` keyed on `model`, `litellm_daily` keyed on `(day, model)`.

- [ ] **Step 7: Gates + commit**

```bash
pnpm typecheck && pnpm test && pnpm build
git add server/db/schema/ server/db/migrations/
git commit -m "feat(usage): add model_prices and litellm_daily tables

model_prices mirrors LiteLLM's price map so the value tile works offline and
leaves an auditable record of which rate produced a number. litellm_daily is
a deliberate exception to the analytics 'stores no metrics' rule — that rule
is what caps history at Prometheus retention."
```

---

### Task 2: The pure cost function (TDD)

This is the piece most likely to be wrong and the easiest to test in isolation. It takes usage + rates as **arguments** and touches no DB, no config, no clock.

**Files:**
- Create: `shared/types/usage.ts`, `server/lib/analytics/cost.ts`
- Test: `test/usage-cost.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 3, 4, 6):
  - `USAGE_RANGE_KEYS`, `UsageRangeKey`, `UsageResponse`, `DispatchResponse` (types)
  - `parseUsage(raw: unknown): UsageTokens`
  - `computeValue(t: UsageTokens, r: ModelRates): number`
  - `UsageTokens`, `ModelRates` interfaces

- [ ] **Step 1: Create the shared types**

`shared/types/usage.ts`:

```ts
// Shared client/server DTOs for the /analytics Usage tab. No logic here.

/**
 * Day-granularity ranges for the Usage tab. DELIBERATELY separate from `RangeKey`
 * in ./analytics.ts (`1h|6h|24h|7d`, Prometheus step derivation): both spell `7d`
 * but mean different things, and one shared ref would typecheck while producing
 * wrong queries on tab switch.
 */
export const USAGE_RANGE_KEYS = ['7d', '30d', '90d', 'all'] as const
export type UsageRangeKey = typeof USAGE_RANGE_KEYS[number]

export interface UsageTokens {
  input: number
  output: number
  cacheRead: number
  /** The reported total for cache creation; may exceed ephemeral5m + ephemeral1h. */
  cacheCreation: number
  ephemeral5m: number
  ephemeral1h: number
}

export interface ModelRates {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  cacheCreationAbove1h: number
}

export interface ModelUsageRow {
  model: string
  tokens: UsageTokens
  /** null when the model has no price entry — rendered in the unpriced bucket, never as 0. */
  valueUsd: number | null
}

export interface UsageDayPoint { day: string, byModel: Record<string, number> }

export interface UsageResponse {
  range: UsageRangeKey
  totals: {
    tokens: number
    cacheReadPct: number
    valueUsd: number
    sessions: number
    dispatches: number
  }
  byModel: ModelUsageRow[]
  daily: UsageDayPoint[]
  unpriced: { models: string[], tokens: number }
  litellm: { day: string, spendUsd: number, tokens: number }[]
}

export interface DispatchResponse {
  range: UsageRangeKey
  bySubagent: { subagentType: string, count: number }[]
}
```

- [ ] **Step 2: Write the failing test**

`test/usage-cost.test.ts`:

```ts
// The cost maths, in isolation. This is where a wrong number would come from: cache reads are
// ~95% of all tokens and price at ~10% of the input rate, so a flat input rate would overstate
// the total by roughly 10x.
import { describe, it, expect } from 'vitest'
import { parseUsage, computeValue } from '../server/lib/analytics/cost'
import type { ModelRates } from '../shared/types/usage'

// Real claude-opus-4-7 rates from LiteLLM's price map.
const OPUS: ModelRates = {
  input: 5e-6, output: 2.5e-5, cacheRead: 5e-7,
  cacheCreation: 6.25e-6, cacheCreationAbove1h: 1e-5
}

describe('parseUsage', () => {
  it('reads every field from a real Claude Code usage blob', () => {
    const t = parseUsage({
      input_tokens: 2, output_tokens: 2694,
      cache_read_input_tokens: 833477, cache_creation_input_tokens: 8271,
      cache_creation: { ephemeral_1h_input_tokens: 8271, ephemeral_5m_input_tokens: 0 }
    })
    expect(t).toEqual({
      input: 2, output: 2694, cacheRead: 833477,
      cacheCreation: 8271, ephemeral5m: 0, ephemeral1h: 8271
    })
  })

  it('returns zeros for null/garbage rather than throwing', () => {
    const zero = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, ephemeral5m: 0, ephemeral1h: 0 }
    expect(parseUsage(null)).toEqual(zero)
    expect(parseUsage({})).toEqual(zero)
    expect(parseUsage({ input_tokens: 'nonsense' })).toEqual(zero)
  })

  it('tolerates a missing cache_creation object', () => {
    const t = parseUsage({ input_tokens: 10, cache_creation_input_tokens: 500 })
    expect(t.ephemeral5m).toBe(0)
    expect(t.ephemeral1h).toBe(0)
    expect(t.cacheCreation).toBe(500)
  })
})

describe('computeValue', () => {
  it('prices each of the five token classes at its own rate', () => {
    const v = computeValue(
      { input: 1000, output: 1000, cacheRead: 1000, cacheCreation: 2000, ephemeral5m: 1000, ephemeral1h: 1000 },
      OPUS
    )
    // 1000*5e-6 + 1000*2.5e-5 + 1000*5e-7 + 1000*6.25e-6 + 1000*1e-5 = 0.04675
    expect(v).toBeCloseTo(0.04675, 10)
  })

  it('does NOT price cache reads at the input rate — the 10x trap', () => {
    const readsOnly = { input: 0, output: 0, cacheRead: 1_000_000, cacheCreation: 0, ephemeral5m: 0, ephemeral1h: 0 }
    expect(computeValue(readsOnly, OPUS)).toBeCloseTo(0.5, 10)   // at cacheRead rate
    expect(computeValue(readsOnly, OPUS)).not.toBeCloseTo(5.0, 2) // NOT at input rate
  })

  it('prices the residual when cache_creation exceeds the ephemeral split', () => {
    // The real shape: 3 rows of 81,954 report cache_creation_input_tokens with BOTH tiers at 0.
    // Dropping the residual would silently under-report.
    const residualOnly = { input: 0, output: 0, cacheRead: 0, cacheCreation: 3028, ephemeral5m: 0, ephemeral1h: 0 }
    expect(computeValue(residualOnly, OPUS)).toBeCloseTo(3028 * 6.25e-6, 10)
  })

  it('prices the residual at the cheaper 5m rate, not the 1h rate', () => {
    const residualOnly = { input: 0, output: 0, cacheRead: 0, cacheCreation: 1000, ephemeral5m: 0, ephemeral1h: 0 }
    expect(computeValue(residualOnly, OPUS)).toBeCloseTo(1000 * 6.25e-6, 10)
    expect(computeValue(residualOnly, OPUS)).not.toBeCloseTo(1000 * 1e-5, 10)
  })

  it('never treats an over-counted split as negative value', () => {
    // Defensive: if the tiers ever exceed the reported total, the residual must clamp at 0.
    const over = { input: 0, output: 0, cacheRead: 0, cacheCreation: 100, ephemeral5m: 200, ephemeral1h: 0 }
    expect(computeValue(over, OPUS)).toBeCloseTo(200 * 6.25e-6, 10)
  })

  it('is zero for an all-zero row', () => {
    expect(computeValue({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0, ephemeral5m: 0, ephemeral1h: 0 }, OPUS)).toBe(0)
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm vitest run test/usage-cost.test.ts`
Expected: FAIL — cannot resolve `../server/lib/analytics/cost`.

- [ ] **Step 4: Implement**

`server/lib/analytics/cost.ts`:

```ts
import type { UsageTokens, ModelRates } from '../../../shared/types/usage'

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** Parse a `messages.usage` jsonb blob. Never throws — an unreadable blob is zero usage. */
export function parseUsage(raw: unknown): UsageTokens {
  const u = (raw ?? {}) as Record<string, unknown>
  const cc = (u.cache_creation ?? {}) as Record<string, unknown>
  return {
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheCreation: num(u.cache_creation_input_tokens),
    ephemeral5m: num(cc.ephemeral_5m_input_tokens),
    ephemeral1h: num(cc.ephemeral_1h_input_tokens)
  }
}

/**
 * API-equivalent value for one usage row. NOT money spent — Claude Code is subscription-billed.
 *
 * Five token classes, five rates. The residual term is load-bearing, not padding: 3 rows of
 * 81,954 in the real corpus report `cache_creation_input_tokens` while both ephemeral tiers read
 * 0, and dropping it would silently under-report. It is priced at the cheaper 5m rate so an
 * unknown tier cannot inflate the figure, and clamped at 0 so an over-counted split cannot make
 * the total negative.
 */
export function computeValue(t: UsageTokens, r: ModelRates): number {
  const residual = Math.max(0, t.cacheCreation - (t.ephemeral5m + t.ephemeral1h))
  return t.input * r.input
    + t.output * r.output
    + t.cacheRead * r.cacheRead
    + t.ephemeral5m * r.cacheCreation
    + t.ephemeral1h * r.cacheCreationAbove1h
    + residual * r.cacheCreation
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm vitest run test/usage-cost.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 6: Prove the residual test can fail**

Temporarily delete the `+ residual * r.cacheCreation` term from `computeValue` and re-run.
Expected: **FAIL** on both residual tests. **Restore it** and confirm PASS again. A test that has never been red is not evidence.

- [ ] **Step 7: Gates + commit**

```bash
pnpm typecheck && pnpm test
git add shared/types/usage.ts server/lib/analytics/cost.ts test/usage-cost.test.ts
git commit -m "feat(usage): pure API-equivalent-value maths, unit-tested

Five token classes at five rates. Cache reads are ~95% of tokens and price
at ~10% of input — a flat input rate would overstate ~10x, so that has its
own regression test. The residual term covers the 3-in-81,954 rows that
report cache_creation with both ephemeral tiers zero."
```

---

### Task 3: Price-map sync

**Files:**
- Create: `server/lib/analytics/prices.ts`, `server/tasks/sync-model-prices.ts`
- Test: `test/usage-prices.test.ts`
- Modify: `nuxt.config.ts` (register the task)

**Interfaces:**
- Consumes: `modelPrices` (Task 1), `ModelRates` (Task 2)
- Produces: `extractRates(map, models): NewModelPrice[]`, and a populated `model_prices` table for Task 4.

- [ ] **Step 1: Write the failing test**

`test/usage-prices.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { extractRates } from '../server/lib/analytics/prices'

// A fixture slice shaped exactly like LiteLLM's model_prices_and_context_window.json.
const MAP = {
  'claude-opus-4-7': {
    input_cost_per_token: 5e-6, output_cost_per_token: 2.5e-5,
    cache_read_input_token_cost: 5e-7,
    cache_creation_input_token_cost: 6.25e-6,
    cache_creation_input_token_cost_above_1hr: 1e-5
  },
  'model-without-1h': {
    input_cost_per_token: 1e-6, output_cost_per_token: 2e-6,
    cache_read_input_token_cost: 1e-7,
    cache_creation_input_token_cost: 1.25e-6
  },
  'model-without-cache': { input_cost_per_token: 3e-6, output_cost_per_token: 6e-6 }
}

describe('extractRates', () => {
  it('maps the five rates for a fully-specified model', () => {
    const [r] = extractRates(MAP, ['claude-opus-4-7'])
    expect(r).toMatchObject({
      model: 'claude-opus-4-7',
      inputCostPerToken: '0.000005',
      outputCostPerToken: '0.000025',
      cacheReadCostPerToken: '0.0000005',
      cacheCreationCostPerToken: '0.00000625',
      cacheCreationAbove1hCostPerToken: '0.00001'
    })
  })

  it('falls back to the 5m rate when above_1hr is absent — never null', () => {
    const [r] = extractRates(MAP, ['model-without-1h'])
    expect(r!.cacheCreationAbove1hCostPerToken).toBe(r!.cacheCreationCostPerToken)
  })

  it('defaults absent cache rates to 0 rather than dropping the model', () => {
    const [r] = extractRates(MAP, ['model-without-cache'])
    expect(r!.cacheReadCostPerToken).toBe('0')
    expect(r!.cacheCreationCostPerToken).toBe('0')
  })

  it('skips models absent from the map entirely — they become the unpriced bucket', () => {
    expect(extractRates(MAP, ['<synthetic>'])).toEqual([])
    expect(extractRates(MAP, ['claude-opus-4-7', '<synthetic>'])).toHaveLength(1)
  })

  it('skips a model with no input/output cost — a price entry that prices nothing is not a price', () => {
    expect(extractRates({ 'weird': { max_tokens: 100 } }, ['weird'])).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run test/usage-prices.test.ts`
Expected: FAIL — cannot resolve `../server/lib/analytics/prices`.

- [ ] **Step 3: Implement the extractor**

`server/lib/analytics/prices.ts`:

```ts
import type { NewModelPrice } from '../../db/schema/model-prices'

export const PRICE_MAP_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'

const numStr = (v: unknown, fallback = '0'): string =>
  typeof v === 'number' && Number.isFinite(v) ? v.toFixed(20).replace(/0+$/, '').replace(/\.$/, '') : fallback

/**
 * Pull the five rates we price with out of LiteLLM's price map, for the models we actually see.
 *
 * Split from the fetch so it is testable without network. Models absent from the map are skipped
 * entirely — they surface as the "unpriced" bucket rather than as zero-value rows. `<synthetic>`
 * (Claude Code's marker for locally-generated messages) is the permanent example.
 */
export function extractRates(map: Record<string, unknown>, models: string[]): NewModelPrice[] {
  const out: NewModelPrice[] = []
  for (const model of models) {
    const e = map[model] as Record<string, unknown> | undefined
    if (!e) continue
    const input = e.input_cost_per_token
    const output = e.output_cost_per_token
    if (typeof input !== 'number' || typeof output !== 'number') continue
    const creation = numStr(e.cache_creation_input_token_cost)
    out.push({
      model,
      inputCostPerToken: numStr(input),
      outputCostPerToken: numStr(output),
      cacheReadCostPerToken: numStr(e.cache_read_input_token_cost),
      cacheCreationCostPerToken: creation,
      // Absent 1h tier means the model has no separate long-cache rate — fall back to the 5m
      // rate rather than writing null, which would make the whole row unusable.
      cacheCreationAbove1hCostPerToken: numStr(e.cache_creation_input_token_cost_above_1hr, creation),
      source: 'litellm-price-map'
    })
  }
  return out
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run test/usage-prices.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the scheduled task**

`server/tasks/sync-model-prices.ts`:

```ts
import { sql } from 'drizzle-orm'
import { useDb } from '../db'
import { modelPrices, messages } from '../db/schema'
import { extractRates, PRICE_MAP_URL } from '../lib/analytics/prices'

export default defineTask({
  meta: { name: 'sync-model-prices', description: 'Mirror LiteLLM token rates for models we have used' },
  async run() {
    const db = useDb()
    // Only the models we actually see — no reason to store rates for thousands we never call.
    const seen = await db.selectDistinct({ model: messages.model }).from(messages)
    const models = seen.map(r => r.model).filter((m): m is string => !!m)
    if (models.length === 0) return { result: { upserted: 0, models: 0 } }

    const map = await $fetch<Record<string, unknown>>(PRICE_MAP_URL, { timeout: 20_000 })
    const rows = extractRates(map, models)
    if (rows.length === 0) return { result: { upserted: 0, models: models.length } }

    await db.insert(modelPrices).values(rows).onConflictDoUpdate({
      target: modelPrices.model,
      set: {
        inputCostPerToken: sql`excluded.input_cost_per_token`,
        outputCostPerToken: sql`excluded.output_cost_per_token`,
        cacheReadCostPerToken: sql`excluded.cache_read_cost_per_token`,
        cacheCreationCostPerToken: sql`excluded.cache_creation_cost_per_token`,
        cacheCreationAbove1hCostPerToken: sql`excluded.cache_creation_above_1h_cost_per_token`,
        source: sql`excluded.source`,
        fetchedAt: sql`now()`
      }
    })
    // Unpriced models are expected (e.g. '<synthetic>') — report, don't fail.
    return { result: { upserted: rows.length, models: models.length, unpriced: models.length - rows.length } }
  }
})
```

- [ ] **Step 6: Register it in `nuxt.config.ts`**

In the `scheduledTasks` block, add a daily entry. Prices change rarely; daily is ample:

```ts
      '0 4 * * *': ['sync-model-prices'],
```

- [ ] **Step 7: Run it once and verify real rows land**

```bash
pnpm dev   # in a second shell; READ THE LOG for the actual port — 3000 is often taken
```

Trigger the task (Nitro exposes `/_nitro/tasks/:name` in dev):

```bash
curl -s -X POST http://localhost:<PORT>/_nitro/tasks/sync-model-prices | head -c 400
psql "postgres://mymind:mymind@localhost:5433/mymind" -c "select model, input_cost_per_token, cache_read_cost_per_token, cache_creation_above_1h_cost_per_token from model_prices order by model"
```

Expected: rows for the 8 real Claude models. `<synthetic>` must be **absent** (it is the unpriced case). Confirm `cache_read_cost_per_token` is roughly 10% of `input_cost_per_token` — if it equals it, the extractor grabbed the wrong field.

**Cleanup:** kill only the dev PIDs you started, verifying each command line contains `Documents/GitHub/mymind` first. **Never** an unscoped `pkill`/`killall`. Killing the `pnpm` wrapper alone is not enough — the real `nuxt.mjs dev` child must be killed too.

- [ ] **Step 8: Gates + commit**

```bash
pnpm typecheck && pnpm test && pnpm build
git add server/lib/analytics/prices.ts server/tasks/sync-model-prices.ts test/usage-prices.test.ts nuxt.config.ts
git commit -m "feat(usage): mirror LiteLLM token rates into model_prices

Extraction split from the fetch so it tests without network. A model absent
from the map is skipped, not zero-priced — it surfaces in the unpriced
bucket. Missing above_1hr falls back to the 5m rate rather than null."
```

---

### Task 4: Usage aggregation + endpoints

**Files:**
- Create: `server/services/usage.ts`, `server/api/analytics/usage.get.ts`, `server/api/analytics/dispatches.get.ts`
- Test: `test/usage-range.test.ts`

**Interfaces:**
- Consumes: `parseUsage`/`computeValue` (Task 2), `modelPrices` (Task 1), `USAGE_RANGE_KEYS`/`UsageResponse`/`DispatchResponse` (Task 2)
- Produces: `GET /api/analytics/usage`, `GET /api/analytics/dispatches`; `rangeStart(range)` exported for tests.

- [ ] **Step 1: Write the failing test**

`test/usage-range.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { rangeStart, isUsageRange } from '../server/services/usage'

describe('usage range parsing', () => {
  it('accepts only the four known ranges', () => {
    expect(isUsageRange('7d')).toBe(true)
    expect(isUsageRange('30d')).toBe(true)
    expect(isUsageRange('90d')).toBe(true)
    expect(isUsageRange('all')).toBe(true)
  })

  it('rejects anything else, including the Prometheus range keys', () => {
    // '1h'/'6h'/'24h' are valid RangeKeys for the Infrastructure tab and MUST NOT be
    // accepted here — the two value spaces are disjoint.
    for (const bad of ['1h', '6h', '24h', '', 'all; drop table', '8d', 'ALL']) {
      expect(isUsageRange(bad)).toBe(false)
    }
  })

  it('maps ranges to a UTC day boundary in the past', () => {
    const now = new Date('2026-08-14T12:34:56Z')
    expect(rangeStart('7d', now)!.toISOString()).toBe('2026-08-07T00:00:00.000Z')
    expect(rangeStart('30d', now)!.toISOString()).toBe('2026-07-15T00:00:00.000Z')
  })

  it('returns null for "all" — meaning no lower bound', () => {
    expect(rangeStart('all', new Date())).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run test/usage-range.test.ts`
Expected: FAIL — cannot resolve `../server/services/usage`.

- [ ] **Step 3: Implement the service**

`server/services/usage.ts`:

```ts
import { sql } from 'drizzle-orm'
import { useDb } from '../db'
import { parseUsage, computeValue } from '../lib/analytics/cost'
import { USAGE_RANGE_KEYS } from '../../shared/types/usage'
import type {
  UsageRangeKey, UsageResponse, DispatchResponse, ModelRates, ModelUsageRow, UsageTokens
} from '../../shared/types/usage'

const DAYS: Record<Exclude<UsageRangeKey, 'all'>, number> = { '7d': 7, '30d': 30, '90d': 90 }

export function isUsageRange(v: string): v is UsageRangeKey {
  return (USAGE_RANGE_KEYS as readonly string[]).includes(v)
}

/** Lower bound for a range, truncated to UTC midnight. `all` means no bound. */
export function rangeStart(range: UsageRangeKey, now = new Date()): Date | null {
  if (range === 'all') return null
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  d.setUTCDate(d.getUTCDate() - DAYS[range])
  return d
}

// The six token fields, extracted with the SAME json paths parseUsage reads. Summing in SQL and
// applying computeValue per (model, day) group — not per row — keeps ~82k rows inside Postgres.
const TOKEN_SUMS = sql`
  sum(coalesce((usage->>'input_tokens')::bigint, 0))                                   as input,
  sum(coalesce((usage->>'output_tokens')::bigint, 0))                                  as output,
  sum(coalesce((usage->>'cache_read_input_tokens')::bigint, 0))                        as cache_read,
  sum(coalesce((usage->>'cache_creation_input_tokens')::bigint, 0))                    as cache_creation,
  sum(coalesce((usage->'cache_creation'->>'ephemeral_5m_input_tokens')::bigint, 0))    as eph_5m,
  sum(coalesce((usage->'cache_creation'->>'ephemeral_1h_input_tokens')::bigint, 0))    as eph_1h`

const toTokens = (r: Record<string, unknown>): UsageTokens => ({
  input: Number(r.input ?? 0),
  output: Number(r.output ?? 0),
  cacheRead: Number(r.cache_read ?? 0),
  cacheCreation: Number(r.cache_creation ?? 0),
  ephemeral5m: Number(r.eph_5m ?? 0),
  ephemeral1h: Number(r.eph_1h ?? 0)
})

const totalOf = (t: UsageTokens) => t.input + t.output + t.cacheRead + t.cacheCreation

export async function getUsage(range: UsageRangeKey): Promise<UsageResponse> {
  const db = useDb()
  const start = rangeStart(range)
  // Bound parameter, never interpolated — and `range` is already validated at the endpoint.
  const since = start ? sql`and created_at >= ${start.toISOString()}` : sql``

  // Rates first: a model absent here is UNPRICED, never zero-valued.
  const priceRows = await db.execute(sql`select * from model_prices`)
  const rates = new Map<string, ModelRates>()
  for (const p of priceRows.rows as Record<string, unknown>[]) {
    rates.set(String(p.model), {
      input: Number(p.input_cost_per_token),
      output: Number(p.output_cost_per_token),
      cacheRead: Number(p.cache_read_cost_per_token),
      cacheCreation: Number(p.cache_creation_cost_per_token),
      cacheCreationAbove1h: Number(p.cache_creation_above_1h_cost_per_token)
    })
  }

  // Sidechain rows are INCLUDED on purpose — subagent usage is real usage.
  const perModel = await db.execute(sql`
    select model, ${TOKEN_SUMS}
    from messages
    where usage is not null and model is not null ${since}
    group by model`)

  const perDay = await db.execute(sql`
    select to_char(date_trunc('day', created_at), 'YYYY-MM-DD') as day, model, ${TOKEN_SUMS}
    from messages
    where usage is not null and model is not null ${since}
    group by 1, 2 order by 1`)

  const byModel: ModelUsageRow[] = []
  const unpricedModels: string[] = []
  let unpricedTokens = 0, totalTokens = 0, totalCacheRead = 0, totalValue = 0

  for (const row of perModel.rows as Record<string, unknown>[]) {
    const model = String(row.model)
    const tokens = toTokens(row)
    const r = rates.get(model)
    const valueUsd = r ? computeValue(tokens, r) : null
    totalTokens += totalOf(tokens)
    totalCacheRead += tokens.cacheRead
    if (valueUsd === null) { unpricedModels.push(model); unpricedTokens += totalOf(tokens) }
    else totalValue += valueUsd
    byModel.push({ model, tokens, valueUsd })
  }
  byModel.sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0))

  const dailyMap = new Map<string, Record<string, number>>()
  for (const row of perDay.rows as Record<string, unknown>[]) {
    const day = String(row.day)
    if (!dailyMap.has(day)) dailyMap.set(day, {})
    dailyMap.get(day)![String(row.model)] = totalOf(toTokens(row))
  }

  const [{ rows: [sessRow] }, { rows: [dispRow] }, litellmRes] = await Promise.all([
    db.execute(sql`select count(distinct session_id)::int as n from messages where usage is not null ${since}`),
    db.execute(sql`select count(*)::int as n from tool_events where tool_name = 'Agent' ${since}`),
    db.execute(sql`select to_char(day,'YYYY-MM-DD') as day, sum(spend)::float8 as spend, sum(tokens)::bigint as tokens
                   from litellm_daily ${start ? sql`where day >= ${start.toISOString().slice(0, 10)}` : sql``}
                   group by 1 order by 1`)
  ])

  return {
    range,
    totals: {
      tokens: totalTokens,
      cacheReadPct: totalTokens > 0 ? (totalCacheRead / totalTokens) * 100 : 0,
      valueUsd: totalValue,
      sessions: Number((sessRow as Record<string, unknown>)?.n ?? 0),
      dispatches: Number((dispRow as Record<string, unknown>)?.n ?? 0)
    },
    byModel,
    daily: [...dailyMap.entries()].map(([day, byModel]) => ({ day, byModel })),
    unpriced: { models: unpricedModels, tokens: unpricedTokens },
    litellm: (litellmRes.rows as Record<string, unknown>[]).map(r => ({
      day: String(r.day), spendUsd: Number(r.spend ?? 0), tokens: Number(r.tokens ?? 0)
    }))
  }
}

export async function getDispatches(range: UsageRangeKey): Promise<DispatchResponse> {
  const db = useDb()
  const start = rangeStart(range)
  const since = start ? sql`and created_at >= ${start.toISOString()}` : sql``
  const res = await db.execute(sql`
    select coalesce(nullif(args->>'subagent_type', ''), '(unspecified)') as subagent_type,
           count(*)::int as n
    from tool_events
    where tool_name = 'Agent' ${since}
    group by 1 order by 2 desc`)
  return {
    range,
    bySubagent: (res.rows as Record<string, unknown>[])
      .map(r => ({ subagentType: String(r.subagent_type), count: Number(r.n) }))
  }
}
```

`db.execute()` returns a node-postgres `QueryResult` — **verified empirically against this project's
own `useDb()` wiring**, not assumed: `Array.isArray(result) === false`, `result.rows` is the array of
row objects. The code above is correct as written. (The repo's only other `db.execute` call,
`server/services/activity.ts:117`, is a DELETE that discards its result, so it offers no precedent —
hence the check.)

- [ ] **Step 4: Run to verify the range tests pass**

Run: `pnpm vitest run test/usage-range.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the aggregation test against a real database**

The range test above covers parsing only. The aggregation is where day-bucketing and grouping can be
silently wrong, and it needs real Postgres — so this goes in `*.db.test.ts`, which `pnpm test` (the
CI gate, which has no database) excludes and `pnpm test:db` runs.

Create `test/usage-aggregation.db.test.ts`:

```ts
// Real-Postgres aggregation test. Excluded from `pnpm test` (CI has no DB) — run with `pnpm test:db`.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { useDb } from '../server/db'
import { getUsage } from '../server/services/usage'

const SESSION = '00000000-0000-4000-8000-00000000dead'

// Two days, two models, one sidechain row, one unpriced model, and one row whose
// cache_creation exceeds its ephemeral split (the residual case).
const usage = (i: number, o: number, cr: number, cc: number, e5: number, e1: number) =>
  JSON.stringify({
    input_tokens: i, output_tokens: o, cache_read_input_tokens: cr,
    cache_creation_input_tokens: cc,
    cache_creation: { ephemeral_5m_input_tokens: e5, ephemeral_1h_input_tokens: e1 }
  })

describe('usage aggregation (real DB)', () => {
  beforeAll(async () => {
    const db = useDb()
    await db.execute(sql`delete from messages where session_id = ${SESSION}`)
    await db.execute(sql`insert into sessions (id, source, external_id) values (${SESSION}, 'test', ${SESSION})
                         on conflict (source, external_id) do nothing`)
    await db.execute(sql`insert into model_prices
      (model, input_cost_per_token, output_cost_per_token, cache_read_cost_per_token,
       cache_creation_cost_per_token, cache_creation_above_1h_cost_per_token, source)
      values ('test-priced', 1e-6, 2e-6, 1e-7, 5e-7, 1e-6, 'test')
      on conflict (model) do nothing`)
    // day 1: priced model, plain row + a sidechain row (must be counted)
    await db.execute(sql`insert into messages (session_id, model, usage, is_sidechain, created_at) values
      (${SESSION}, 'test-priced', ${usage(1000, 1000, 1000, 0, 0, 0)}::jsonb, false, '2026-05-01T10:00:00Z'),
      (${SESSION}, 'test-priced', ${usage(0, 500, 0, 0, 0, 0)}::jsonb, true,  '2026-05-01T23:59:59Z'),
      (${SESSION}, 'test-priced', ${usage(0, 0, 0, 400, 0, 0)}::jsonb, false, '2026-05-02T00:00:01Z'),
      (${SESSION}, 'test-unpriced', ${usage(0, 100, 0, 0, 0, 0)}::jsonb, false, '2026-05-02T05:00:00Z')`)
  })

  afterAll(async () => {
    const db = useDb()
    await db.execute(sql`delete from messages where session_id = ${SESSION}`)
    await db.execute(sql`delete from model_prices where source = 'test'`)
  })

  it('buckets by UTC day across a midnight boundary', async () => {
    const r = await getUsage('all')
    const days = r.daily.map(d => d.day)
    expect(days).toContain('2026-05-01')
    expect(days).toContain('2026-05-02')
    // The 23:59:59 row belongs to day 1, the 00:00:01 row to day 2 — not lumped together.
    const d1 = r.daily.find(d => d.day === '2026-05-01')!
    expect(d1.byModel['test-priced']).toBe(1000 + 1000 + 1000 + 500) // includes the sidechain row
  })

  it('counts sidechain rows — subagent usage is real usage', async () => {
    const r = await getUsage('all')
    const m = r.byModel.find(x => x.model === 'test-priced')!
    expect(m.tokens.output).toBe(1500) // 1000 plain + 500 sidechain
  })

  it('puts an unpriced model in the bucket with null value, never 0', async () => {
    const r = await getUsage('all')
    const m = r.byModel.find(x => x.model === 'test-unpriced')!
    expect(m.valueUsd).toBeNull()
    expect(r.unpriced.models).toContain('test-unpriced')
    expect(r.unpriced.tokens).toBeGreaterThan(0)
  })

  it('prices the residual row (cache_creation with no ephemeral split)', async () => {
    const r = await getUsage('all')
    const m = r.byModel.find(x => x.model === 'test-priced')!
    // 1000*1e-6 + 1500*2e-6 + 1000*1e-7 + residual 400*5e-7 = 0.0042
    expect(m.valueUsd).toBeCloseTo(0.0042, 9)
  })
})
```

Run: `pnpm test:db`
Expected: PASS (4 tests). Then run `pnpm test` and confirm this file is **not** picked up (it must not enter the CI gate).

- [ ] **Step 6: Write the endpoints**

`server/api/analytics/usage.get.ts`:

```ts
import { getUsage, isUsageRange } from '../../services/usage'

export default defineEventHandler(async (event) => {
  // Auth is already enforced by server/middleware/auth.ts for all /api/** routes.
  const range = String(getQuery(event).range ?? '30d')
  if (!isUsageRange(range)) {
    throw createError({ statusCode: 400, statusMessage: `Unknown range: ${range}` })
  }
  return await getUsage(range)
})
```

`server/api/analytics/dispatches.get.ts`: identical shape, calling `getDispatches`.

- [ ] **Step 7: Verify against real data in dev**

Start `pnpm dev` (read the log for the port), then:

```bash
TOKEN=<an mm_ token>   # mint one if needed; revoke it afterwards
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:<PORT>/api/analytics/usage?range=all" | head -c 900
curl -s -o /dev/null -w 'bad range: %{http_code}\n' -H "Authorization: Bearer $TOKEN" "http://localhost:<PORT>/api/analytics/usage?range=1h"
```

Expected: real totals; **`range=1h` returns 400** (it is a valid Infrastructure range and must be rejected here). Sanity-check the total value against the spec's measured figure — on the full local corpus it should land near **$25,267** with **~95.5%** cache reads. A total that is ~10x high means cache reads are being priced at the input rate.

Same scoped-cleanup rule as Task 3 Step 7.

- [ ] **Step 8: Gates + commit**

```bash
pnpm typecheck && pnpm test && pnpm test:db && pnpm build
git add server/services/usage.ts server/api/analytics/ test/usage-range.test.ts test/usage-aggregation.db.test.ts
git commit -m "feat(usage): aggregation service + usage/dispatches endpoints

Range is validated against a fixed set before any query — an Infrastructure
range key like 1h is a 400 here, since the two value spaces are disjoint.
Unpriced models return valueUsd: null and their tokens land in an explicit
bucket rather than being counted as zero value."
```

---

### Task 5: LiteLLM daily rollup

**Files:**
- Create: `server/tasks/rollup-litellm-daily.ts`
- Modify: `nuxt.config.ts`

**Interfaces:**
- Consumes: `litellmDaily` (Task 1), `promInstant` + config loading from `server/lib/analytics/prom.ts` / `snapshot.ts`
- Produces: rows in `litellm_daily`, read by Task 4's `getUsage`.

- [ ] **Step 1: Write the task**

Config loading reuses the existing `loadAnalyticsConfig()` from `server/lib/analytics/store.ts`
(signature verified: `async (): Promise<AnalyticsConfig>`, memoised) — the same call
`server/api/analytics/snapshot.get.ts:8` makes. Do not re-implement it.

`server/tasks/rollup-litellm-daily.ts`:

```ts
import { sql } from 'drizzle-orm'
import { useDb } from '../db'
import { litellmDaily } from '../db/schema'
import { promInstant } from '../lib/analytics/prom'
import { loadAnalyticsConfig } from '../lib/analytics/store'

/** Yesterday, UTC, as YYYY-MM-DD — the day a post-midnight run summarises. */
function yesterdayUtc(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

const byModel = (rows: { metric: Record<string, string>, value: [number, string] }[]) => {
  const m = new Map<string, number>()
  for (const r of rows) {
    const model = r.metric.model
    if (!model) continue
    const v = Number(r.value[1])
    if (Number.isFinite(v)) m.set(model, v)
  }
  return m
}

export default defineTask({
  meta: { name: 'rollup-litellm-daily', description: 'Persist a daily rollup of LiteLLM traffic' },
  async run() {
    const day = yesterdayUtc()
    const cfg = await loadAnalyticsConfig() // never null; may carry an empty prometheusUrl
    if (!cfg.prometheusUrl) return { result: { day, models: 0, unreachable: 'no prometheusUrl configured' } }

    // A metrics rollup must NEVER take the app down: an unreachable Prometheus is a recorded
    // non-event, not a throw.
    let tokens, spend, requests
    try {
      [tokens, spend, requests] = await Promise.all([
        promInstant(cfg.prometheusUrl, `sum by (model) (increase(litellm_total_tokens[24h]))`),
        promInstant(cfg.prometheusUrl, `sum by (model) (increase(litellm_total_spend[24h]))`),
        promInstant(cfg.prometheusUrl, `sum by (model) (increase(litellm_requests_total[24h]))`)
      ])
    } catch (e) {
      return { result: { day, models: 0, unreachable: (e as Error).message } }
    }

    const t = byModel(tokens), s = byModel(spend), q = byModel(requests)
    const models = [...new Set([...t.keys(), ...s.keys(), ...q.keys()])]
    if (models.length === 0) return { result: { day, models: 0, note: 'no litellm series for this window' } }

    const rows = models.map(model => ({
      day,
      model,
      tokens: Math.round(t.get(model) ?? 0),
      spend: String(s.get(model) ?? 0),
      requests: Math.round(q.get(model) ?? 0)
    }))

    // Idempotent: re-running the same day overwrites rather than duplicating.
    await useDb().insert(litellmDaily).values(rows).onConflictDoUpdate({
      target: [litellmDaily.day, litellmDaily.model],
      set: {
        tokens: sql`excluded.tokens`,
        spend: sql`excluded.spend`,
        requests: sql`excluded.requests`
      }
    })

    return { result: { day, models: models.length } }
  }
})
```

- [ ] **Step 2: Register it**

In `nuxt.config.ts` `scheduledTasks`, add a daily run shortly after midnight UTC:

```ts
      '20 0 * * *': ['rollup-litellm-daily'],
```

- [ ] **Step 3: Run it once and inspect**

With `pnpm dev` running (read the log for the port):

```bash
curl -s -X POST http://localhost:<PORT>/_nitro/tasks/rollup-litellm-daily
psql "postgres://mymind:mymind@localhost:5433/mymind" -c "select * from litellm_daily order by day desc, spend desc limit 10"
```

Expected: one row per model for yesterday, or a clean `unreachable` result if the homelab isn't reachable from this machine — **both are acceptable outcomes for this step**; record which you saw. Run it a second time and confirm the row count does **not** double (idempotency).

Same scoped-cleanup rule as Task 3 Step 7.

- [ ] **Step 4: Gates + commit**

```bash
pnpm typecheck && pnpm test && pnpm build
git add server/tasks/rollup-litellm-daily.ts nuxt.config.ts
git commit -m "feat(usage): daily LiteLLM rollup into litellm_daily

Reads the same Prometheus series the live panels already query. Upsert keyed
on (day, model) so a re-run is idempotent, and an unreachable Prometheus
returns a recorded failure rather than throwing — a metrics rollup must never
take the app down."
```

---

### Task 6: Usage tab — page restructure + tiles

**Files:**
- Modify: `app/pages/analytics.vue`, `app/composables/useAnalytics.ts`
- Create: `app/components/analytics/UsageTiles.vue`

**Interfaces:**
- Consumes: `UsageResponse`, `USAGE_RANGE_KEYS` (Task 2), `/api/analytics/usage` (Task 4)
- Produces: `useUsage(range)` / `useDispatches(range)` hooks for Task 7; the `Usage` tab shell the charts mount into.

- [ ] **Step 1: Add the query hooks**

In `app/composables/useAnalytics.ts`, following the existing `useSeries` pattern exactly (computed key so the key is reactive):

```ts
  const useUsage = (range: MaybeRefOrGetter<UsageRangeKey>) => {
    const r = computed(() => toValue(range))
    return useQuery({
      queryKey: computed(() => ['analytics', 'usage', r.value] as const),
      queryFn: () => $fetch<UsageResponse>('/api/analytics/usage', { query: { range: r.value } }),
    })
  }

  const useDispatches = (range: MaybeRefOrGetter<UsageRangeKey>) => {
    const r = computed(() => toValue(range))
    return useQuery({
      queryKey: computed(() => ['analytics', 'dispatches', r.value] as const),
      queryFn: () => $fetch<DispatchResponse>('/api/analytics/dispatches', { query: { range: r.value } }),
    })
  }
```

Import the new types, and add both to the composable's return object. **No `refetchInterval`** — this is historical data, not live telemetry.

- [ ] **Step 2: Restructure the page into tabs**

In `app/pages/analytics.vue`:
- Add `const tab = ref<'infra' | 'usage'>('infra')` and a `UTabs` in the navbar bound to it.
- **Move the existing range `UTabs` out of the navbar** into the Infrastructure tab's body, keeping its `RangeKey` type and existing `range` ref.
- Add a **separate** `const usageRange = ref<UsageRangeKey>('30d')` with its own selector inside the Usage tab body.
- Keep every existing Infrastructure panel exactly as-is — this task must not change what Infrastructure renders.

⚠️ `range` and `usageRange` are **separate refs with different types**. Do not unify them; `7d` means different things in each.

- [ ] **Step 3: Build the tiles**

`app/components/analytics/UsageTiles.vue` — props `{ usage: UsageResponse | undefined, pending: boolean }`, rendering four tiles:

| Tile | Value | Subtext |
|---|---|---|
| Total tokens | `totals.tokens`, abbreviated (e.g. `26.6B`) | `{cacheReadPct}% cache reads` |
| API-equivalent value | `totals.valueUsd` as currency | **`at API rates — not billed`** |
| Agent dispatches | `totals.dispatches` | `across {totals.sessions} sessions` |
| Sessions | `totals.sessions` | range label |

The API-equivalent subtext is **required**, not decorative — it is what stops the number being read as money. Use Nuxt UI card components consistent with `GpuTiles.vue` (read that file first and match its structure).

If `unpriced.tokens > 0`, render a small note under the tiles: `{n} tokens from unpriced models ({models}) excluded from value`. Never fold them into the value silently.

- [ ] **Step 4: Verify in the browser**

Use `playwright-cli` per project convention (see the `browser-testing` skill). Confirm:
- Both tabs render and switch.
- The Usage tiles show real numbers.
- **Switching Infrastructure's range does not change Usage's range, and vice versa** — this is the specific wiring bug this design guards against, and unit tests cannot catch it.
- The unpriced note appears (the local corpus has `<synthetic>` rows, so it should).

Take a screenshot for the report.

- [ ] **Step 5: Gates + commit**

```bash
pnpm typecheck && pnpm test && pnpm build
git add app/pages/analytics.vue app/composables/useAnalytics.ts app/components/analytics/UsageTiles.vue
git commit -m "feat(usage): tab the analytics page, add usage tiles

Infrastructure and Usage get separate range refs with different types —
7d means a Prometheus window in one and seven daily buckets in the other,
and one shared ref would typecheck while querying wrongly on tab switch.

The value tile carries an 'at API rates — not billed' subtext: Claude Code
is subscription-billed, so that number is not money spent."
```

---

### Task 7: Usage charts

**Files:**
- Create: `app/components/analytics/UsageStackedChart.vue`, `app/components/analytics/UsageBreakdownBars.vue`
- Modify: `app/pages/analytics.vue` (mount them)

**Interfaces:**
- Consumes: `useUsage`, `useDispatches` (Task 6), `UsageResponse`, `DispatchResponse`

- [ ] **Step 1: Read the existing chart conventions**

Read `app/components/analytics/TimeSeriesChart.vue` in full before writing any chart code. Reuse **verbatim**: the `CATEGORICAL_LIGHT` / `CATEGORICAL_DARK` arrays, the `colorMode`/`isDark`/`palette`/`seriesColor` pattern, and the `chromeVars` light/dark theming (Unovis's own dark selectors do not match Nuxt's `.dark` class — that comment in the file explains why). **Do not invent a new palette.**

- [ ] **Step 2: Build the stacked daily chart**

`UsageStackedChart.vue` — props `{ daily: UsageDayPoint[], models: string[] }`. Use `VisXYContainer` + `VisStackedBar` + `VisAxis` + `VisTooltip` from `@unovis/vue`. One colour per model from the shared palette, in a stable order so a model keeps its colour across renders. X axis is the day; Y axis is tokens, abbreviated (`500M`, `1.5B`).

Empty state: when `daily` is empty, render a muted "No usage in this range" rather than an empty axis frame.

- [ ] **Step 3: Build the breakdown bars**

`UsageBreakdownBars.vue` — props `{ title: string, rows: { label: string, value: number }[], format?: (v: number) => string }`. A horizontal bar list, each row `label` / bar / formatted value, sorted descending, using the same palette. Used twice: "Where the value went" (value by model) and "Fleet composition" (dispatches by subagent type).

Keep this component generic — two different data shapes feed it, and duplicating it per shape is the kind of thing the reviewer will reject.

- [ ] **Step 4: Mount them in the Usage tab**

In `app/pages/analytics.vue`, inside the Usage tab body under the tiles: the stacked chart full-width, then the two breakdown bar panels in a `lg:grid-cols-2` grid (matching the Infrastructure tab's existing grid idiom), then the LiteLLM spend row.

The LiteLLM panel must be **visually distinct** and labelled as actual spend — a different heading treatment and an explicit "actual spend" label. Do not place it in the same visual group as the API-equivalent panels.

- [ ] **Step 5: Verify in the browser**

With `playwright-cli`: confirm all charts render with real data, colours are stable per model across a range switch, the empty state appears for a range with no data, and light/dark both look correct (toggle the colour mode). Screenshot both modes.

- [ ] **Step 6: Gates + commit**

```bash
pnpm typecheck && pnpm test && pnpm build
git add app/components/analytics/ app/pages/analytics.vue
git commit -m "feat(usage): stacked daily chart + value/fleet breakdown bars

Palette and dark-mode chrome reused verbatim from TimeSeriesChart. LiteLLM
spend is rendered as a visually distinct panel labelled actual spend, never
grouped with the API-equivalent figures."
```

---

### Task 8: Documentation

**Files:**
- Modify: `docs/wiki/analytics.md`, `docs/superpowers/plans/00-roadmap.md`

- [ ] **Step 1: Add the Usage section to the wiki**

Bump frontmatter to `cycle: 55`, `updated: 2026-08-14`. Add a `## Usage tab` section covering:
- The two new tables and their columns.
- The cost formula **including the residual term**, and why cache reads must not be priced at the input rate.
- The API-equivalent-value framing rule and that LiteLLM spend is real money.
- The unpriced bucket, naming `<synthetic>` as the permanent example.
- **Explicitly**: `litellm_daily` is a deliberate exception to this page's "MyMind collects and stores no metrics" statement, with the reason (Prometheus retention caps history), so a future reader does not "fix" it. Update the existing line that makes that claim so the two don't contradict.
- The two range types and why they are separate.

**Accuracy check before committing:** re-read your section against the shipped `server/lib/analytics/cost.ts`, `server/services/usage.ts`, and both schema files. Every formula, column name, and file path must match the real code. If anything disagrees, STOP and report rather than committing a claim you know is false.

- [ ] **Step 2: Add the roadmap row**

Append a cycle 55 row matching the existing column format (`| 55 | **Title** — summary | status | spec | plan | handover |`). Status `🚧 built, not deployed` — nothing has merged. Handover column `—`.

- [ ] **Step 3: Commit**

```bash
git add docs/wiki/analytics.md docs/superpowers/plans/00-roadmap.md
git commit -m "docs(usage): document the Usage tab, cost model, and the metrics-storage exception"
```

---

### Task 9: Ship and verify

- [ ] **Step 1: Whole-branch review**

Confirm specifically:
- No file under `server/db/schema/{messages,sessions,tool-events}.ts` changed (`git diff master --stat -- server/db/schema/messages.ts server/db/schema/sessions.ts server/db/schema/tool-events.ts` → empty).
- Migration `0031` only CREATEs the two new tables.
- No surface renders the Claude Code figure as "cost" or "spend".

- [ ] **Step 2: Final gates**

Run: `pnpm typecheck && pnpm test && pnpm build`. Record the test count.

- [ ] **Step 3: Merge, push, watch CD**

```bash
git checkout master && git merge --ff-only feat/usage-analytics && git push
gh run list --limit 1
```

⚠️ **This migration runs in CD.** Unlike cycle 54, this cycle is NOT a trivial rollback — it adds tables. Rolling back the code is safe (the tables simply go unused); rolling back the *migration* is not automatic. Confirm the CD migrate step succeeded before verifying.

- [ ] **Step 4: Verify prod**

```bash
curl -s -o /dev/null -w 'health: %{http_code}\n' https://brain.costanzoclan.com/api/health
```

Then, authenticated, fetch `/api/analytics/usage?range=30d` and confirm real totals. Trigger `sync-model-prices` on prod (or wait for the 04:00 run) and confirm `model_prices` is populated — **until it is, every model is unpriced and the value tile reads $0**, which is the expected pre-population state, not a bug.

Load `/analytics` in a browser, switch to Usage, and confirm the panels render against the prod corpus.

- [ ] **Step 5: Handover + roadmap + mirror**

Write `docs/handovers/2026-08-14-token-cost-analytics.md` with accurate frontmatter, flip the roadmap row to `✅ shipped` with the CD run number, mirror the wiki and handover to MyMind, and close MyMind task `d3b04767`.

---

## Notes for the implementer

**The cost maths is the whole risk.** Everything else is presentation. Two specific traps, both with regression tests in Task 2:
1. Cache reads are ~95% of all tokens and price at ~**10%** of the input rate. Pricing them at the input rate overstates the total ~10×.
2. `cache_creation_input_tokens` can exceed `ephemeral_5m + ephemeral_1h` (3 rows of 81,954 in the real corpus). The residual term is load-bearing.

**Expected magnitude on the full local corpus: ~$25,267 across 26.56B tokens, 95.5% cache reads.** If your numbers are far from that, something is wrong — check before proceeding.

**Do not widen the ingest.** If a panel needs a field `messages.usage` doesn't have, cut the panel and report it.

**Process hygiene:** several tasks run a dev server. Read the startup log for the actual port — 3000 is frequently taken by an unrelated project and Nuxt silently falls back to 3001, so a curl against 3000 can hit a completely different app and appear to pass. Kill only PIDs you started, after verifying their command line contains `Documents/GitHub/mymind`. **Never** an unscoped `pkill`/`killall` — that has previously killed an unrelated project's dev server.
