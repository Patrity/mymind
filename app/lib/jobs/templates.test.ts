import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseJob } from '../../../server/lib/agent/jobs/parse'
import { JOB_SLUG_RE, JOB_TEMPLATES, jobTemplate } from './templates'

describe('job templates', () => {
  it('offers morning brief, heartbeat, event digest and blank', () => {
    expect(JOB_TEMPLATES.map(t => t.id)).toEqual(['morning-brief', 'heartbeat', 'event-digest', 'blank'])
  })

  it.each(JOB_TEMPLATES.map(t => [t.id, t] as const))('%s parses with the real server parser and starts disabled', (_id, t) => {
    const r = parseJob(t.content, { defaultTimezone: 'America/New_York' })
    if (!r.ok) throw new Error(`${t.id}: ${r.error}`)
    expect(r.spec.enabled).toBe(false)
  })

  it('pins the trigger each template promises', () => {
    const kind = (id: Parameters<typeof jobTemplate>[0]) => {
      const r = parseJob(jobTemplate(id).content, { defaultTimezone: 'UTC' })
      return r.ok ? `${r.spec.trigger.kind} ${r.spec.trigger.expr}` : r.error
    }
    expect(kind('heartbeat')).toBe('every 30m')
    expect(kind('event-digest')).toBe('event cc.session_end')
    expect(kind('morning-brief')).toBe('cron 30 7 * * 1-5')
  })

  it('JOB_SLUG_RE is the same pattern the server enforces', () => {
    const src = readFileSync(new URL('../../../server/lib/agent/jobs/store.ts', import.meta.url), 'utf8')
    const m = /export const JOB_SLUG_RE = (\/.+\/)\s*$/m.exec(src)
    expect(m?.[1]).toBe(String(JOB_SLUG_RE))
  })
})
