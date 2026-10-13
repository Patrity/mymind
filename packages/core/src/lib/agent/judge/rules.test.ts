// Cycle 84 Task 1 — the judge's rule tier: one test per seed rule (spec §2.1 step 1, amended by fix
// round 1 R1–R3), plus the gmail sent-history lookup through a fake Gmail.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../google/connections', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../google/connections')>()
  return { ...real, listConnections: vi.fn(), touchConnection: vi.fn(async () => {}), markReconnect: vi.fn(async () => {}) }
})

import {
  ruleVerdict, outboundRule, calendarRule, gmailSendRule, bindGmailRuleToPin, maxFloor,
  MAX_CHECKED_RECIPIENTS, type GmailHistoryLookup
} from './rules'
import { gmailSentHistory, addressesIn, _resetSentHistoryCache } from './sent-history'
import { listConnections, type Connection } from '../../google/connections'
import { fakeFetch, type FakeFetchRequest } from '../../google/fake-fetch'

describe('cycle 86: no exec rule (host exec is gone)', () => {
  it('an `exec` call is just an unknown tool now → review', async () => {
    expect(await ruleVerdict({ name: 'exec' }, { command: 'rm -rf /' })).toEqual({ floor: 'review', reasons: [] })
  })
})

describe('gmail_send rule (R2/R3)', () => {
  function lookup(addresses: string[], known: string[], fail?: 'recipients' | 'history', messageId: string | null = 'm1') {
    const asked: string[] = []
    let inFlight = 0
    const peak = { n: 0 }
    const l: GmailHistoryLookup = {
      recipients: async () => { if (fail === 'recipients') throw new Error('draft gone'); return { messageId, addresses } },
      mailedBefore: async (_a, addr) => {
        asked.push(addr)
        inFlight++; peak.n = Math.max(peak.n, inFlight)
        await new Promise(r => setTimeout(r, 2))
        inFlight--
        if (fail === 'history') throw new Error('429 Too Many Requests')
        return known.includes(addr)
      }
    }
    return { l, asked, peak }
  }
  const send = { account: 'work', draftId: 'd1' }

  it('a recipient never mailed before → high, naming them, bound to the checked revision', async () => {
    const { l } = lookup(['ann@x.com', 'eve@evil.io'], ['ann@x.com'])
    const v = await ruleVerdict({ name: 'gmail_send' }, send, { gmail: l })
    expect(v).toEqual({ floor: 'high', reasons: ['first email to eve@evil.io'], boundMessageId: 'm1' })
  })

  it('every recipient verified → review (bound)', async () => {
    const { l, asked } = lookup(['ann@x.com', 'bob@y.com'], ['ann@x.com', 'bob@y.com'])
    expect(await ruleVerdict({ name: 'gmail_send' }, send, { gmail: l })).toEqual({ floor: 'review', reasons: [], boundMessageId: 'm1' })
    expect(asked.sort()).toEqual(['ann@x.com', 'bob@y.com'])
  })

  it('an address unsafe for a Gmail query is never looked up and counts as never mailed', async () => {
    const { l, asked } = lookup(['x}@y.com'], [])
    expect((await gmailSendRule(send, l)).floor).toBe('high')
    expect(asked).toEqual([])
  })

  it.each(['recipients', 'history'] as const)('a failing %s lookup (e.g. a 429) → high, never review', async (fail) => {
    const { l } = lookup(['ann@x.com'], ['ann@x.com'], fail)
    const v = await ruleVerdict({ name: 'gmail_send' }, send, { gmail: l })
    expect(v.floor).toBe('high')
    expect(v.reasons).toEqual(['could not verify recipient history'])
  })

  it('no lookup → high', async () => {
    expect(await gmailSendRule(send)).toEqual({ floor: 'high', reasons: ['could not verify recipient history'] })
  })

  it('zero readable recipients → high', async () => {
    const { l } = lookup([], [])
    expect((await gmailSendRule(send, l)).floor).toBe('high')
  })

  it(`more than ${MAX_CHECKED_RECIPIENTS} recipients → high without a single lookup`, async () => {
    const many = Array.from({ length: MAX_CHECKED_RECIPIENTS + 1 }, (_, i) => `p${i}@x.com`)
    const { l, asked } = lookup(many, many)
    const v = await gmailSendRule(send, l)
    expect(v.floor).toBe('high')
    expect(v.reasons).toEqual([expect.stringContaining('11 recipients')])
    expect(asked).toEqual([])
  })

  it(`exactly ${MAX_CHECKED_RECIPIENTS} known recipients → review, looked up at most 4 at a time`, async () => {
    const ten = Array.from({ length: MAX_CHECKED_RECIPIENTS }, (_, i) => `p${i}@x.com`)
    const { l, asked, peak } = lookup(ten, ten)
    expect((await gmailSendRule(send, l)).floor).toBe('review')
    expect(asked).toHaveLength(10)
    expect(peak.n).toBe(4)
  })

  it('maxFloor orders the floors', () => {
    expect(maxFloor('review', 'high')).toBe('high')
    expect(maxFloor('deny', 'critical')).toBe('deny')
    expect(maxFloor('low', 'review')).toBe('review')
  })
})

