// server/lib/agent/tools/calendar.test.ts
// The calendar toolset (cycle 79, Task 5). Never touches the network or Google: every HTTP call
// goes through calendarDeps.google.fetch (a fakeFetch keyed by `METHOD path`), listConnections is
// mocked to two connections, getDefaultTimezone is America/Chicago, and the token seam returns
// `t-<label>` so a route can tell WHICH account's credentials a call carried.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../google/connections', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../google/connections')>()
  return {
    ...real,
    listConnections: vi.fn(),
    touchConnection: vi.fn(async () => {}),
    markReconnect: vi.fn(async () => {})
  }
})
vi.mock('../../observability/record', () => ({
  withSpan: vi.fn(async (_input: unknown, fn: () => Promise<unknown>) => fn()),
  recordEvent: vi.fn()
}))
vi.mock('../jobs/timezone', () => ({
  getDefaultTimezone: vi.fn(async () => 'America/Chicago'),
  serverTimezone: () => 'UTC'
}))

import {
  calendarTools, calendarDeps, calendarGuestEventTool, calendarRsvpTool, calendarDangerousTools, _resetCalendarPins
} from './calendar'
import { buildAiTools } from '../ai-tools'
import { agentTools } from '../tools'
import { bridgetProfile } from '../profile'
import { UNTRUSTED_NOTE } from '../../google/untrusted'
import { listConnections, type Connection } from '../../google/connections'
import { GoogleReconnectError } from '../../google/token'
import { fakeFetch, type FakeFetchRequest, type FakeFetchResponse } from '../../google/fake-fetch'
import { parseAgentTime } from '../../google/time'
import type { AgentTool } from '../types'

function conn(overrides: Partial<Connection>): Connection {
  return {
    id: 'conn-x', accountId: 'acc-x', userId: 'user-1', googleSub: 'sub-x', provider: 'google',
    label: 'x', email: 'x@x.com', status: 'ok', lastError: null, ...overrides
  }
}
const work = conn({ id: 'conn-work', label: 'work', email: 'tony@work.com' })
const personal = conn({ id: 'conn-personal', label: 'personal', email: 'tony@costanzoclan.com' })

const C = '/calendar/v3'
const calPath = (id: string) => `${C}/calendars/${encodeURIComponent(id)}`
type Route = (req: FakeFetchRequest) => FakeFetchResponse

function useRoutes(routes: Record<string, Route>) {
  const fetch = fakeFetch(routes)
  calendarDeps.google = {
    fetch,
    token: async c => `t-${c.label}`,
    refresh: async (c) => { throw new GoogleReconnectError(c, 'revoked') },
    sleep: async () => {}
  }
  return fetch
}
const acct = (req: FakeFetchRequest) => (req.headers.get('authorization') ?? '').replace('Bearer t-', '')

const tool = (name: string) => {
  const t = calendarTools.find(x => x.name === name)
  if (!t) throw new Error(`no tool ${name}`)
  return t
}
const run = (name: string, args: Record<string, unknown>) =>
  tool(name).handler(args, { signal: new AbortController().signal })
const errOf = (out: { result: unknown }) => (out.result as { error?: string }).error

beforeEach(() => {
  vi.mocked(listConnections).mockReset()
  vi.mocked(listConnections).mockResolvedValue([work, personal])
  _resetCalendarPins()
})

describe('calendar toolset registry', () => {
  it('calendarTools holds exactly the three non-dangerous tools, all in the calendar toolset', () => {
    expect(calendarTools.map(t => t.name).sort()).toEqual(['calendar_find_free_time', 'calendar_list_events', 'calendar_write_event'])
    for (const t of calendarTools) {
      expect(t.toolset, t.name).toBe('calendar')
      expect(t.dangerous, t.name).toBeFalsy()
    }
  })
  it('guest_event and rsvp are dangerous, NOT allowlistable, live on bridgetProfile and never in agentTools', () => {
    expect(calendarDangerousTools.map(t => t.name).sort()).toEqual(['calendar_guest_event', 'calendar_rsvp'])
    for (const t of calendarDangerousTools) {
      expect(t.dangerous, t.name).toBe(true)
      expect(t.allowlistable, t.name).toBeFalsy()
      expect(t.toolset, t.name).toBe('calendar')
      expect(agentTools.find(x => x.name === t.name), t.name).toBeUndefined()
      expect(bridgetProfile.tools.find(x => x.name === t.name), t.name).toBe(t)
    }
  })
  it('calendar_write_event has no attendees in its schema', () => {
    expect(Object.keys(tool('calendar_write_event').schema)).not.toContain('attendees')
  })
})

