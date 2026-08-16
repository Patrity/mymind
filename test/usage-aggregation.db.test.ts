// Real-Postgres aggregation test. Excluded from `pnpm test` (CI has no DB) — run with `pnpm test:db`.
//
// `pnpm test:db` runs plain vitest with no Nuxt runtime, so this file supplies what Nuxt
// normally provides at boot: load `.env` for DATABASE_URL and stub the `useRuntimeConfig`
// auto-import that `useDb()` depends on (server/db/index.ts). Same pattern as
// test/activity-count.db.test.ts / test/documents-content-hash.db.test.ts.
process.loadEnvFile('.env')
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { sql } from 'drizzle-orm'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

const { useDb } = await import('../server/db')
const { getUsage, getUsagePricingSince } = await import('../server/services/usage')

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
    // input 1000*1e-6 + output 1500*2e-6 + cacheRead 1000*1e-7 + residual 400*5e-7
    //   = 0.001 + 0.003 + 0.0001 + 0.0002 = 0.0043
    expect(m.valueUsd).toBeCloseTo(0.0043, 9)
  })

  // `cacheReadPct` is the "N% cache reads" figure on /analytics and the dashboard, and until
  // this test nothing asserted it — a mutation zeroing the cache-read accumulator passed the
  // whole suite. The expectation is derived from `byModel` (independently asserted above)
  // rather than hardcoded, because these functions aggregate the WHOLE messages table, not
  // just this file's fixture rows.
  it('cacheReadPct is derived from the same rows byModel reports', async () => {
    const r = await getUsagePricingSince(null)
    const totalOf = (t: { input: number, output: number, cacheRead: number, cacheCreation: number }) =>
      t.input + t.output + t.cacheRead + t.cacheCreation

    const tokens = r.byModel.reduce((s, m) => s + totalOf(m.tokens), 0)
    const cacheRead = r.byModel.reduce((s, m) => s + m.tokens.cacheRead, 0)

    expect(r.totals.tokens).toBe(tokens)
    expect(r.totals.cacheReadPct).toBeCloseTo((cacheRead / tokens) * 100, 9)
    // Guard: on an all-zero corpus the assertion above would hold trivially.
    expect(cacheRead).toBeGreaterThan(0)
  })

  // NOTE: this is a FORWARD guard, not proof the extraction was safe. `getUsageSince` now
  // delegates to `getUsagePricingSince`, so today the two cannot diverge by construction and
  // this test would pass even if both were wrong. What actually proved the refactor preserved
  // behaviour is the four `getUsage`-based tests above, which assert exact values through the
  // full path and passed unchanged. This test earns its place if anyone ever re-inlines the
  // pricing math into `getUsageSince` — then Home and /analytics could silently disagree.
  it('getUsagePricingSince matches getUsage on every field the dashboard reads', async () => {
    const full = await getUsage('all')
    const cheap = await getUsagePricingSince(null)

    expect(cheap.totals.tokens).toBe(full.totals.tokens)
    expect(cheap.totals.cacheReadPct).toBe(full.totals.cacheReadPct)
    expect(cheap.totals.valueUsd).toBe(full.totals.valueUsd)
    expect(cheap.unpriced.models).toEqual(full.unpriced.models)
    expect(cheap.unpriced.tokens).toBe(full.unpriced.tokens)
    expect(cheap.byModel).toEqual(full.byModel)

    // Guard against the assertions above passing on empty fixtures.
    expect(cheap.totals.tokens).toBeGreaterThan(0)
    expect(cheap.unpriced.models.length).toBeGreaterThan(0)
  })

  it('honours the start bound the same way the full path does', async () => {
    // Day 2 only: excludes the two day-1 rows (1000/1000/1000 and the 500 sidechain).
    const day2 = await getUsagePricingSince(new Date('2026-05-02T00:00:00Z'))
    const priced = day2.byModel.find(x => x.model === 'test-priced')
    expect(priced?.tokens.cacheCreation).toBe(400)
    expect(priced?.tokens.output).toBe(0) // the 1500 output tokens are all day 1
  })
})
