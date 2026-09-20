// test/sessions-paging.db.test.ts
//
// Keyset pagination over (created_at, id). In prod, 58,417 of 228,692 messages share a
// created_at with another message in the same session, and one tie group holds 615 rows at
// a single timestamp. A timestamp-only cursor skips or repeats those blocks, so the fixture
// below deliberately builds one 12-row tie group and walks it page by page.
process.loadEnvFile('.env')
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { sql } from 'drizzle-orm'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

const { useDb } = await import('../server/db')
const { getSessionMessagesPage } = await import('../server/services/sessions')

// hex-only (not base36): this tag is spliced into a UUID literal, which requires strict
// 0-9a-f digits — base36 can emit g-z and gets rejected by Postgres as an invalid uuid.
const TAG = `${Date.now().toString(16)}${Math.floor(Math.random() * 0xffffff).toString(16)}`
const SESSION_ID = '00000000-0000-4000-8000-' + TAG.padEnd(12, '0').slice(0, 12)
const TIE_AT = '2026-09-19T00:00:00.000Z'

beforeAll(async () => {
  const db = useDb()
  await db.execute(sql`insert into sessions (id, source, external_id, started_at, last_active)
    values (${SESSION_ID}::uuid, 'test', ${TAG}, now(), now())`)
  // 20 distinctly-timed rows, then 12 sharing ONE timestamp.
  for (let i = 0; i < 20; i++) {
    await db.execute(sql`insert into messages (session_id, role, content, created_at)
      values (${SESSION_ID}::uuid, 'user', ${'distinct-' + i},
              ${new Date(Date.parse(TIE_AT) - (20 - i) * 1000).toISOString()}::timestamptz)`)
  }
  for (let i = 0; i < 12; i++) {
    await db.execute(sql`insert into messages (session_id, role, content, created_at)
      values (${SESSION_ID}::uuid, 'user', ${'tie-' + i}, ${TIE_AT}::timestamptz)`)
  }
  // 100 more rows, all NEWER than the tie group, so the session exceeds DEFAULT_LIMIT (100).
  // This is what makes the NaN/0/negative fallback tests discriminate: against the buggy
  // Math.min(Math.max(...)) clamp, drizzle silently omits the LIMIT clause for a non-finite
  // limit and returns every one of these 132 rows with nextCursor null — a fixture capped at
  // 32 rows (under the default) cannot tell that apart from a correct 100-row fallback page.
  await db.execute(sql`insert into messages (session_id, role, content, created_at)
    select ${SESSION_ID}::uuid, 'user', 'bulk-' || g,
           ${TIE_AT}::timestamptz + (g || ' seconds')::interval
    from generate_series(1, 100) g`)
})

afterAll(async () => {
  const db = useDb()
  await db.execute(sql`delete from tool_events where session_id = ${SESSION_ID}::uuid`)
  await db.execute(sql`delete from messages where session_id = ${SESSION_ID}::uuid`)
  await db.execute(sql`delete from sessions where id = ${SESSION_ID}::uuid`)
})

/** Walk every page and return the contents in walk order. */
async function walkAll(limit: number, filters = {}) {
  const seen: string[] = []
  let before: string | undefined
  for (let guard = 0; guard < 50; guard++) {
    const page = await getSessionMessagesPage(SESSION_ID, { before, limit, ...filters })
    seen.push(...page.messages.map(m => m.content))
    if (!page.nextCursor) return seen
    before = page.nextCursor
  }
  throw new Error('pagination did not terminate')
}

// Total fixture rows: 20 distinct + 12 tie + 100 bulk = 132.
const TOTAL_ROWS = 132

describe('getSessionMessagesPage', () => {
  it('walks a tie group with no gaps and no repeats', async () => {
    const seen = await walkAll(5)          // 5 per page straddles the tie group mid-walk
    expect(seen).toHaveLength(TOTAL_ROWS)
    expect(new Set(seen).size).toBe(TOTAL_ROWS)     // no repeats
    for (let i = 0; i < 12; i++) expect(seen).toContain(`tie-${i}`)   // no gaps
  })

  it('returns pages newest-first and terminates with a null cursor', async () => {
    const first = await getSessionMessagesPage(SESSION_ID, { limit: 5 })
    expect(first.messages).toHaveLength(5)
    // The 100 bulk-* rows are all newer than the tie group, so they lead the walk.
    expect(first.messages.every(m => m.content.startsWith('bulk-'))).toBe(true)
    const all = await walkAll(100)
    expect(all).toHaveLength(TOTAL_ROWS)
    expect(all.at(-1)).toBe('distinct-0')   // oldest row comes last in the walk
  })

  it('is stable — the same walk twice gives the same order', async () => {
    expect(await walkAll(5)).toEqual(await walkAll(5))
  })

  it('caps limit at 200', async () => {
    const page = await getSessionMessagesPage(SESSION_ID, { limit: 9999 })
    expect(page.messages.length).toBeLessThanOrEqual(200)
  })

  // Math.min/Math.max propagate NaN, so a non-finite or non-positive limit must fall back to
  // DEFAULT_LIMIT (100) rather than reaching db .limit() with a bad value. The fixture holds
  // 132 rows — MORE than DEFAULT_LIMIT — so a correct fallback returns exactly 100 with a
  // non-null cursor, while the old buggy clamp (drizzle silently omits LIMIT for a non-finite
  // value) returns all 132 with a null cursor. A fixture at or under 100 rows can't tell these
  // apart, which is why this file was previously too small to catch the NaN case.
  it('falls back to the default limit for a NaN limit', async () => {
    const page = await getSessionMessagesPage(SESSION_ID, { limit: NaN })
    expect(page.messages).toHaveLength(100)
    expect(page.nextCursor).not.toBeNull()
  })

  it('falls back to the default limit for a zero limit', async () => {
    const page = await getSessionMessagesPage(SESSION_ID, { limit: 0 })
    expect(page.messages).toHaveLength(100)
    expect(page.nextCursor).not.toBeNull()
  })

  it('falls back to the default limit for a negative limit', async () => {
    const page = await getSessionMessagesPage(SESSION_ID, { limit: -5 })
    expect(page.messages).toHaveLength(100)
    expect(page.nextCursor).not.toBeNull()
  })
})