// ------------------------------------------------------------------------------------------------
describe('calendar_list_events', () => {
  it('merges every account\'s SELECTED calendars, sorted by start, in agent tz, with the note', async () => {
    const fetch = useRoutes({
      [`GET ${C}/users/me/calendarList`]: req => acct(req) === 'work'
        ? { json: { items: [{ id: 'tony@work.com', primary: true }, { id: 'team@group.calendar.google.com', selected: false }] } }
        : { json: { items: [{ id: 'tony@costanzoclan.com', selected: true }] } },
      [`GET ${calPath('tony@work.com')}/events`]: (req) => {
        expect(req.url.searchParams.get('singleEvents')).toBe('true')
        expect(req.url.searchParams.get('orderBy')).toBe('startTime')
        expect(req.url.searchParams.get('maxResults')).toBe('100')
        return {
          json: {
            items: [
              {
                id: 'w-dec', summary: 'Winter sync', start: { dateTime: '2026-12-01T16:00:00Z' }, end: { dateTime: '2026-12-01T17:00:00Z' },
                organizer: { email: 'tony@work.com', self: true }
              },
              {
                id: 'w-oct', summary: 'Standup', start: { dateTime: '2026-10-08T15:00:00Z' }, end: { dateTime: '2026-10-08T15:30:00Z' },
                location: 'Room 1', hangoutLink: 'https://meet.google.com/abc', description: 'x'.repeat(1500),
                organizer: { email: 'boss@work.com', displayName: 'Boss' },
                attendees: [
                  { email: 'boss@work.com', responseStatus: 'accepted', organizer: true },
                  { email: 'tony@work.com', responseStatus: 'tentative', self: true }
                ]
              }
            ]
          }
        }
      },
      [`GET ${calPath('tony@costanzoclan.com')}/events`]: () => ({
        json: {
          items: [
            { id: 'p-day', summary: 'Trip', start: { date: '2026-10-09' }, end: { date: '2026-10-11' } },
            { id: 'p-early', summary: 'Gym', start: { dateTime: '2026-10-08T14:00:00Z' }, end: { dateTime: '2026-10-08T15:00:00Z' } },
            { id: 'p-gone', status: 'cancelled', start: { dateTime: '2026-10-08T14:00:00Z' }, end: { dateTime: '2026-10-08T15:00:00Z' } }
          ]
        }
      })
    })
    const out = await run('calendar_list_events', { from: '2026-10-08T00:00', to: '2026-12-31T00:00' })
    const r = out.result as { events: Array<Record<string, unknown>>, note: string, warnings?: string[] }
    expect(r.events.map(e => [e.eventId, e.account])).toEqual([
      ['p-early', 'personal'], ['w-oct', 'work'], ['p-day', 'personal'], ['w-dec', 'work']
    ])
    expect(r.note).toBe(UNTRUSTED_NOTE)
    expect(r.warnings).toBeUndefined()
    // the unselected calendar is never fetched
    expect(fetch.calls).not.toContain(`GET ${calPath('team@group.calendar.google.com')}/events`)
    const standup = r.events[1]!
    expect(standup.start).toContain('2026-10-08T10:00:00-05:00') // CDT
    expect(standup.end).toContain('2026-10-08T10:30:00-05:00')
    expect(standup).toMatchObject({
      calendarId: 'tony@work.com', title: 'Standup', allDay: false, location: 'Room 1', meetLink: 'https://meet.google.com/abc',
      organizer: 'Boss <boss@work.com>', myResponse: 'tentative',
      attendees: [{ email: 'boss@work.com', response: 'accepted' }, { email: 'tony@work.com', response: 'tentative' }]
    })
    expect((standup.description as string).length).toBeLessThanOrEqual(1000 + 20)
    expect(standup.description as string).toMatch(/truncated/)
    expect(r.events[3]!.start).toContain('2026-12-01T10:00:00-06:00') // CST
    // all-day: dates, end shown INCLUSIVE (Google's exclusive 10-11 → 10-10)
    expect(r.events[2]).toMatchObject({ allDay: true, start: '2026-10-09', end: '2026-10-10' })
  })

  it('a naive from/to is agent-tz wall clock: 14:00 Chicago (CDT) → 19:00Z', async () => {
    let seen: URLSearchParams | undefined
    useRoutes({
      [`GET ${C}/users/me/calendarList`]: () => ({ json: { items: [{ id: 'primary' }] } }),
      [`GET ${calPath('primary')}/events`]: (req) => { seen = req.url.searchParams; return { json: { items: [] } } }
    })
    vi.mocked(listConnections).mockResolvedValue([work])
    const out = await run('calendar_list_events', { from: '2026-10-08T14:00', to: '2026-10-08T18:30', query: 'lunch' })
    expect(errOf(out)).toBeUndefined()
    expect(seen!.get('timeMin')).toBe('2026-10-08T19:00:00.000Z')
    expect(seen!.get('timeMax')).toBe('2026-10-08T23:30:00.000Z')
    expect(seen!.get('q')).toBe('lunch')
  })

  it('an offset-bearing input is taken as given; a bad one is an error, never a throw', async () => {
    let seen: URLSearchParams | undefined
    useRoutes({
      [`GET ${C}/users/me/calendarList`]: () => ({ json: { items: [{ id: 'primary' }] } }),
      [`GET ${calPath('primary')}/events`]: (req) => { seen = req.url.searchParams; return { json: { items: [] } } }
    })
    vi.mocked(listConnections).mockResolvedValue([work])
    await run('calendar_list_events', { from: '2026-10-08T14:00:00Z', to: '2026-10-09T00:00:00+02:00' })
    expect(seen!.get('timeMin')).toBe('2026-10-08T14:00:00.000Z')
    expect(seen!.get('timeMax')).toBe('2026-10-08T22:00:00.000Z')
    expect(errOf(await run('calendar_list_events', { from: 'next tuesday', to: '2026-10-09' }))).toMatch(/from/)
    expect(errOf(await run('calendar_list_events', { from: '2026-10-09', to: '2026-10-08' }))).toMatch(/after/)
  })

  it('I2: "2026-10-08 14:00" (space, not T) is agent-tz wall clock even when the SERVER zone is UTC; non-ISO input is rejected', async () => {
    const prevTz = process.env.TZ
    process.env.TZ = 'UTC' // prod's zone — the old Date.parse fallback read this string as 14:00Z
    try {
      let seen: URLSearchParams | undefined
      useRoutes({
        [`GET ${C}/users/me/calendarList`]: () => ({ json: { items: [{ id: 'primary' }] } }),
        [`GET ${calPath('primary')}/events`]: (req) => { seen = req.url.searchParams; return { json: { items: [] } } }
      })
      vi.mocked(listConnections).mockResolvedValue([work])
      expect(errOf(await run('calendar_list_events', { from: '2026-10-08 14:00', to: '2026-10-08 15:30:00' }))).toBeUndefined()
      expect(seen!.get('timeMin')).toBe('2026-10-08T19:00:00.000Z')
      expect(seen!.get('timeMax')).toBe('2026-10-08T20:30:00.000Z')
      expect(parseAgentTime('2026-10-08 14:00', 'America/Chicago')!.toISOString()).toBe('2026-10-08T19:00:00.000Z')
      expect(parseAgentTime('2026-10-08', 'America/Chicago')!.toISOString()).toBe('2026-10-08T05:00:00.000Z')
      for (const bad of ['Oct 8, 2026 2:00 PM', 'next tuesday', '2026/10/08 14:00', '10/08/2026', '2026-02-30', '2026-10-08T25:00', '']) {
        expect(parseAgentTime(bad, 'America/Chicago'), bad).toBeNull()
      }
      expect(errOf(await run('calendar_list_events', { from: 'Oct 8, 2026 2:00 PM', to: '2026-10-09' }))).toBe('from: unrecognized time — use ISO like 2026-10-08T14:00')
    } finally {
      if (prevTz === undefined) delete process.env.TZ
      else process.env.TZ = prevTz
    }
  })

  it('m4: a calendar with more than 100 events in the window → truncated: true and a warning', async () => {
    vi.mocked(listConnections).mockResolvedValue([work])
    useRoutes({
      [`GET ${C}/users/me/calendarList`]: () => ({ json: { items: [{ id: 'primary' }] } }),
      [`GET ${calPath('primary')}/events`]: () => ({ json: { items: [{ id: 'a', start: { dateTime: '2026-10-08T14:00:00Z' }, end: { dateTime: '2026-10-08T15:00:00Z' } }], nextPageToken: 'more' } })
    })
    const r = (await run('calendar_list_events', { from: '2026-10-08', to: '2026-10-09' })).result as { truncated?: boolean, warnings?: string[] }
    expect(r.truncated).toBe(true)
    expect(r.warnings?.[0]).toMatch(/work: calendar primary has more than 100 events/)
  })

  it('one account failing is a warning, not a failure', async () => {
    useRoutes({
      [`GET ${C}/users/me/calendarList`]: req => acct(req) === 'work' ? { status: 404, json: { error: { message: 'nope' } } } : { json: { items: [{ id: 'primary' }] } },
      [`GET ${calPath('primary')}/events`]: () => ({ json: { items: [{ id: 'p1', summary: 'A', start: { dateTime: '2026-10-08T14:00:00Z' }, end: { dateTime: '2026-10-08T15:00:00Z' } }] } })
    })
    const out = await run('calendar_list_events', { from: '2026-10-08', to: '2026-10-09' })
    const r = out.result as { events: unknown[], warnings: string[] }
    expect(r.events).toHaveLength(1)
    expect(r.warnings[0]).toMatch(/^work: /)
  })
})