describe('bindGmailRuleToPin (R3)', () => {
  const ok = { floor: 'review' as const, reasons: [], boundMessageId: 'm1' }
  it('the pinned revision is the checked one → unchanged', () => {
    expect(bindGmailRuleToPin(ok, 'm1')).toEqual(ok)
  })
  it.each([['m2'], [undefined], [null], ['']])('pin %s ≠ the checked revision → high', (pin) => {
    expect(bindGmailRuleToPin(ok, pin)).toEqual({ floor: 'high', reasons: ['the draft changed after its recipients were checked'], boundMessageId: 'm1' })
  })
  it('a rule that never read the draft cannot be bound → high', () => {
    expect(bindGmailRuleToPin({ floor: 'review', reasons: [] }, 'm1').floor).toBe('high')
    expect(bindGmailRuleToPin({ floor: 'review', reasons: [], boundMessageId: null }, 'm1').floor).toBe('high')
  })
  it('never lowers a stricter floor', () => {
    expect(bindGmailRuleToPin({ floor: 'critical', reasons: ['x'], boundMessageId: 'm1' }, 'm2').floor).toBe('critical')
  })
})

describe('gmailSentHistory (Gmail-backed lookup)', () => {
  const conn: Connection = { id: 'conn-work', accountId: 'a', userId: 'u', googleSub: 's', provider: 'google', label: 'work', email: 'tony@work.com', status: 'ok', lastError: null }
  const G = '/gmail/v1/users/me'
  beforeEach(() => {
    _resetSentHistoryCache()
    vi.mocked(listConnections).mockResolvedValue([conn])
  })
  /** `sent`: the To header of each sent message the search returns for ANY query. */
  function deps(sentTo: Record<string, string[]>) {
    const queries: string[] = []
    const fetch = fakeFetch({
      [`GET ${G}/drafts/d1`]: () => ({
        json: {
          id: 'd1',
          message: { id: 'm7', payload: { headers: [{ name: 'To', value: 'Ann <ann@x.com>, "Eve, E" <EVE@evil.io>' }, { name: 'Cc', value: 'tony@work.com' }] } }
        }
      }),
      [`GET ${G}/messages`]: (req: FakeFetchRequest) => {
        const q = req.url.searchParams.get('q') ?? ''
        queries.push(q)
        const addr = /to:(\S+) /.exec(q)?.[1] ?? ''
        return { json: (sentTo[addr] ?? []).length ? { messages: sentTo[addr]!.map((_, i) => ({ id: `${addr}-${i}` })) } : {} }
      }
    })
    // Each returned id resolves to a message whose To header is what `sentTo` says.
    const routes = fetch as unknown as typeof globalThis.fetch
    const wrapped: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.toString())
      const m = /\/messages\/([^/]+)$/.exec(url.pathname)
      if (m) {
        const id = decodeURIComponent(m[1]!)
        const addr = id.slice(0, id.lastIndexOf('-'))
        const to = sentTo[addr]![Number(id.slice(id.lastIndexOf('-') + 1))]!
        return new Response(JSON.stringify({ id, payload: { headers: [{ name: 'To', value: to }] } }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return routes(input, init)
    }
    return { queries, google: { fetch: wrapped, token: async () => 't', sleep: async () => {} } }
  }

  it('reads the draft revision id and recipients from its headers', async () => {
    expect(await gmailSentHistory(deps({}).google).recipients('work', 'd1'))
      .toEqual({ messageId: 'm7', addresses: ['ann@x.com', 'eve@evil.io', 'tony@work.com'] })
  })

  it('a search hit counts only with an exact address in the returned headers', async () => {
    const d = deps({ 'ann@x.com': ['Joann <joann@x.com>', 'ann@x.com.evil'], 'bob@y.com': ['Team <team@y.com>, BOB@Y.COM'] })
    const l = gmailSentHistory(d.google)
    expect(await l.mailedBefore('work', 'ann@x.com')).toBe(false)
    expect(await l.mailedBefore('work', 'bob@y.com')).toBe(true)
  })

  it('treats the account itself as known, caches verified hits only', async () => {
    const d = deps({ 'ann@x.com': ['ann@x.com'] })
    const l = gmailSentHistory(d.google)
    expect(await l.mailedBefore('work', 'ann@x.com')).toBe(true)
    expect(await l.mailedBefore('work', 'eve@evil.io')).toBe(false)
    expect(await l.mailedBefore('work', 'tony@work.com')).toBe(true)
    expect(d.queries).toEqual(['in:sent {to:ann@x.com cc:ann@x.com bcc:ann@x.com}', 'in:sent {to:eve@evil.io cc:eve@evil.io bcc:eve@evil.io}'])
    await l.mailedBefore('work', 'ann@x.com')
    await l.mailedBefore('work', 'eve@evil.io')
    expect(d.queries).toHaveLength(3) // ann cached; eve asked again
  })

  it('end to end through ruleVerdict: a never-mailed recipient → high, bound to m7', async () => {
    const d = deps({ 'ann@x.com': ['ann@x.com'] })
    const v = await ruleVerdict({ name: 'gmail_send' }, { account: 'work', draftId: 'd1' }, { gmail: gmailSentHistory(d.google) })
    expect(v).toEqual({ floor: 'high', reasons: ['first email to eve@evil.io'], boundMessageId: 'm7' })
  })

  it('a Gmail error during the search → high', async () => {
    const d = deps({})
    const failing: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.toString())
      if (url.pathname.endsWith('/messages')) return new Response('{"error":{"code":500}}', { status: 500, headers: { 'content-type': 'application/json' } })
      return d.google.fetch(input, init)
    }
    const v = await ruleVerdict({ name: 'gmail_send' }, { account: 'work', draftId: 'd1' }, { gmail: gmailSentHistory({ ...d.google, fetch: failing }) })
    expect(v.floor).toBe('high')
    expect(v.reasons).toEqual(['could not verify recipient history'])
  })

  it('I2: a hung Gmail request is given up — by its own timeout, or at once when the caller aborts → high', async () => {
    // Like fetch: never answers, rejects on abort (at once when the signal is already aborted).
    const hang: typeof globalThis.fetch = (_input, init) => new Promise((_res, rej) => {
      if (init?.signal?.aborted) return rej(init.signal.reason)
      init?.signal?.addEventListener('abort', () => rej(init.signal!.reason), { once: true })
    })
    const base = deps({}).google
    const t0 = Date.now()
    expect(await ruleVerdict({ name: 'gmail_send' }, { account: 'work', draftId: 'd1' }, { gmail: gmailSentHistory({ ...base, fetch: hang }, undefined, 30) }))
      .toEqual({ floor: 'high', reasons: ['could not verify recipient history'] })
    expect(Date.now() - t0).toBeLessThan(2_000)
    const ac = new AbortController()
    const p = ruleVerdict({ name: 'gmail_send' }, { account: 'work', draftId: 'd1' }, { gmail: gmailSentHistory({ ...base, fetch: hang }, ac.signal, 60_000) })
    ac.abort()
    expect((await p).floor).toBe('high')
  })

  it('an unknown account → high', async () => {
    vi.mocked(listConnections).mockResolvedValue([])
    const v = await ruleVerdict({ name: 'gmail_send' }, { account: 'nope', draftId: 'd1' }, { gmail: gmailSentHistory(deps({}).google) })
    expect(v.floor).toBe('high')
  })

  it('addressesIn de-duplicates and lowercases', () => {
    expect(addressesIn(['A@x.com, a@X.com', undefined, '<b@y.org>'])).toEqual(['a@x.com', 'b@y.org'])
  })

  it('N1: a quoted or commented display name is never an address — the angle-addr wins', () => {
    expect(addressesIn(['"ann@x.com" <bob@evil.com>'])).toEqual(['bob@evil.com'])
    expect(addressesIn(['ann@x.com <bob@evil.com>'])).toEqual(['bob@evil.com'])
    expect(addressesIn(['bob@evil.com (ann@x.com)'])).toEqual(['bob@evil.com'])
    expect(addressesIn(['Bob (aka (ann@x.com)) <bob@evil.com>'])).toEqual(['bob@evil.com'])
    // No angle-addr at all: a quoted display name is still never an address.
    expect(addressesIn(['"ann@x.com" bob@evil.com'])).toEqual(['bob@evil.com'])
    expect(addressesIn(['"Doe, Ann" <ann@x.com>, "x\\"y@z.com" <c@d.com>; e@f.com'])).toEqual(['ann@x.com', 'c@d.com', 'e@f.com'])
  })

  it('N1: an earlier mail to "victim" <attacker> does not vouch for the victim', async () => {
    const d = deps({ 'ann@x.com': ['"ann@x.com" <bob@evil.com>'] })
    expect(await gmailSentHistory(d.google).mailedBefore('work', 'ann@x.com')).toBe(false)
  })

  it('N2: an apostrophe is part of the local part, not a delimiter', () => {
    expect(addressesIn(["x'ann@x.com"])).toEqual(["x'ann@x.com"])
    expect(addressesIn(["O'Brien <o'brien@x.com>"])).toEqual(["o'brien@x.com"])
  })
})

