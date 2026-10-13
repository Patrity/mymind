// Cycle 85 Task 2 — the fake world without a database: Gmail / Calendar / People through the REAL
// toolsets, web fixtures, iMessage, embeddings, live events, activity rows, the bus namespace and
// the network guard. The world's pool is a stub that fails the test if anything reaches it.
//
// Zero-network proof: `transport` below is installed as globalThis.fetch BEFORE the guard wraps it
// (installNetworkGuard captures it), so it stands for the real network — every eval assertion
// checks it was never called, and the guard tests check a direct request is refused before it.
import http from 'node:http'
import https from 'node:https'
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'

vi.mock('../agent/jobs/timezone', () => ({
  getDefaultTimezone: vi.fn(async () => 'America/Chicago'),
  serverTimezone: () => 'UTC'
}))

// Restored in afterAll: builtins and globalThis outlive this file in a reused worker.
const saved = { fetch: globalThis.fetch, httpsGet: https.get, httpRequest: http.request }
const transport = vi.fn(async (..._a: unknown[]) => new Response('REAL NETWORK', { status: 200 }))
globalThis.fetch = transport as unknown as typeof fetch
const realHttpsGet = vi.fn()
const realHttpGet = vi.fn()
;(https as unknown as Record<string, unknown>).get = realHttpsGet
;(http as unknown as Record<string, unknown>).request = realHttpGet

const { buildEvalWorld, installNetworkGuard, fakeEmbed } = await import('./world')
const { parseEvalSetup } = await import('./setup')
const { EvalNetworkBlockedError, currentEvalScope } = await import('./context')
const { gmailTools, gmailSendTool, _resetSendPins } = await import('../agent/tools/gmail')
const { calendarTools } = await import('../agent/tools/calendar')
const { toolByName } = await import('../agent/tools')
const { publishChange, subscribeChanges } = await import('../../utils/live-bus')
const { publishActivity, subscribeActivity } = await import('../agent/bus')
const { createRecorder, recordEvent } = await import('../observability/record')
const { busNs, processBusNs } = await import('../bus/ns')
const { channelFor } = await import('../channels/registry')
const { deliveriesTick } = await import('../channels/outbox')
const { imessageClient } = await import('../channels/bluebubbles/client')
const { embed } = await import('../ai/embeddings')
const { listConnections } = await import('../google/connections')
const { resetPeopleWarmup } = await import('../google/people')

beforeAll(() => installNetworkGuard())
afterAll(() => {
  globalThis.fetch = saved.fetch
  ;(https as unknown as Record<string, unknown>).get = saved.httpsGet
  ;(http as unknown as Record<string, unknown>).request = saved.httpRequest
})
afterEach(() => { transport.mockClear(); realHttpsGet.mockClear(); realHttpGet.mockClear(); _resetSendPins(); resetPeopleWarmup() })

const deadPool = new Proxy({}, { get: () => { throw new Error('the world pool was used in a no-DB test') } }) as never

const SETUP = parseEvalSetup({
  gmail: {
    account: 'personal',
    messages: [
      { id: 'm1', threadId: 't1', from: 'Alice <alice@example.com>', subject: 'Lunch Friday?', body: 'Are you free for lunch on Friday?', date: '2026-10-08T15:00:00Z' },
      { id: 'm2', threadId: 't2', from: 'billing@vendor.com', subject: 'Invoice 42', body: 'Your invoice is attached.', date: '2026-10-09T15:00:00Z', unread: false },
      { id: 'm3', threadId: 't3', from: 'spam@x.com', subject: 'Win', body: 'win now', labels: ['SPAM'] }
    ],
    contacts: [{ name: 'Alice Smith', emails: ['alice@example.com'] }]
  },
  calendar: {
    events: [
      { id: 'e1', summary: 'Dentist', start: '2026-10-16T14:00:00Z', end: '2026-10-16T15:00:00Z', location: 'Main St' },
      { id: 'e2', summary: 'Standup', start: '2026-10-20T14:00:00Z', end: '2026-10-20T14:15:00Z' }
    ]
  },
  web: {
    pages: { 'https://example.com/a': { html: '<html><head><title>Page A</title></head><body><p>Alpha content</p></body></html>' } },
    search: { 'weather|forecast': [{ title: 'Forecast', url: 'https://example.com/a', snippet: 'sunny' }] }
  }
})

