// test/activity-count.db.test.ts
//
// `pnpm test:db` runs plain vitest with no Nuxt runtime, so this file supplies what Nuxt
// normally provides at boot: load `.env` for DATABASE_URL and stub the `useRuntimeConfig`
// auto-import that `useDb()` depends on (server/db/index.ts). Same pattern as
// test/documents-content-hash.db.test.ts — pointed at the real local DB because the whole
// point is asserting the real count query, not a mock of it.
process.loadEnvFile('.env')
import { describe, it, expect, vi, afterEach } from 'vitest'
import { sql } from 'drizzle-orm'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

const { useDb } = await import('../server/db')
const { countErrors } = await import('../server/services/activity')

const MARK = 'countErrors.probe'

afterEach(async () => {
  await useDb().execute(sql`delete from activity_log where name like ${MARK + '%'}`)
})

describe('countErrors (the unacked-error badge)', () => {
  // The badge counts what the user must triage. withFailoverOver writes TWO rows for one
  // failure — a per-attempt diagnostic (severity 'warn') and the terminal all-failed row
  // (severity 'error') — so keying the count off `status` alone double-counted every
  // failure (prod: 6 cancelled STT turns read as 12 errors).
  it('counts one failure once, not once per attempt row', async () => {
    const db = useDb()
    const before = (await countErrors()).unacked

    await db.execute(sql`
      insert into activity_log (trace_id, kind, name, status, severity) values
        (gen_random_uuid(), 'attempt', ${MARK + '.attempt'}, 'error', 'warn'),
        (gen_random_uuid(), 'model',   ${MARK + '.all-failed'}, 'error', 'error')
    `)

    expect((await countErrors()).unacked).toBe(before + 1)
  })

  it('ignores a failure the failover chain recovered from (attempt warn with no terminal error)', async () => {
    const db = useDb()
    const before = (await countErrors()).unacked

    await db.execute(sql`
      insert into activity_log (trace_id, kind, name, status, severity) values
        (gen_random_uuid(), 'attempt', ${MARK + '.recovered'}, 'error', 'warn'),
        (gen_random_uuid(), 'attempt', ${MARK + '.succeeded'}, 'ok',    'info')
    `)

    expect((await countErrors()).unacked).toBe(before)
  })

  it('still counts a genuine unacked error and surfaces it as `latest`', async () => {
    const db = useDb()
    const before = (await countErrors()).unacked

    await db.execute(sql`
      insert into activity_log (trace_id, kind, name, status, severity) values
        (gen_random_uuid(), 'inbound', ${MARK + '.real'}, 'error', 'error')
    `)

    const after = await countErrors()
    expect(after.unacked).toBe(before + 1)
    expect(after.latest?.name).toBe(MARK + '.real')
  })

  it('does not count an acked error', async () => {
    const db = useDb()
    const before = (await countErrors()).unacked

    await db.execute(sql`
      insert into activity_log (trace_id, kind, name, status, severity, acked_at) values
        (gen_random_uuid(), 'inbound', ${MARK + '.acked'}, 'error', 'error', now())
    `)

    expect((await countErrors()).unacked).toBe(before)
  })
})
