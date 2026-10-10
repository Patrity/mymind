import { describe, it, expect } from 'vitest'
import { toTaskSummaryDTO } from './tasks'

const row = {
  id: 't1',
  title: 'Do the thing',
  description: 'x'.repeat(20_000),
  columnKind: 'open', // -> statusForKind('open') === 'todo'
  priority: 'high',
  dueDate: null,
  project: 'mymind',
  order: 0,
  createdAt: new Date('2026-07-01T00:00:00Z'),
  updatedAt: new Date('2026-07-29T00:00:00Z'),
  completedAt: null
}

describe('toTaskSummaryDTO', () => {
  it('omits the task description', () => {
    const s = toTaskSummaryDTO(row as never)
    expect('description' in s).toBe(false)
    expect(JSON.stringify(s)).not.toContain('xxxx')
  })

  it('keeps triage fields', () => {
    expect(toTaskSummaryDTO(row as never)).toEqual({
      id: 't1',
      title: 'Do the thing',
      status: 'todo',
      priority: 'high',
      project: 'mymind',
      dueDate: null,
      updatedAt: '2026-07-29T00:00:00.000Z'
    })
  })
})