const world = (setup = SETUP, allowNetwork?: (u: string) => boolean) =>
  buildEvalWorld({ runId: '00000000-0000-4000-8000-000000000001', schema: 'eval_00000000000040008000000000000001_abcdef01', pool: deadPool, setup, options: allowNetwork ? { allowNetwork } : {} })

const ctx = { signal: new AbortController().signal }
const gmail = (name: string) => gmailTools.find(t => t.name === name)!
const cal = (name: string) => calendarTools.find(t => t.name === name)!

describe('fake Google through the real toolsets', () => {
  it('lists only the fixture account (never Tony\'s connections)', async () => {
    const w = world()
    const conns = await w.run(() => listConnections())
    expect(conns.map(c => c.label)).toEqual(['personal'])
    expect(conns[0]!.email).toBe('tony@eval.example')
  })

  it('gmail_search / gmail_read_thread answer from the fixtures (spam excluded, query operators)', async () => {
    const w = world()
    const all = await w.run(() => gmail('gmail_search').handler({ query: 'in:inbox' }, ctx))
    const threads = (all.result as { threads: { threadId: string }[] }).threads
    expect(threads.map(t => t.threadId).sort()).toEqual(['t1', 't2'])
    const unread = await w.run(() => gmail('gmail_search').handler({ query: 'is:unread from:alice' }, ctx))
    expect((unread.result as { threads: { threadId: string, subject: string }[] }).threads).toEqual([expect.objectContaining({ threadId: 't1', subject: 'Lunch Friday?' })])
    const read = await w.run(() => gmail('gmail_read_thread').handler({ threadId: 't1', account: 'personal' }, ctx))
    expect(JSON.stringify(read.result)).toContain('Are you free for lunch on Friday?')
    expect(w.captured).toEqual([])
    expect(transport).not.toHaveBeenCalled()
  })

  it('draft → approve → gmail_send is captured, never sent', async () => {
    const w = world()
    const d = await w.run(() => gmail('gmail_draft').handler({ account: 'personal', to: ['alice@example.com'], subject: 'Re: Lunch', body: 'Yes, noon works.' }, ctx))
    const draftId = (d.result as { draftId: string }).draftId
    expect(draftId).toEqual(expect.stringMatching(/^draft-eval-/))
    const approval = await w.run(() => gmailSendTool.describeApproval!({ account: 'personal', draftId }, { approvalNonce: 'n1' } as never))
    expect(JSON.stringify(approval)).toContain('Yes, noon works.')
    const sent = await w.run(() => gmailSendTool.handler({ account: 'personal', draftId }, { ...ctx, approvalNonce: 'n1' } as never))
    expect(sent.result).toMatchObject({ sent: true })
    expect(w.captured.map(c => c.kind)).toEqual(['gmail.draft.create', 'gmail.send'])
    expect(w.captured[1]!.detail).toMatchObject({ to: 'alice@example.com', subject: 'Re: Lunch', body: expect.stringContaining('Yes, noon works.') })
    // The sent message is now in the world's own mailbox.
    const after = await w.run(() => gmail('gmail_search').handler({ query: 'in:sent' }, ctx))
    expect((after.result as { threads: unknown[] }).threads).toHaveLength(1)
    expect(transport).not.toHaveBeenCalled()
  })

  it('gmail_modify and contacts_search', async () => {
    const w = world()
    const m = await w.run(() => gmail('gmail_modify').handler({ account: 'personal', threadIds: ['t1'], archive: true }, ctx))
    expect(m.result).not.toHaveProperty('error')
    expect(w.captured).toEqual([expect.objectContaining({ kind: 'gmail.modify', detail: expect.objectContaining({ threadId: 't1', remove: ['INBOX'] }) })])
    const c = await w.run(() => gmail('contacts_search').handler({ query: 'alice' }, ctx))
    expect(JSON.stringify(c.result)).toContain('alice@example.com')
  })

  it('calendar_list_events reads fixture events in the window; writes are captured', async () => {
    const w = world()
    const r = await w.run(() => cal('calendar_list_events').handler({ from: '2026-10-16', to: '2026-10-16' }, ctx))
    const events = (r.result as { events: { title: string }[] }).events
    expect(events.map(e => e.title)).toEqual(['Dentist'])
    const created = await w.run(() => cal('calendar_write_event').handler({ account: 'personal', op: 'create', title: 'Gym', start: '2026-10-17T18:00:00Z' }, ctx))
    expect(created.result).not.toHaveProperty('error')
    const del = await w.run(() => cal('calendar_write_event').handler({ account: 'personal', op: 'delete', eventId: 'e2' }, ctx))
    expect(del.result).not.toHaveProperty('error')
    expect(w.captured.map(c => c.kind)).toEqual(['calendar.insert', 'calendar.delete'])
    expect(w.captured[0]!.detail).toMatchObject({ calendarId: 'primary', event: expect.objectContaining({ summary: 'Gym' }) })
    const free = await w.run(() => cal('calendar_find_free_time').handler({ from: '2026-10-16T13:00:00Z', to: '2026-10-16T16:00:00Z', durationMinutes: 30 }, ctx))
    // The fixture Dentist (14:00–15:00Z = 9–10 AM CDT) is busy time: no slot starts inside it.
    const slots = (free.result as { slots: { start: string }[] }).slots
    expect(slots.length).toBeGreaterThan(0)
    expect(slots.some(x => /T09:[03]0:00-05:00/.test(x.start))).toBe(false)
    expect(transport).not.toHaveBeenCalled()
  })
})

