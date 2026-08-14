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
const { getUsage } = await import('../server/services/usage')

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
})
