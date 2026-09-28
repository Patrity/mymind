// Pure: the plain-sentence event text a fired event job reads (server/lib/agent/jobs/events.ts).
import { describe, it, expect, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: 'postgres://unused' }))

const { eventBlock } = await import('../server/lib/agent/jobs/events')

describe('eventBlock', () => {
  it('M2: a summary that already ends a sentence gets no second full stop', () => {
    const t = eventBlock('cc.session_end', { title: 'x', project: 'mymind', durationMinutes: 3, summary: 'All done.' })
    expect(t).toContain('Summary: All done.')
    expect(t).not.toContain('..')
    expect(eventBlock('cc.session_end', { summary: 'Shipped it!' })).not.toMatch(/!\./)
  })

  it('M2: a summary without end punctuation gets exactly one', () => {
    expect(eventBlock('cc.session_end', { summary: 'fixed the tick' })).toContain('Summary: fixed the tick.')
    expect(eventBlock('cc.session_end', {})).toContain('Summary: not summarised yet.')
  })

  it('I4: a task.due batch lists every task in one sentence, no brackets', () => {
    const t = eventBlock('task.due', { tasks: [
      { taskId: 't1', title: 'Pay rent', dueDate: '2026-09-28T10:00:00.000Z' },
      { taskId: 't2', title: 'Call mum', dueDate: '2026-09-28T11:00:00.000Z' }
    ] })
    expect(t).toMatch(/^2 tasks are due and not completed yet: /)
    expect(t).toContain(`'Pay rent', due 2026-09-28T10:00:00.000Z (task id t1)`)
    expect(t).toContain(`'Call mum'`)
    expect(t).not.toMatch(/[[\]]/)
  })

  it('I4: a batch of one reads exactly like the single-task sentence', () => {
    const one = { taskId: 't1', title: 'Pay rent', dueDate: '2026-09-28T10:00:00.000Z' }
    expect(eventBlock('task.due', { tasks: [one] })).toBe(eventBlock('task.due', one))
  })
})