describe('web fixtures', () => {
  it('web_search answers by pattern; no pattern → no results', async () => {
    const w = world()
    const hit = await w.run(() => toolByName('web_search')!.handler({ query: 'weather tomorrow' }, ctx))
    expect(hit.result).toEqual({ results: [{ title: 'Forecast', url: 'https://example.com/a', snippet: 'sunny' }] })
    const miss = await w.run(() => toolByName('web_search')!.handler({ query: 'stock prices' }, ctx))
    expect(miss.result).toEqual({ results: [] })
    expect(transport).not.toHaveBeenCalled()
  })

  it('web_fetch serves a fixture page as markdown; an unknown URL is a 404; SSRF still refused', async () => {
    const w = world()
    const page = await w.run(() => toolByName('web_fetch')!.handler({ url: 'https://example.com/a#frag' }, ctx))
    expect(page.result).toMatchObject({ title: 'Page A', content: expect.stringContaining('Alpha content') })
    const missing = await w.run(() => toolByName('web_fetch')!.handler({ url: 'https://example.com/nope' }, ctx))
    expect(missing.result).toMatchObject({ ok: false, error: expect.stringContaining('404') })
    const ssrf = await w.run(() => toolByName('web_fetch')!.handler({ url: 'http://localhost/x' }, ctx))
    expect(ssrf.result).toMatchObject({ ok: false, error: expect.stringContaining('SSRF') })
    expect(transport).not.toHaveBeenCalled()
  })
})

