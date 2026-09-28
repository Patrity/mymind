import { describe, it, expect, vi } from 'vitest'
import { parseJob } from '../server/lib/agent/jobs/parse'
import { nextRunAt, nextFireTimes, describeTrigger, inActiveHours, FIRE_TIMES_CANDIDATES_PER_RESULT } from '../server/lib/agent/jobs/schedule'
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
  it('active_hours boundary: start is inclusive, end is exclusive', () => {
    const day = spec('trigger: every 30m\nactive_hours: 08:00-22:00')
    expect(inActiveHours(day, new Date('2026-10-02T12:00:00Z'))).toBe(true)   // exactly 08:00 EDT (start, inclusive)
    expect(inActiveHours(day, new Date('2026-10-03T02:00:00Z'))).toBe(false)  // exactly 22:00 EDT (end, exclusive)
  })
  it('an offset-less at trigger is wall-clock time in the job timezone, not the process timezone', () => {
    const london = spec('trigger: at 2026-10-02T09:00:00\ntimezone: Europe/London')
    expect(nextRunAt(london, new Date('2026-10-01T00:00:00Z'))?.toISOString()).toBe('2026-10-02T08:00:00.000Z')
    const ny = spec('trigger: at 2026-10-02T09:00:00\ntimezone: America/New_York')
    expect(nextRunAt(ny, new Date('2026-10-01T00:00:00Z'))?.toISOString()).toBe('2026-10-02T13:00:00.000Z')
  })
  it('resolves an offset-less at trigger the same regardless of the server process TZ', () => {
    const originalTZ = process.env.TZ
    process.env.TZ = 'Pacific/Auckland'
    try {
      const ny = spec('trigger: at 2026-10-02T09:00:00\ntimezone: America/New_York')
      expect(nextRunAt(ny, new Date('2026-10-01T00:00:00Z'))?.toISOString()).toBe('2026-10-02T13:00:00.000Z')
    } finally {
      if (originalTZ === undefined) delete process.env.TZ
      else process.env.TZ = originalTZ
    }
  })
  it('shifts an at trigger inside a spring-forward gap to the first valid instant', () => {
    // 2027-03-14T02:00-02:59:59 America/New_York never occurs (clocks jump 02:00 EST -> 03:00 EDT).
    // 02:30 falls inside that gap; the first valid instant afterward is 03:00:00 EDT = 07:00:00Z.
    const s = spec('trigger: at 2027-03-14T02:30:00\ntimezone: America/New_York')
    expect(nextRunAt(s, new Date('2027-03-13T00:00:00Z'))?.toISOString()).toBe('2027-03-14T07:00:00.000Z')
  })
  it('takes the earlier instant for an at trigger inside a fall-back overlap', () => {
    // 2027-11-07T01:00-01:59:59 America/New_York occurs twice (clocks fall back 02:00 EDT -> 01:00 EST).
    // 01:30 occurs first as 01:30 EDT (05:30Z), then again as 01:30 EST (06:30Z); take the earlier.
    const s = spec('trigger: at 2027-11-07T01:30:00\ntimezone: America/New_York')
    expect(nextRunAt(s, new Date('2027-11-06T00:00:00Z'))?.toISOString()).toBe('2027-11-07T05:30:00.000Z')
  })
})

describe('nextFireTimes: active hours and anchor', () => {
  const iso = (ds: Date[]) => ds.map(d => d.toISOString())

  it('heartbeat-style hours skip the overnight gap (end exclusive, start inclusive)', () => {
    const hb = spec('trigger: every 30m\nactive_hours: 08:00-22:00')
    // 21:30 EDT → 22:00 (excluded) … 07:30 all skipped → 08:00 EDT = 12:00Z
    expect(iso(nextFireTimes(hb, 3, new Date('2026-10-03T01:30:00Z'))))
      .toEqual(['2026-10-03T12:00:00.000Z', '2026-10-03T12:30:00.000Z', '2026-10-03T13:00:00.000Z'])
    const hourly = spec('trigger: cron 0 * * * *\nactive_hours: 08:00-22:00')
    expect(iso(nextFireTimes(hourly, 2, new Date('2026-10-03T01:30:00Z'))))
      .toEqual(['2026-10-03T12:00:00.000Z', '2026-10-03T13:00:00.000Z'])
  })

  it('terminates with fewer than n when active hours never match', () => {
    const never = spec('trigger: every 5m\nactive_hours: 08:00-08:00')
    // Every candidate is checked with one formatToParts call; the cap bounds them at n × 2000.
    const checks = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts')
    try {
      expect(nextFireTimes(never, 5, new Date('2026-10-03T01:30:00Z'))).toEqual([])
      expect(checks.mock.calls.length).toBeLessThanOrEqual(5 * FIRE_TIMES_CANDIDATES_PER_RESULT)
    } finally {
      checks.mockRestore()
    }
  })

  it('an every job counts from a future anchor, not the request time', () => {
    const s = spec('trigger: every 30m')
    const from = new Date('2026-10-02T12:00:00Z')
    expect(iso(nextFireTimes(s, 3, from, { anchor: new Date('2026-10-02T12:07:00Z') })))
      .toEqual(['2026-10-02T12:07:00.000Z', '2026-10-02T12:37:00.000Z', '2026-10-02T13:07:00.000Z'])
    // A past (overdue) anchor falls back to from + interval.
    expect(iso(nextFireTimes(s, 1, from, { anchor: new Date('2026-10-02T11:50:00Z') })))
      .toEqual(['2026-10-02T12:30:00.000Z'])
    // Cron ignores the anchor.
    expect(iso(nextFireTimes(spec('trigger: cron 0 * * * *'), 1, from, { anchor: new Date('2026-10-02T12:07:00Z') })))
      .toEqual(['2026-10-02T13:00:00.000Z'])
  })
})
