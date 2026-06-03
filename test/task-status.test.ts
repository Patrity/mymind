import { describe, it, expect } from 'vitest'
import { completedAtFor } from '../server/services/tasks'

describe('completedAtFor', () => {
  const now = new Date('2026-06-03T12:00:00Z')

  it('returns the passed Date when status is "completed"', () => {
    expect(completedAtFor('completed', now)).toBe(now)
  })

  it('returns null for "todo"', () => {
    expect(completedAtFor('todo', now)).toBeNull()
  })

  it('returns null for "in_progress"', () => {
    expect(completedAtFor('in_progress', now)).toBeNull()
  })

  it('returns null for "blocked"', () => {
    expect(completedAtFor('blocked', now)).toBeNull()
  })
})
