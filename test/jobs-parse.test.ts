import { describe, it, expect } from 'vitest'
import { parseJob } from '../server/lib/agent/jobs/parse'
const md = (fm: string, body = 'Do the thing.') => `---\n${fm}\n---\n${body}\n`
const p = (fm: string, body?: string) => parseJob(md(fm, body), { defaultTimezone: 'America/New_York' })

describe('parseJob', () => {
  it('parses a full cron job', () => {
    const r = p('trigger: cron 30 7 * * 1-5\ntimezone: Europe/London\nactive_hours: 07:00-23:00\nthread: main\ncontext: light\ndeliver: [app]\nenabled: true')
    expect(r).toEqual({ ok: true, spec: expect.objectContaining({ trigger: { kind: 'cron', expr: '30 7 * * 1-5' }, timezone: 'Europe/London', activeHours: { start: '07:00', end: '23:00' }, enabled: true, deliver: ['app'], body: 'Do the thing.' }) })
  })
  it('applies defaults', () => {
    const r = p('trigger: every 30m')
    expect(r.ok && r.spec).toMatchObject({ timezone: 'America/New_York', model: 'default', thread: 'main', context: 'full', deliver: ['app'], enabled: false, activeHours: null, filter: null })
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
})
