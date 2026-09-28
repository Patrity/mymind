import { describe, it, expect } from 'vitest'
import { parseJob } from '../server/lib/agent/jobs/parse'
import { nextRunAt, nextFireTimes, describeTrigger, inActiveHours } from '../server/lib/agent/jobs/schedule'
const spec = (fm: string) => { const r = parseJob(`---\n${fm}\n---\nx\n`, { defaultTimezone: 'America/New_York' }); if (!r.ok) throw new Error(r.error); return r.spec }

describe('schedule', () => {
  it('weekday cron in a timezone', () => {
    const s = spec('trigger: cron 30 7 * * 1-5')
    // Fri 2026-10-02 12:00Z → next is Mon 2026-10-05 07:30 EDT = 11:30Z
    expect(nextRunAt(s, new Date('2026-10-02T12:00:00Z'))?.toISOString()).toBe('2026-10-05T11:30:00.000Z')
    expect(describeTrigger(s)).toBe('weekdays at 7:30')
  })
  it('fires once across spring-forward (US, 2027-03-14)', () => {
    const s = spec('trigger: cron 30 7 * * *')
    const fires = nextFireTimes(s, 3, new Date('2027-03-13T12:00:00Z')).map(d => d.toISOString())
    expect(fires).toEqual(['2027-03-13T12:30:00.000Z', '2027-03-14T11:30:00.000Z', '2027-03-15T11:30:00.000Z'])
  })
  it('every interval and one-shot at', () => {
    expect(nextRunAt(spec('trigger: every 30m'), new Date('2026-10-02T12:00:00Z'))?.toISOString()).toBe('2026-10-02T12:30:00.000Z')
    expect(nextRunAt(spec('trigger: at 2026-10-02T09:00:00-04:00'), new Date('2026-10-01T00:00:00Z'))?.toISOString()).toBe('2026-10-02T13:00:00.000Z')
    expect(nextRunAt(spec('trigger: at 2026-10-02T09:00:00-04:00'), new Date('2026-10-03T00:00:00Z'))).toBeNull()
    expect(describeTrigger(spec('trigger: every 30m'))).toBe('every 30 minutes')
  })
  it('event jobs have no next run', () => {
    expect(nextRunAt(spec('trigger: event task.due'), new Date())).toBeNull()
    expect(describeTrigger(spec('trigger: event cc.session_end'))).toBe('when a Claude Code session ends')
  })
  it('active hours in the job timezone, including an overnight window', () => {
    const day = spec('trigger: every 30m\nactive_hours: 08:00-22:00')
    expect(inActiveHours(day, new Date('2026-10-02T13:00:00Z'))).toBe(true)   // 09:00 EDT
    expect(inActiveHours(day, new Date('2026-10-03T03:00:00Z'))).toBe(false)  // 23:00 EDT
    const night = spec('trigger: every 30m\nactive_hours: 22:00-06:00')
    expect(inActiveHours(night, new Date('2026-10-03T03:00:00Z'))).toBe(true)
  })
})