// ------------------------------------------------------------------------------------------------
describe('calendar_find_free_time', () => {
  it('busy 10–11 (work) and 13–14 (personal) within 09–17 → hour slots around them, never outside working hours', async () => {
    const bodies: Array<{ account: string, body: unknown }> = []
    useRoutes({
      [`GET ${C}/users/me/calendarList`]: req => acct(req) === 'work'
        ? { json: { items: [{ id: 'tony@work.com' }, { id: 'off@x', selected: false }] } }
        : { json: { items: [{ id: 'tony@costanzoclan.com' }] } },
      [`POST ${C}/freeBusy`]: (req) => {
        bodies.push({ account: acct(req), body: req.body })
        return acct(req) === 'work'
          ? { json: { calendars: { 'tony@work.com': { busy: [{ start: '2026-10-08T15:00:00Z', end: '2026-10-08T16:00:00Z' }] } } } }
          : { json: { calendars: { 'tony@costanzoclan.com': { busy: [{ start: '2026-10-08T18:00:00Z', end: '2026-10-08T19:00:00Z' }] } } } }
      }
    })
    const out = await run('calendar_find_free_time', { from: '2026-10-08T00:00', to: '2026-10-09T00:00', durationMinutes: 60 })
    const r = out.result as { slots: Array<{ start: string, end: string }> }
    const hhmm = (s: string) => s.slice(11, 16)
    expect(r.slots.map(s => `${hhmm(s.start)}-${hhmm(s.end)}`)).toEqual(['09:00-10:00', '11:00-12:00', '12:00-13:00', '14:00-15:00', '15:00-16:00', '16:00-17:00'])
    for (const s of r.slots) expect(s.start).toContain('-05:00')
    const work = bodies.find(b => b.account === 'work')!.body as { timeMin: string, timeMax: string, items: { id: string }[] }
    expect(work.items).toEqual([{ id: 'tony@work.com' }])
    expect(work.timeMin).toBe('2026-10-08T05:00:00.000Z')
  })

  it('custom working hours and a weekend day both work; ≤20 slots', async () => {
    vi.mocked(listConnections).mockResolvedValue([work])
    useRoutes({
      [`GET ${C}/users/me/calendarList`]: () => ({ json: { items: [{ id: 'primary' }] } }),
      [`POST ${C}/freeBusy`]: () => ({ json: { calendars: { primary: { busy: [] } } } })
    })
    // 2026-10-10 is a Saturday; a bare-date `to` runs through the end of that day
    const out = await run('calendar_find_free_time', { from: '2026-10-10', to: '2026-10-10', durationMinutes: 30, workingHours: '08:00-09:00' })
    const r = out.result as { slots: Array<{ start: string }> }
    expect(r.slots.map(s => s.start.slice(0, 16))).toEqual(['2026-10-10T08:00', '2026-10-10T08:30'])
    const many = await run('calendar_find_free_time', { from: '2026-10-01', to: '2026-10-31', durationMinutes: 15 })
    expect((many.result as { slots: unknown[] }).slots).toHaveLength(20)
  })

  it('across the DST change (Sun 2026-11-01, CDT → CST) each day\'s 09:00 stays 09:00 local', async () => {
    vi.mocked(listConnections).mockResolvedValue([work])
    useRoutes({
      [`GET ${C}/users/me/calendarList`]: () => ({ json: { items: [{ id: 'primary' }] } }),
      [`POST ${C}/freeBusy`]: () => ({ json: { calendars: { primary: { busy: [] } } } })
    })
    const out = await run('calendar_find_free_time', { from: '2026-10-31', to: '2026-11-02', durationMinutes: 60, workingHours: '09:00-10:00' })
    const r = out.result as { slots: Array<{ start: string, end: string }> }
    expect(r.slots.map(s => s.start.slice(0, 25))).toEqual(['2026-10-31T09:00:00-05:00', '2026-11-01T09:00:00-06:00', '2026-11-02T09:00:00-06:00'])
    expect(r.slots[1]!.end.slice(0, 25)).toBe('2026-11-01T10:00:00-06:00')
  })

  it('m5: a window longer than 62 days is searched only for its first 62 days — with a warning', async () => {
    vi.mocked(listConnections).mockResolvedValue([work])
    useRoutes({
      [`GET ${C}/users/me/calendarList`]: () => ({ json: { items: [{ id: 'primary' }] } }),
      [`POST ${C}/freeBusy`]: () => ({ json: { calendars: { primary: { busy: [{ start: '2026-01-01T00:00:00Z', end: '2026-03-04T00:00:00Z' }] } } } })
    })
    const r = (await run('calendar_find_free_time', { from: '2026-01-01', to: '2026-06-30', durationMinutes: 60 })).result as { slots: unknown[], warnings?: string[] }
    expect(r.warnings).toContain('only the first 62 days were searched')
    expect(r.slots).toEqual([]) // the first 62 days are fully busy; nothing beyond them is offered
  })

  it('when no account could report busy times it errors instead of claiming everything is free', async () => {
    useRoutes({
      [`GET ${C}/users/me/calendarList`]: () => ({ status: 404, json: { error: { message: 'gone' } } })
    })
    const out = await run('calendar_find_free_time', { from: '2026-10-08', to: '2026-10-09', durationMinutes: 60 })
    expect(errOf(out)).toMatch(/could not read/)
  })

  it('rejects a malformed workingHours', async () => {
    const out = await run('calendar_find_free_time', { from: '2026-10-08', to: '2026-10-09', durationMinutes: 60, workingHours: '17:00-09:00' })
    expect(errOf(out)).toMatch(/workingHours/)
  })
})

