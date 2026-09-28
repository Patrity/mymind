import { describe, it, expect } from 'vitest'
import { eventModelText, wakeOrigin } from '../server/lib/agent/runtime/event-text'
import { rowToAgentMessage } from '../server/services/conversations'

describe('event rows in model history', () => {
  it('renders a wake event as a plain sentence with no bracketed marker', () => {
    const t = eventModelText(wakeOrigin('admin'), 'summarise yesterday')
    expect(t).toBe('Background wake (admin): summarise yesterday')
    expect(t).not.toMatch(/[[\]<>]/)
  })
  it('a job wake keeps its slug for the model (final review M1: split on the first colon only)', () => {
    expect(eventModelText(wakeOrigin('job:morning-brief'), 'brief me')).toBe('Background wake (job:morning-brief): brief me')
  })
  it('renders a review event', () => {
    expect(eventModelText('review:approved', 'Approved: edit_task — moved to done')).toBe('Note (review approved): Approved: edit_task — moved to done')
  })
  it('rowToAgentMessage maps an event row to a user-role message', () => {
    const m = rowToAgentMessage({ role: 'event', content: 'check the queue', toolCalls: null, attachments: null, origin: 'wake:admin' })
    expect(m).toEqual({ role: 'user', content: 'Background wake (admin): check the queue' })
  })
})