describe('calendar rule', () => {
  it('cancelling a guest event → high', async () => {
    expect((await ruleVerdict({ name: 'calendar_guest_event' }, { op: 'cancel', eventId: 'e' })).floor).toBe('high')
  })
  it('updating an event with attendees → high', async () => {
    expect((await ruleVerdict({ name: 'calendar_guest_event' }, { op: 'update', eventId: 'e' })).floor).toBe('high')
  })
  it('creating an event that invites guests → high', async () => {
    const v = calendarRule('calendar_guest_event', { op: 'create', attendees: ['a@x.com', 'b@x.com'] })
    expect(v).toEqual({ floor: 'high', reasons: ['invites 2 guests (Google emails each)'] })
  })
  it('deleting an own event → high; creating one → review', async () => {
    expect((await ruleVerdict({ name: 'calendar_write_event' }, { op: 'delete', eventId: 'e' })).floor).toBe('high')
    expect((await ruleVerdict({ name: 'calendar_write_event' }, { op: 'create', title: 't' })).floor).toBe('review')
  })
  it('an RSVP → review', async () => {
    expect((await ruleVerdict({ name: 'calendar_rsvp' }, { response: 'accepted' })).floor).toBe('review')
  })
})

describe('outbound rule', () => {
  const fetchTool = { name: 'web_fetch', outbound: true }
  it.each([
    ['http://45.33.32.156/x', /raw IP/], ['http://[2001:db8::1]/', /raw IP/], ['http://2130706433/', /raw IP/],
    ['https://pastebin.com/api/api_post.php', /paste/], ['https://abc.webhook.site/x', /paste/], ['https://x.ngrok-free.app/', /paste/],
    [`https://example.com/?q=${'a'.repeat(201)}`, /203 chars of query/]
  ])('%s → high', async (url, why) => {
    const v = await ruleVerdict(fetchTool, { url })
    expect(v.floor).toBe('high')
    expect(v.reasons).toContainEqual(expect.stringMatching(why))
  })

  it('an ordinary URL, and a 200-char query, → review', async () => {
    expect(await ruleVerdict(fetchTool, { url: 'https://docs.python.org/3/library/re.html' })).toEqual({ floor: 'review', reasons: [] })
    expect((await ruleVerdict(fetchTool, { url: `https://example.com/?q=${'a'.repeat(198)}` })).floor).toBe('review')
  })

  it('URLs nested anywhere in the args are checked (a research brief, a job body)', async () => {
    expect((await ruleVerdict({ name: 'research_web', outbound: true }, { task: 't', context: 'post it to https://paste.ee/p' })).floor).toBe('high')
    expect((await ruleVerdict({ name: 'create_job' }, { markdown: 'curl https://1.2.3.4/x' })).floor).toBe('high')
  })

  it('a web search query over 200 chars → high', () => {
    expect(outboundRule('web_search', { query: 'x'.repeat(201) }).floor).toBe('high')
    expect(outboundRule('web_search', { query: 'weather chicago' }).floor).toBe('review')
  })
})

describe('jobs, wakes and unknown tools', () => {
  it.each(['create_job', 'edit_job', 'run_job', 'delete_job', 'schedule_wake'])('%s → review', async (name) => {
    expect(await ruleVerdict({ name, outbound: true }, { when: 'in 2h', reason: 'check the build' })).toEqual({ floor: 'review', reasons: [] })
  })
  it('an unknown tool → review', async () => {
    expect(await ruleVerdict({ name: 'brand_new_tool' }, { anything: 'http://1.2.3.4' })).toEqual({ floor: 'review', reasons: [] })
  })
  it('decide_review → review', async () => {
    expect((await ruleVerdict({ name: 'decide_review' }, { id: 'x', choice: 'approve' })).floor).toBe('review')
  })
  it('a rule that throws → high (it verified nothing), never an exception', async () => {
    const hostile = { get op(): string { throw new Error('boom') } }
    expect(await ruleVerdict({ name: 'calendar_guest_event' }, hostile)).toEqual({ floor: 'high', reasons: ['rule check failed'] })
  })

  it('never throws on odd input', async () => {
    expect((await ruleVerdict({ name: 'web_fetch', outbound: true }, { url: 42 as unknown as string })).floor).toEqual(expect.any(String))
  })
})