// ------------------------------------------------------------------------------------------------
describe('calendar_write_event', () => {
  const guestEvent = {
    id: 'e-guests', etag: '"1"', summary: 'Planning', start: { dateTime: '2026-10-08T15:00:00Z' }, end: { dateTime: '2026-10-08T16:00:00Z' },
    organizer: { email: 'tony@work.com', self: true },
    attendees: [{ email: 'tony@work.com', self: true, organizer: true, responseStatus: 'accepted' }, { email: 'ann@a.com', responseStatus: 'needsAction' }]
  }
  const soloEvent = {
    id: 'e-solo', etag: '"1"', summary: 'Focus', location: 'Desk', start: { dateTime: '2026-10-08T15:00:00Z', timeZone: 'America/Chicago' }, end: { dateTime: '2026-10-08T16:00:00Z', timeZone: 'America/Chicago' },
    organizer: { email: 'tony@work.com', self: true },
    attendees: [{ email: 'tony@work.com', self: true, responseStatus: 'accepted' }]
  }

  it('update on an event with a non-self attendee → guest error and NO PATCH', async () => {
    const fetch = useRoutes({ [`GET ${calPath('primary')}/events/e-guests`]: () => ({ json: guestEvent }) })
    const out = await run('calendar_write_event', { account: 'work', op: 'update', eventId: 'e-guests', title: 'New' })
    expect(errOf(out)).toBe('this event has guests — use calendar_guest_event')
    expect(fetch.calls).toEqual([`GET ${calPath('primary')}/events/e-guests`])
  })

  it('delete on an event with a non-self attendee → guest error and NO DELETE', async () => {
    const fetch = useRoutes({ [`GET ${calPath('primary')}/events/e-guests`]: () => ({ json: guestEvent }) })
    const out = await run('calendar_write_event', { account: 'work', op: 'delete', eventId: 'e-guests' })
    expect(errOf(out)).toBe('this event has guests — use calendar_guest_event')
    expect(fetch.calls).toEqual([`GET ${calPath('primary')}/events/e-guests`])
  })

  it('attendees smuggled into the input are refused before any Google call', async () => {
    const fetch = useRoutes({})
    const out = await run('calendar_write_event', { account: 'work', op: 'create', title: 'X', start: '2026-10-08T10:00', attendees: ['ann@a.com'] })
    expect(errOf(out)).toBe('this event has guests — use calendar_guest_event')
    expect(fetch.calls).toEqual([])
  })

  it('create posts sendUpdates=none with agent-tz times (naive start → Chicago); end defaults to +1h; undo DELETEs', async () => {
    let posted: { body: Record<string, unknown>, sendUpdates: string | null, account: string } | undefined
    let deleted: URLSearchParams | undefined
    const fetch = useRoutes({
      [`POST ${calPath('primary')}/events`]: (req) => {
        posted = { body: req.body as Record<string, unknown>, sendUpdates: req.url.searchParams.get('sendUpdates'), account: acct(req) }
        return { json: { id: 'new1', ...(req.body as object) } }
      },
      // undo re-checks the event first (review m3): still Tony's, still guest-free
      [`GET ${calPath('primary')}/events/new1`]: () => ({ json: { id: 'new1', organizer: { email: 'tony@costanzoclan.com', self: true } } }),
      [`DELETE ${calPath('primary')}/events/new1`]: (req) => { deleted = req.url.searchParams; return { status: 204 } }
    })
    const out = await run('calendar_write_event', { account: 'personal', op: 'create', title: 'Dentist', start: '2026-10-08T14:00', description: 'secret' })
    expect(errOf(out)).toBeUndefined()
    expect(posted!.account).toBe('personal')
    expect(posted!.sendUpdates).toBe('none')
    expect(posted!.body).toMatchObject({
      summary: 'Dentist', description: 'secret',
      start: { dateTime: '2026-10-08T14:00:00-05:00', timeZone: 'America/Chicago' },
      end: { dateTime: '2026-10-08T15:00:00-05:00', timeZone: 'America/Chicago' }
    })
    expect(posted!.body).not.toHaveProperty('attendees')
    expect(out.undo).toBeDefined()
    expect(await out.undo!()).toEqual({ ok: true })
    expect(fetch.calls).toContain(`DELETE ${calPath('primary')}/events/new1`)
    expect(deleted!.get('sendUpdates')).toBe('none')
  })

  it('all-day create: inclusive end date becomes Google\'s exclusive end', async () => {
    let body: Record<string, unknown> | undefined
    useRoutes({ [`POST ${calPath('primary')}/events`]: (req) => { body = req.body as Record<string, unknown>; return { json: { id: 'd1' } } } })
    await run('calendar_write_event', { account: 'work', op: 'create', title: 'Off', start: '2026-10-09', end: '2026-10-10', allDay: true })
    expect(body).toMatchObject({ start: { date: '2026-10-09' }, end: { date: '2026-10-11' } })
  })

  it('update of a solo event PATCHes sendUpdates=none; undo PATCHes the prior fields back', async () => {
    const patches: Array<{ body: Record<string, unknown>, sendUpdates: string | null }> = []
    useRoutes({
      [`GET ${calPath('primary')}/events/e-solo`]: () => ({ json: soloEvent }),
      [`PATCH ${calPath('primary')}/events/e-solo`]: (req) => {
        patches.push({ body: req.body as Record<string, unknown>, sendUpdates: req.url.searchParams.get('sendUpdates') })
        return { json: { ...soloEvent, ...(req.body as object) } }
      }
    })
    const out = await run('calendar_write_event', { account: 'work', op: 'update', eventId: 'e-solo', title: 'Deep work', start: '2026-10-08T11:00', end: '2026-10-08T12:00' })
    expect(errOf(out)).toBeUndefined()
    expect(patches[0]!.sendUpdates).toBe('none')
    expect(patches[0]!.body).toMatchObject({ summary: 'Deep work', start: { dateTime: '2026-10-08T11:00:00-05:00', date: null } })
    expect(patches[0]!.body).not.toHaveProperty('location')
    await out.undo!()
    expect(patches[1]!.sendUpdates).toBe('none')
    expect(patches[1]!.body).toEqual({
      summary: 'Focus',
      start: { dateTime: '2026-10-08T15:00:00Z', timeZone: 'America/Chicago', date: null },
      end: { dateTime: '2026-10-08T16:00:00Z', timeZone: 'America/Chicago', date: null }
    })
  })

  it('delete of a solo event DELETEs sendUpdates=none; undo re-creates it from the fetched event', async () => {
    let recreated: Record<string, unknown> | undefined
    const fetch = useRoutes({
      [`GET ${calPath('primary')}/events/e-solo`]: () => ({ json: soloEvent }),
      [`DELETE ${calPath('primary')}/events/e-solo`]: (req) => { expect(req.url.searchParams.get('sendUpdates')).toBe('none'); return { status: 204 } },
      [`POST ${calPath('primary')}/events`]: (req) => { recreated = req.body as Record<string, unknown>; return { json: { id: 'e-solo-2' } } }
    })
    const out = await run('calendar_write_event', { account: 'work', op: 'delete', eventId: 'e-solo' })
    expect(errOf(out)).toBeUndefined()
    expect(fetch.calls).toContain(`DELETE ${calPath('primary')}/events/e-solo`)
    await out.undo!()
    expect(recreated).toMatchObject({ summary: 'Focus', location: 'Desk', start: soloEvent.start, end: soloEvent.end })
    expect(recreated).not.toHaveProperty('id')
    expect(recreated).not.toHaveProperty('etag')
  })

  it('needs a named account and an eventId for update/delete', async () => {
    useRoutes({})
    expect(errOf(await run('calendar_write_event', { op: 'create', title: 'x', start: '2026-10-08T10:00' }))).toBe('name an account: work, personal')
    expect(errOf(await run('calendar_write_event', { account: 'work', op: 'delete' }))).toMatch(/eventId/)
  })

  it('I1: an invite Tony did NOT organize (only his own attendee entry visible) → refused, no PATCH/DELETE', async () => {
    const invite = {
      id: 'e-inv', etag: '"1"', summary: 'Their meeting', start: { dateTime: '2026-10-08T15:00:00Z' }, end: { dateTime: '2026-10-08T16:00:00Z' },
      organizer: { email: 'boss@work.com', self: false },
      attendees: [{ email: 'tony@work.com', self: true, responseStatus: 'accepted' }]
    }
    const fetch = useRoutes({ [`GET ${calPath('primary')}/events/e-inv`]: () => ({ json: invite }) })
    for (const op of ['delete', 'update'] as const) {
      const out = await run('calendar_write_event', { account: 'work', op, eventId: 'e-inv', title: 'Mine now' })
      expect(errOf(out)).toBe('you\'re not the organizer of this event — use calendar_rsvp to decline')
    }
    expect(fetch.calls).toEqual([`GET ${calPath('primary')}/events/e-inv`, `GET ${calPath('primary')}/events/e-inv`])
  })

  it('I1: attendeesOmitted (Google withheld the guest list) → refused as a guest event, no PATCH/DELETE', async () => {
    const omitted = { ...soloEvent, id: 'e-omit', attendees: [], attendeesOmitted: true }
    const fetch = useRoutes({ [`GET ${calPath('primary')}/events/e-omit`]: () => ({ json: omitted }) })
    for (const op of ['delete', 'update'] as const) {
      expect(errOf(await run('calendar_write_event', { account: 'work', op, eventId: 'e-omit', title: 'x' }))).toBe('this event has guests — use calendar_guest_event')
    }
    expect(fetch.calls.every(c => c.startsWith('GET'))).toBe(true)
  })

  it('m3: undo re-checks — if guests were added since, it refuses and does not PATCH', async () => {
    let withGuests = false
    const patches: unknown[] = []
    useRoutes({
      [`GET ${calPath('primary')}/events/e-solo`]: () => ({ json: withGuests ? { ...soloEvent, attendees: [...soloEvent.attendees, { email: 'ann@a.com' }] } : soloEvent }),
      [`PATCH ${calPath('primary')}/events/e-solo`]: (req) => { patches.push(req.body); return { json: soloEvent } }
    })
    const out = await run('calendar_write_event', { account: 'work', op: 'update', eventId: 'e-solo', title: 'Deep work' })
    expect(patches).toHaveLength(1)
    withGuests = true
    expect(await out.undo!()).toEqual({ ok: false, reason: 'not reverted — the event now has guests' })
    expect(patches).toHaveLength(1)
  })

  it('m8: an update passing only allDay is an explicit error, not silently ignored', async () => {
    const fetch = useRoutes({ [`GET ${calPath('primary')}/events/e-solo`]: () => ({ json: soloEvent }) })
    const out = await run('calendar_write_event', { account: 'work', op: 'update', eventId: 'e-solo', allDay: true })
    expect(errOf(out)).toBe('to make it all-day, also pass start (a date) and optionally end')
    expect(fetch.calls.filter(c => c.startsWith('PATCH'))).toEqual([])
  })

  it('I2: a non-ISO start is rejected — nothing is posted', async () => {
    const fetch = useRoutes({})
    const out = await run('calendar_write_event', { account: 'work', op: 'create', title: 'X', start: 'Oct 8, 2026 2:00 PM' })
    expect(errOf(out)).toBe('start: unrecognized time — use ISO like 2026-10-08T14:00')
    expect(fetch.calls).toEqual([])
  })

  it('redactForLog masks description', async () => {
    const masked = await tool('calendar_write_event').redactForLog!({ account: 'work', op: 'create', description: 'hello there' })
    expect(masked.description).toBe('<11 chars>')
  })
})

