import { describe, it, expect } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { reviewedCondition } from './memory'

// NOTE on mechanism: the brief's suggested `JSON.stringify(cond)` approach throws
// ("Converting circular structure to JSON") because drizzle SQL conditions embed
// the pgTable/column objects, which are circular. `PgDialect#sqlToQuery` is
// drizzle's own query compiler — it renders the condition to the exact literal
// Postgres text (e.g. `"memories"."reviewed_at" is not null`) with no DB
// connection required, so it inspects the *actual* generated SQL rather than a
// JSON approximation of it. This is a strictly more precise mechanism than
// JSON.stringify would have been, and (per the brief) strictly better than a
// shape assertion like `toBeDefined()`.
const dialect = new PgDialect()

const sqlText = (cond: NonNullable<ReturnType<typeof reviewedCondition>>): string =>
  dialect.sqlToQuery(cond).sql.toLowerCase()

describe('reviewedCondition', () => {
  it('builds an IS NOT NULL check for reviewed: true', () => {
    const s = sqlText(reviewedCondition(true)!)
    expect(s).toContain('is not null')
    expect(s).not.toContain('is null') // would fail if the two branches were swapped
  })

  it('builds an IS NULL check for reviewed: false', () => {
    const s = sqlText(reviewedCondition(false)!)
    expect(s).toContain('is null')
    expect(s).not.toContain('is not null') // would fail if the two branches were swapped
  })

  it('applies no filter when unset', () => {
    expect(reviewedCondition(undefined)).toBeUndefined()
  })

  it('references the reviewed_at column, not some other timestamp', () => {
    expect(sqlText(reviewedCondition(true)!)).toContain('reviewed_at')
    expect(sqlText(reviewedCondition(false)!)).toContain('reviewed_at')
  })
})
