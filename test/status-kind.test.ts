import { describe, it, expect } from 'vitest'
import { kindForStatus, statusForKind } from '../server/lib/tasks/status-kind'

describe('status <-> kind', () => {
  it('maps every status to its kind', () => {
    expect(kindForStatus('todo')).toBe('open')
    expect(kindForStatus('in_progress')).toBe('started')
    expect(kindForStatus('completed')).toBe('done')
    expect(kindForStatus('blocked')).toBe('blocked')
  })

  it('maps every kind back to its canonical status', () => {
    expect(statusForKind('open')).toBe('todo')
    expect(statusForKind('started')).toBe('in_progress')
    expect(statusForKind('done')).toBe('completed')
    expect(statusForKind('blocked')).toBe('blocked')
  })

  // Round-tripping is what keeps an agent's create_task(status=X) readable as X later.
  it('round-trips every status', () => {
    for (const s of ['todo', 'in_progress', 'completed', 'blocked'] as const) {
      expect(statusForKind(kindForStatus(s))).toBe(s)
    }
  })

  // Fail loudly. A silent fallback here would file tasks into the wrong column forever.
  it('throws on an unknown status rather than guessing', () => {
    expect(() => kindForStatus('archived' as never)).toThrow()
    expect(() => statusForKind('nonsense' as never)).toThrow()
  })
})