// ------------------------------------------------------------------------------------------------
describe('calendar_guest_event', () => {
  const T = calendarGuestEventTool
  const describe_ = (args: Record<string, unknown>, nonce = 'n-1') => T.describeApproval!(args, { approvalNonce: nonce })
  const run_ = (args: Record<string, unknown>, nonce = 'n-1') => T.handler(args, { signal: new AbortController().signal, approvalNonce: nonce })
  const existing = (etag: string) => ({
    id: 'g1', etag, summary: 'Planning', location: 'Room 2', start: { dateTime: '2026-10-08T15:00:00Z' }, end: { dateTime: '2026-10-08T16:00:00Z' },
    organizer: { email: 'tony@work.com', self: true },
    attendees: [{ email: 'tony@work.com', self: true, organizer: true, responseStatus: 'accepted' }, { email: 'ann@a.com', responseStatus: 'accepted' }]
  })

  it('create: card lists the guests and time (agent tz), POST uses sendUpdates=all with attendees; no undo', async () => {
    let posted: { body: Record<string, unknown>, sendUpdates: string | null } | undefined
    useRoutes({
      [`POST ${calPath('primary')}/events`]: (req) => { posted = { body: req.body as Record<string, unknown>, sendUpdates: req.url.searchParams.get('sendUpdates') }; return { json: { id: 'g-new', htmlLink: 'https://cal/x' } } }
    })
    const args = { account: 'work', op: 'create', title: 'Lunch', start: '2026-10-08T12:00', end: '2026-10-08T13:00', attendees: ['ann@a.com', 'bo@b.com'], description: 'private agenda' }
    const req = await describe_(args)
    expect(req.title).toBe('Invite guests?')
    expect(req.command).toContain('ann@a.com')
    expect(req.command).toContain('bo@b.com')
    expect(req.command).toContain('Lunch')
    expect(req.command).toMatch(/Thu, Oct 8, 12:00 PM/)
    expect(req.logSummary).toBeDefined()
    expect(req.logSummary).not.toContain('private agenda')
    expect(req.logSummary).not.toContain('Lunch')
    const out = await run_(args)
    expect(errOf(out)).toBeUndefined()
    expect(posted!.sendUpdates).toBe('all')
    expect(posted!.body).toMatchObject({ summary: 'Lunch', attendees: [{ email: 'ann@a.com' }, { email: 'bo@b.com' }] })
    expect(out.undo).toBeUndefined()
  })

  it('fix wave I2: the card shows the WHOLE description that goes to guests — no 500-char cap', async () => {
    useRoutes({})
    const description = `${'d'.repeat(3000)} END-OF-DESCRIPTION`
    const req = await describe_({ account: 'work', op: 'create', title: 'Lunch', start: '2026-10-08T12:00', attendees: ['ann@a.com'], description })
    expect(req.command).toContain(`Description: ${description}`)
    expect(req.command).not.toContain('[truncated]')
  })

  it('fix wave I2: an update card shows the whole new description', async () => {
    useRoutes({ [`GET ${calPath('primary')}/events/g1`]: () => ({ json: existing('"e1"') }) })
    const description = `${'u'.repeat(2000)} END-OF-UPDATE`
    const req = await describe_({ account: 'work', op: 'update', eventId: 'g1', description })
    expect(req.command).toContain(`- Description: ${description}`)
    expect(req.command).not.toContain('[truncated]')
  })

  it('create requires at least one attendee — the card says deny, writes no pin, and nothing is posted', async () => {
    const fetch = useRoutes({})
    const args = { account: 'work', op: 'create', title: 'Lunch', start: '2026-10-08T12:00' }
    const req = await describe_(args)
    expect(req.command).toMatch(/at least one attendee.*— deny/)
    const out = await run_(args)
    expect(errOf(out)).toBe('the invite could not be shown for approval — nothing was sent')
    expect(fetch.calls).toEqual([])
  })

  it('m6: a create whose card failed to load (no pin for this nonce) sends NOTHING even if approved', async () => {
    const fetch = useRoutes({ [`POST ${calPath('primary')}/events`]: () => ({ json: { id: 'x' } }) })
    vi.mocked(listConnections).mockRejectedValueOnce(new Error('db down')) // describeApproval's lookup fails
    const args = { account: 'work', op: 'create', title: 'Lunch', start: '2026-10-08T12:00', attendees: ['ann@a.com'] }
    const req = await describe_(args)
    expect(req.command).toMatch(/could not be loaded — deny/)
    const out = await run_(args)
    expect(errOf(out)).toBe('the invite could not be shown for approval — nothing was sent')
    expect(fetch.calls).toEqual([])
  })

  it('m6: a create pin is bound to the exact planned request — different args under that nonce are refused', async () => {
    const fetch = useRoutes({ [`POST ${calPath('primary')}/events`]: () => ({ json: { id: 'x' } }) })
    await describe_({ account: 'work', op: 'create', title: 'Lunch', start: '2026-10-08T12:00', attendees: ['ann@a.com'] })
    const out = await run_({ account: 'work', op: 'create', title: 'Lunch', start: '2026-10-08T12:00', attendees: ['eve@evil.com'] })
    expect(errOf(out)).toBe('the invite differs from the one you approved — ask again')
    expect(fetch.calls).toEqual([])
  })

  it('m1: update/cancel of an event Tony did not organize is refused — card says deny, no PATCH/DELETE', async () => {
    const invite = { ...existing('"e1"'), organizer: { email: 'boss@work.com' } }
    const fetch = useRoutes({
      [`GET ${calPath('primary')}/events/g1`]: () => ({ json: invite }),
      [`PATCH ${calPath('primary')}/events/g1`]: () => ({ json: { id: 'g1' } }),
      [`DELETE ${calPath('primary')}/events/g1`]: () => ({ status: 204 })
    })
    for (const args of [{ account: 'work', op: 'cancel', eventId: 'g1' }, { account: 'work', op: 'update', eventId: 'g1', title: 'X' }]) {
      const req = await describe_(args)
      expect(req.command).toBe('you\'re not the organizer — use calendar_rsvp to decline — deny')
      expect(errOf(await run_(args))).toBe('the event could not be loaded — nothing was changed')
    }
    expect(fetch.calls.filter(c => !c.startsWith('GET'))).toEqual([])
  })

  it('update: card shows the fetched event and the change; PATCH sendUpdates=all when the etag is unchanged', async () => {
    let patched: { body: Record<string, unknown>, sendUpdates: string | null } | undefined
    useRoutes({
      [`GET ${calPath('primary')}/events/g1`]: () => ({ json: existing('"e1"') }),
      [`PATCH ${calPath('primary')}/events/g1`]: (req) => { patched = { body: req.body as Record<string, unknown>, sendUpdates: req.url.searchParams.get('sendUpdates') }; return { json: { id: 'g1' } } }
    })
    const args = { account: 'work', op: 'update', eventId: 'g1', start: '2026-10-08T14:00', end: '2026-10-08T15:00', attendees: ['ann@a.com', 'cy@c.com'] }
    const req = await describe_(args)
    expect(req.command).toContain('Planning')
    expect(req.command).toMatch(/When: .*10:00 AM.* → .*2:00 PM/)
    expect(req.command).toMatch(/added: cy@c\.com/)
    const out = await run_(args)
    expect(errOf(out)).toBeUndefined()
    expect(patched!.sendUpdates).toBe('all')
    // the self attendee is kept; ann keeps her response; cy is new
    expect(patched!.body.attendees).toEqual([
      { email: 'tony@work.com', self: true, organizer: true, responseStatus: 'accepted' },
      { email: 'ann@a.com', responseStatus: 'accepted' },
      { email: 'cy@c.com' }
    ])
  })

  it('update: the event changed after the card (etag moved) → refused, NO PATCH', async () => {
    let etag = '"e1"'
    const fetch = useRoutes({
      [`GET ${calPath('primary')}/events/g1`]: () => ({ json: existing(etag) }),
      [`PATCH ${calPath('primary')}/events/g1`]: () => ({ json: { id: 'g1' } })
    })
    const args = { account: 'work', op: 'update', eventId: 'g1', title: 'Renamed' }
    await describe_(args)
    etag = '"e2"'
    const out = await run_(args)
    expect(errOf(out)).toBe('the event changed after you approved it — ask again')
    expect(fetch.calls.filter(c => c.startsWith('PATCH'))).toEqual([])
  })

  it('update: no pin for THIS nonce (card failed to load, or a different approval) → refused with no network call', async () => {
    const fetch = useRoutes({
      [`GET ${calPath('primary')}/events/g1`]: () => ({ json: existing('"e1"') }),
      [`PATCH ${calPath('primary')}/events/g1`]: () => ({ json: { id: 'g1' } })
    })
    const args = { account: 'work', op: 'update', eventId: 'g1', title: 'Renamed' }
    await describe_(args, 'nonce-A') // pins under A
    fetch.calls.length = 0
    const out = await run_(args, 'nonce-B') // B never had a card
    expect(errOf(out)).toBe('the event could not be loaded — nothing was changed')
    expect(fetch.calls).toEqual([])
    // A's pin is one-shot: first use works, second refuses
    expect(errOf(await run_(args, 'nonce-A'))).toBeUndefined()
    expect(errOf(await run_(args, 'nonce-A'))).toBe('the event could not be loaded — nothing was changed')
  })

  it('a card whose event cannot be loaded says deny and leaves no pin', async () => {
    useRoutes({ [`GET ${calPath('primary')}/events/g404`]: () => ({ status: 404, json: { error: { message: 'Not Found' } } }) })
    const req = await describe_({ account: 'work', op: 'cancel', eventId: 'g404' })
    expect(req.command).toMatch(/could not be loaded — deny/)
    expect(errOf(await run_({ account: 'work', op: 'cancel', eventId: 'g404' }))).toBe('the event could not be loaded — nothing was changed')
  })

  it('cancel: card lists who is notified; DELETE uses sendUpdates=all', async () => {
    let del: URLSearchParams | undefined
    useRoutes({
      [`GET ${calPath('primary')}/events/g1`]: () => ({ json: existing('"e1"') }),
      [`DELETE ${calPath('primary')}/events/g1`]: (req) => { del = req.url.searchParams; return { status: 204 } }
    })
    const req = await describe_({ account: 'work', op: 'cancel', eventId: 'g1' })
    expect(req.title).toMatch(/Cancel/)
    expect(req.command).toMatch(/Notifies: ann@a\.com/)
    expect(req.command).not.toMatch(/Notifies: .*tony@work\.com/)
    const out = await run_({ account: 'work', op: 'cancel', eventId: 'g1' })
    expect(errOf(out)).toBeUndefined()
    expect(del!.get('sendUpdates')).toBe('all')
    expect(out.undo).toBeUndefined()
  })

  it('redactForLog masks description', async () => {
    expect((await T.redactForLog!({ description: 'abc' })).description).toBe('<3 chars>')
  })

  it('through buildAiTools: two executions sharing the SAME SDK toolCallId get independent pins', async () => {
    let etag = '"e1"'
    const fetch = useRoutes({
      [`GET ${calPath('primary')}/events/g1`]: () => ({ json: existing(etag) }),
      [`PATCH ${calPath('primary')}/events/g1`]: () => ({ json: { id: 'g1' } })
    })
    const approvals: Array<(d: { approved: boolean }) => void> = []
    const requestApproval = () => new Promise<{ approved: boolean }>((resolve) => { approvals.push(resolve) })
    const set = buildAiTools([T], { signal: new AbortController().signal, requestApproval, onEvent: () => {} })
    const execute = set.calendar_guest_event!.execute as (input: unknown, opts: { toolCallId: string }) => Promise<unknown>
    const pA = execute({ account: 'work', op: 'update', eventId: 'g1', title: 'A' }, { toolCallId: 'call_0' })
    await new Promise(r => setTimeout(r, 5))
    etag = '"e2"' // the event moves between A's card and B's card
    const pB = execute({ account: 'work', op: 'update', eventId: 'g1', title: 'B' }, { toolCallId: 'call_0' })
    await new Promise(r => setTimeout(r, 5))
    approvals[1]!({ approved: false })
    approvals[0]!({ approved: true })
    const [outA, outB] = await Promise.all([pA, pB])
    expect(outA).toEqual({ error: 'the event changed after you approved it — ask again' })
    expect(outB).toEqual({ denied: true })
    expect(fetch.calls.filter(c => c.startsWith('PATCH'))).toEqual([])
  })
})

