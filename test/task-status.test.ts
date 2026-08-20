import { describe, it, expect } from 'vitest'
import { completedAtFor } from '../server/services/tasks'

// completedAtFor keys on a column's KIND, not the legacy status string — a task moved into
// ANY done-kind column (whatever it's named) must get stamped. See task-columns.db.test.ts
// for the DB-level proof against a custom-named done column.
describe('completedAtFor', () => {
  const now = new Date('2026-06-03T12:00:00Z')

  it('returns the passed Date when kind is "done"', () => {
    expect(completedAtFor('done', now)).toBe(now)
  })

  it('returns null for "open"', () => {
    expect(completedAtFor('open', now)).toBeNull()
  })

  it('returns null for "started"', () => {
    expect(completedAtFor('started', now)).toBeNull()
  })

  it('returns null for "blocked"', () => {
    expect(completedAtFor('blocked', now)).toBeNull()
  })
})