describe('network guard', () => {
  it('refuses fetch and http(s) inside a world, before the transport', async () => {
    const w = world()
    await expect(w.run(() => fetch('https://api.example.com/x'))).rejects.toBeInstanceOf(EvalNetworkBlockedError)
    await expect(w.run(() => https.get('https://api.example.com/y'))).rejects.toBeInstanceOf(EvalNetworkBlockedError)
    await expect(w.run(() => http.request({ hostname: 'example.org', path: '/z' }))).rejects.toBeInstanceOf(EvalNetworkBlockedError)
    expect(transport).not.toHaveBeenCalled()
    expect(realHttpsGet).not.toHaveBeenCalled()
    expect(realHttpGet).not.toHaveBeenCalled()
    expect(w.blockedNetwork).toEqual(['https://api.example.com/x', 'https://api.example.com/y', 'http://example.org/z'])
  })

  it('catches the real ofetch too (embeddings / rerank / Resend use it, through globalThis.fetch)', async () => {
    const { ofetch } = await vi.importActual<typeof import('ofetch')>('ofetch')
    const w = world()
    await expect(w.run(() => ofetch('https://rerank.example/rerank', { method: 'POST', body: {}, retry: 0 }))).rejects.toThrow(/outbound network blocked/)
    expect(transport).not.toHaveBeenCalled()
    expect(w.blockedNetwork).toEqual(['https://rerank.example/rerank'])
  })

  it('is scoped: real work beside a world still reaches the network, an allowed URL too', async () => {
    const w = world(SETUP, u => u.startsWith('https://model.example/'))
    const [inside, outside] = await Promise.allSettled([
      w.run(async () => { await new Promise(r => setTimeout(r, 5)); return fetch('https://elsewhere.example/') }),
      (async () => { await new Promise(r => setTimeout(r, 1)); return fetch('https://real.example/') })()
    ])
    expect(inside.status).toBe('rejected')
    expect(outside.status).toBe('fulfilled')
    await w.run(() => fetch('https://model.example/v1/chat'))
    expect(transport.mock.calls.map(c => String(c[0]))).toEqual(['https://real.example/', 'https://model.example/v1/chat'])
  })

  it('embeddings are local inside a world (2560 dims, deterministic, no request)', async () => {
    const w = world()
    const [a, b] = await w.run(() => embed(['lunch on friday', 'lunch on friday']))
    expect(a).toHaveLength(2560)
    expect(a).toEqual(b)
    expect(await fakeEmbed(['x'])).toEqual(await fakeEmbed(['x']))
    expect(transport).not.toHaveBeenCalled()
  })
})

describe('channels, live events, activity, bus namespace', () => {
  it('iMessage is a capturing fake; real adapters and the outbox tick are inert', async () => {
    const w = world()
    const client = await w.run(() => imessageClient())
    expect(client).not.toBeNull()
    await w.run(() => client!.sendText('iMessage;-;+15550000000', 'approve?', 'tmp'))
    expect(w.captured).toEqual([expect.objectContaining({ kind: 'imessage.send', detail: { chatGuid: 'iMessage;-;+15550000000', text: 'approve?' } })])
    await expect(w.run(() => channelFor('imessage'))).rejects.toThrow(/disabled in an eval world/)
    await expect(w.run(() => deliveriesTick())).resolves.toEqual({ sent: 0, retried: 0, failed: 0 })
    // Outside a world the real resolver runs (VITEST → null), never the world's fake.
    expect(await imessageClient()).toBeNull()
    expect(() => channelFor('imessage')).not.toThrow()
  })

  it('live changes and activity events never reach subscribers from a world; real ones do', async () => {
    const w = world()
    const changes: unknown[] = []
    const acts: unknown[] = []
    const off1 = subscribeChanges(e => changes.push(e))
    const off2 = subscribeActivity(e => acts.push(e))
    try {
      await w.run(() => { publishChange({ resource: 'task', action: 'created', id: 'x' }); publishActivity({ kind: 'idle' } as never) })
      expect(changes).toEqual([])
      expect(acts).toEqual([])
      expect(w.suppressed).toEqual({ change: 1, activity: 1 })
      publishChange({ resource: 'task', action: 'created', id: 'y' })
      expect(changes).toEqual([expect.objectContaining({ id: 'y' })])
    } finally { off1(); off2() }
  })

  it('activity rows stay in the world, never the recorder buffer', async () => {
    const w = world()
    const sink = vi.fn(async () => {})
    const rec = createRecorder({ sink })
    await w.run(() => { rec.recordEvent({ kind: 'tool', name: 'eval-only' } as never); recordEvent({ kind: 'tool', name: 'eval-default' } as never) })
    await rec.flush()
    expect(sink).not.toHaveBeenCalled()
    expect(w.activity).toEqual([expect.objectContaining({ name: 'eval-only' }), expect.objectContaining({ name: 'eval-default' })])
    rec.recordEvent({ kind: 'tool', name: 'real' } as never)
    await rec.flush()
    expect(sink).toHaveBeenCalledTimes(1)
  })

  it('the bus namespace is the world\'s own inside it, the process\'s outside', async () => {
    const w = world()
    const inside = await w.run(() => busNs())
    expect(inside).toBe(w.schema)
    expect(busNs()).toBe(processBusNs())
    expect(busNs()).not.toBe(inside)
    expect(currentEvalScope()).toBeNull()
  })
})