// ------------------------------------------------------------------------------------------------
describe('calendar_rsvp', () => {
  const T: AgentTool = calendarRsvpTool
  const describe_ = (args: Record<string, unknown>, nonce = 'r-1') => T.describeApproval!(args, { approvalNonce: nonce })
  const run_ = (args: Record<string, unknown>, nonce = 'r-1') => T.handler(args, { signal: new AbortController().signal, approvalNonce: nonce })
  const invite = {
    id: 'inv1', etag: '"v1"', summary: 'Offsite', start: { dateTime: '2026-10-08T15:00:00Z' }, end: { dateTime: '2026-10-08T16:00:00Z' },
    organizer: { email: 'boss@work.com', displayName: 'Boss' },
    attendees: [
      { email: 'boss@work.com', organizer: true, responseStatus: 'accepted' },
      { email: 'tony@work.com', self: true, responseStatus: 'needsAction' },
      { email: 'ann@a.com', responseStatus: 'declined', comment: 'sorry' }
    ]
  }

  it('card shows title/time/organizer/response; PATCHes ONLY the self attendee\'s responseStatus (+comment), sendUpdates=all', async () => {
    let patched: { body: Record<string, unknown>, sendUpdates: string | null } | undefined
    useRoutes({
      [`GET ${calPath('tony@work.com')}/events/inv1`]: () => ({ json: invite }),
      [`PATCH ${calPath('tony@work.com')}/events/inv1`]: (req) => { patched = { body: req.body as Record<string, unknown>, sendUpdates: req.url.searchParams.get('sendUpdates') }; return { json: { id: 'inv1' } } }
    })
    const args = { account: 'work', calendarId: 'tony@work.com', eventId: 'inv1', response: 'declined', note: 'out sick' }
    const req = await describe_(args)
    expect(req.title).toBe('Send RSVP?')
    expect(req.command).toContain('Offsite')
    expect(req.command).toContain('Boss')
    expect(req.command).toMatch(/declined/)
    expect(req.command).toMatch(/Thu, Oct 8, 10:00 AM/)
    expect(req.logSummary).not.toContain('out sick')
    const out = await run_(args)
    expect(errOf(out)).toBeUndefined()
    expect(patched!.sendUpdates).toBe('all')
    expect(Object.keys(patched!.body)).toEqual(['attendees'])
    expect(patched!.body.attendees).toEqual([
      invite.attendees[0],
      { email: 'tony@work.com', self: true, responseStatus: 'declined', comment: 'out sick' },
      invite.attendees[2]
    ])
    expect(out.undo).toBeUndefined()
  })

  it('fix wave I2: the card shows the WHOLE RSVP note — no 500-char cap', async () => {
    useRoutes({ [`GET ${calPath('tony@work.com')}/events/inv1`]: () => ({ json: invite }) })
    const note = `${'n'.repeat(1200)} END-OF-NOTE`
    const req = await describe_({ account: 'work', calendarId: 'tony@work.com', eventId: 'inv1', response: 'declined', note })
    expect(req.command).toContain(`Note: ${note}`)
    expect(req.command).not.toContain('[truncated]')
  })

  it('Tony is not an attendee → error, no PATCH', async () => {
    const notInvited = { ...invite, attendees: invite.attendees.filter(a => !('self' in a)) }
    const fetch = useRoutes({ [`GET ${calPath('primary')}/events/inv1`]: () => ({ json: notInvited }) })
    const args = { account: 'work', calendarId: 'primary', eventId: 'inv1', response: 'accepted' }
    const req = await describe_(args)
    expect(req.command).toMatch(/not an attendee/)
    const out = await run_(args)
    expect(errOf(out)).toBe('you are not an attendee of this event')
    expect(fetch.calls.filter(c => c.startsWith('PATCH'))).toEqual([])
  })

  it('m2: Tony organizes the event → RSVP refused (an organizer attendees PATCH would email every guest)', async () => {
    const mine = { ...invite, organizer: { email: 'tony@work.com', self: true } }
    const fetch = useRoutes({ [`GET ${calPath('primary')}/events/inv1`]: () => ({ json: mine }), [`PATCH ${calPath('primary')}/events/inv1`]: () => ({ json: {} }) })
    const args = { account: 'work', calendarId: 'primary', eventId: 'inv1', response: 'accepted' }
    const req = await describe_(args)
    expect(req.command).toMatch(/^you organize this event — change it with calendar_guest_event .* — deny$/)
    expect(errOf(await run_(args))).toBe('the event could not be loaded — nothing was changed')
    expect(fetch.calls.filter(c => c.startsWith('PATCH'))).toEqual([])
  })

  it('the invite changed after the card → refused, no PATCH', async () => {
    let etag = '"v1"'
    const fetch = useRoutes({ [`GET ${calPath('primary')}/events/inv1`]: () => ({ json: { ...invite, etag } }) })
    const args = { account: 'work', calendarId: 'primary', eventId: 'inv1', response: 'accepted' }
    await describe_(args)
    etag = '"v2"'
    expect(errOf(await run_(args))).toBe('the event changed after you approved it — ask again')
    expect(fetch.calls.filter(c => c.startsWith('PATCH'))).toEqual([])
  })

  it('redactForLog masks the note', async () => {
    expect((await T.redactForLog!({ note: 'personal reason' })).note).toBe('<15 chars>')
  })
})
