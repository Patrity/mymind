// test/agent-timezone-route.test.ts
//
// Handler tests (DB mocked) for PUT/GET /api/settings/agent-timezone (cycle 74 final review I5):
// the setting is one global row on the shared dev DB, so the route is exercised with the store
// and timezone modules mocked; rederiveDefaultTimezone itself has a DB test in jobs-store.db.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('createError', (o: { statusCode: number, statusMessage?: string }) => Object.assign(new Error(o.statusMessage ?? 'err'), o))
vi.stubGlobal('readBody', async (e: { body?: unknown }) => e.body)

const rederiveDefaultTimezone = vi.fn(async () => 2)
vi.mock('@mymind/core/lib/agent/jobs/store', () => ({ rederiveDefaultTimezone }))

let stored: string | null = null
const setAgentTimezoneSetting = vi.fn(async (tz: string | null) => { stored = tz })
vi.mock('@mymind/core/lib/agent/jobs/timezone', () => ({
  getAgentTimezoneSetting: async () => stored,
  getDefaultTimezone: async () => stored ?? 'Etc/UTC',
  serverTimezone: () => 'Etc/UTC',
  setAgentTimezoneSetting
}))

const put = (await import('../server/api/settings/agent-timezone.put')).default as (e: unknown) => Promise<unknown>
const get = (await import('../server/api/settings/agent-timezone.get')).default as (e: unknown) => Promise<unknown>

beforeEach(() => { stored = null; rederiveDefaultTimezone.mockClear(); setAgentTimezoneSetting.mockClear() })

describe('agent timezone setting route', () => {
  it('saves an IANA zone and re-derives the jobs that follow the default', async () => {
    await expect(put({ body: { timezone: 'America/Chicago' } })).resolves.toEqual({
      timezone: 'America/Chicago', effective: 'America/Chicago', server: 'Etc/UTC', rederived: 2
    })
    expect(setAgentTimezoneSetting).toHaveBeenCalledWith('America/Chicago')
    expect(rederiveDefaultTimezone).toHaveBeenCalledTimes(1)
  })

  it('null clears the setting (back to the server zone) and still re-derives', async () => {
    stored = 'America/Chicago'
    await expect(put({ body: { timezone: null } })).resolves.toMatchObject({ timezone: null, effective: 'Etc/UTC' })
    expect(setAgentTimezoneSetting).toHaveBeenCalledWith(null)
    expect(rederiveDefaultTimezone).toHaveBeenCalledTimes(1)
  })

  it('rejects a zone Intl does not know with 400, writing nothing', async () => {
    await expect(put({ body: { timezone: 'Mars/Olympus' } })).rejects.toMatchObject({ statusCode: 400 })
    await expect(put({ body: {} })).rejects.toMatchObject({ statusCode: 400 })
    expect(setAgentTimezoneSetting).not.toHaveBeenCalled()
    expect(rederiveDefaultTimezone).not.toHaveBeenCalled()
  })

  it('GET reports the stored, effective and server zones', async () => {
    await expect(get({})).resolves.toEqual({ timezone: null, effective: 'Etc/UTC', server: 'Etc/UTC' })
  })
})
