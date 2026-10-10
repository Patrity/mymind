import { describe, it, expect } from 'vitest'
import { parseJob } from '@mymind/core/lib/agent/jobs/parse'
const md = (fm: string, body = 'Do the thing.') => `---\n${fm}\n---\n${body}\n`
const p = (fm: string, body?: string) => parseJob(md(fm, body), { defaultTimezone: 'America/New_York' })

describe('parseJob', () => {
  it('parses a full cron job', () => {
    const r = p('trigger: cron 30 7 * * 1-5\ntimezone: Europe/London\nactive_hours: 07:00-23:00\nthread: main\ncontext: light\ndeliver: [app]\nenabled: true')
    expect(r).toEqual({ ok: true, spec: expect.objectContaining({ trigger: { kind: 'cron', expr: '30 7 * * 1-5' }, timezone: 'Europe/London', activeHours: { start: '07:00', end: '23:00' }, enabled: true, deliver: ['app'], body: 'Do the thing.' }) })
  })
  it('applies defaults', () => {
    const r = p('trigger: every 30m')
    expect(r.ok && r.spec).toMatchObject({ timezone: 'America/New_York', model: 'default', thread: 'main', context: 'full', deliver: ['auto'], enabled: false, activeHours: null, filter: null })
  })
  it.each([
    ['trigger: every 4m', /at least 5 minutes/],
    ['trigger: cron */2 * * * *', /at least 5 minutes/],
    ['trigger: cron not a cron', /invalid cron/],
    ['trigger: sometimes', /unknown trigger/],
    ['trigger: every 30m\ntimezone: Mars/Base', /timezone/],
    ['trigger: every 30m\nactive_hours: 7-23', /active_hours/],
    ['trigger: every 30m\nthread: elsewhere', /thread/],
    ['trigger: every 30m\nbogus: 1', /unknown key/],
    ['trigger: at not-a-date', /at/],
    ['trigger: event cc.nope', /unknown event/]
  ])('rejects %s', (fm, err) => {
    const r = p(fm)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(err)
  })
  it('defaults deliver to [auto] (cycle 75 ruling 3)', () => {
    const r = p('trigger: every 30m')
    expect(r.ok && r.spec.deliver).toEqual(['auto'])
  })
  it('accepts every known deliver value', () => {
    const r = p('trigger: every 30m\ndeliver: [app, auto, imessage, email]')
    expect(r.ok && r.spec.deliver).toEqual(['app', 'auto', 'imessage', 'email'])
  })
  it('rejects an unknown deliver value, naming it and the allowed set', () => {
    const r = p('trigger: every 30m\ndeliver: [app, sms]')
    expect(r).toEqual({ ok: false, error: 'invalid deliver: sms (allowed: app, auto, imessage, email)' })
  })
  it('rejects an empty deliver list', () => {
    const r = p('trigger: every 30m\ndeliver: []')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/deliver/)
  })
  it('rejects an empty body and a missing frontmatter block', () => {
    expect(p('trigger: every 30m', '   ').ok).toBe(false)
    expect(parseJob('no frontmatter', { defaultTimezone: 'UTC' }).ok).toBe(false)
  })
  it('rejects an unknown model when a resolver is given', () => {
    const r = parseJob(md('trigger: every 30m\nmodel: nope'), { defaultTimezone: 'UTC', isKnownModel: id => id === 'qwen' })
    expect(r.ok).toBe(false)
  })
  it('accepts event triggers with a filter', () => {
    const r = p('trigger: event cc.session_end\nfilter: { project: mymind }')
    expect(r.ok && r.spec.filter).toEqual({ project: 'mymind' })
  })
  it('coerces scalar filter values to strings and rejects nested ones', () => {
    const r = p('trigger: event cc.session_end\nfilter: { count: 3, active: true }')
    expect(r.ok && r.spec.filter).toEqual({ count: '3', active: 'true' })
    const nested = p('trigger: event cc.session_end\nfilter: { nested: { a: 1 } }')
    expect(nested.ok).toBe(false)
  })
  it('rejects a cron pattern whose minimum gap across an 8-day window is under 5 minutes, regardless of wall-clock "now"', () => {
    // 0,3 * * * * fires at :00 and :03 every hour -> a 3-minute gap, however parseJob is called.
    expect(p('trigger: cron 0,3 * * * *').ok).toBe(false)
  })
  it('does not reject a cron pattern whose density only looks suspicious (duplicate list value collapses to one occurrence)', () => {
    // "9,9" is a duplicate hour value -> semantically identical to "9" -> fires once daily, no violation.
    const r = p('trigger: cron 0 9,9 * * *')
    expect(r.ok).toBe(true)
  })
  it('accepts a normal weekday cron (5-day-apart minimum well over 5 minutes)', () => {
    expect(p('trigger: cron 30 7 * * 1-5').ok).toBe(true)
  })

  describe('toolsets key', () => {
    const base = '---\ntrigger: every 1h\n'
    it('defaults to []', () => {
      const r = parseJob(`${base}---\nbody`, { defaultTimezone: 'UTC' })
      expect(r.ok && r.spec.toolsets).toEqual([])
    })
    it('accepts on-demand ids', () => {
      const r = parseJob(`${base}toolsets: [images, jobs]\n---\nbody`, { defaultTimezone: 'UTC' })
      expect(r.ok && r.spec.toolsets).toEqual(['images', 'jobs'])
    })
    it('rejects unknown or core ids with the allowed list', () => {
      const r = parseJob(`${base}toolsets: [nopeset]\n---\nbody`, { defaultTimezone: 'UTC' })
      expect(r).toMatchObject({ ok: false })
      expect(!r.ok && r.error).toMatch(/invalid toolsets: nopeset \(allowed: history, projects/)
      expect(parseJob(`${base}toolsets: [memory]\n---\nbody`, { defaultTimezone: 'UTC' }).ok).toBe(false)
    })
  })
})
