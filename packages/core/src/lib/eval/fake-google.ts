// Cycle 85 (spec §3.2): an eval world's Google — a fixture-backed stand-in for the Gmail, Calendar
// and People REST endpoints the toolsets call, served as a `fetch` the google() client uses inside
// an eval scope (google/client.ts). It keeps per-world state (drafts, labels, events), so a flow
// like draft → approve → send works end to end, and every write is CAPTURED, never performed.
// Unknown routes answer 404 (and are captured as `google.unrouted`, so a gap shows in the results).
import { rawMessageHeaders, type GmailPayload } from '../google/mime'
import type { EvalSetup, GmailFixtureMessage, CalendarFixtureEvent } from './setup'

type Capture = (kind: string, detail: Record<string, unknown>) => void

interface Msg {
  id: string
  threadId: string
  labelIds: string[]
  internalDate: string
  snippet: string
  payload: GmailPayload
  /** Search fields (lower-case). */
  from: string
  to: string
  cc: string
  subject: string
  body: string
  dateMs: number
}

interface Draft { id: string; messageId: string; threadId?: string; raw: string }

interface Ev {
  calendarId: string
  event: Record<string, unknown> & { id: string }
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url')

function json(status: number, body?: unknown): Response {
  if (body === undefined || status === 204) return new Response(null, { status })
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
const notFound = (what: string) => json(404, { error: { code: 404, message: `${what} not found`, errors: [{ reason: 'notFound' }] } })

function toMsg(m: GmailFixtureMessage, i: number, sent: boolean, me: string): Msg {
  const id = m.id ?? `${sent ? 'sent' : 'msg'}-${i + 1}`
  const dateMs = m.date ? Date.parse(m.date) : Date.UTC(2026, 0, 1) + i * 60_000
  const from = m.from ?? (sent ? me : 'unknown@example.com')
  const to = (m.to ?? (sent ? [] : [me])).join(', ')
  const cc = (m.cc ?? []).join(', ')
  const labels = m.labels ?? (sent ? ['SENT'] : ['INBOX', ...(m.unread === false ? [] : ['UNREAD'])])
  const headers = [
    { name: 'From', value: from }, { name: 'To', value: to },
    ...(cc ? [{ name: 'Cc', value: cc }] : []),
    { name: 'Subject', value: m.subject }, { name: 'Date', value: new Date(dateMs).toUTCString() }
  ]
  return {
    id, threadId: m.threadId ?? id, labelIds: [...labels], internalDate: String(dateMs),
    snippet: m.body.replace(/\s+/g, ' ').slice(0, 140),
    payload: { mimeType: 'text/plain', headers, body: { data: b64(m.body), size: m.body.length } },
    from: from.toLowerCase(), to: to.toLowerCase(), cc: cc.toLowerCase(), subject: m.subject.toLowerCase(), body: m.body.toLowerCase(), dateMs
  }
}

/** Gmail search terms → tokens: quoted phrases and `{a b}` OR-groups stay whole. */
export function tokenizeGmailQuery(q: string): string[] {
  const out: string[] = []
  const re = /-?\{[^}]*\}|-?[^\s"]*"[^"]*"|\S+/g
  for (const m of q.matchAll(re)) out.push(m[0])
  return out
}

function dayMs(v: string): number | null {
  const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(v)
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null
}

function termMatches(m: Msg, term: string, now: number): boolean {
  if (term.startsWith('{') && term.endsWith('}')) return tokenizeGmailQuery(term.slice(1, -1)).some(t => termMatches(m, t, now))
  const i = term.indexOf(':')
  const unq = (v: string) => v.replace(/^"|"$/g, '').toLowerCase()
  if (i > 0) {
    const op = term.slice(0, i).toLowerCase()
    const v = unq(term.slice(i + 1))
    const labels = m.labelIds.map(l => l.toLowerCase())
    switch (op) {
      case 'from': return m.from.includes(v)
      case 'to': return m.to.includes(v)
      case 'cc': return m.cc.includes(v)
      case 'bcc': return false
      case 'subject': return m.subject.includes(v)
      case 'in': return v === 'anywhere' || labels.includes(v)
      case 'label': return labels.includes(v)
      case 'is': return v === 'read' ? !labels.includes('unread') : labels.includes(v)
      case 'has': return false
      case 'after': case 'newer': { const d = dayMs(v); return d === null || m.dateMs >= d }
      case 'before': case 'older': { const d = dayMs(v); return d === null || m.dateMs < d }
      case 'newer_than': case 'older_than': {
        const n = /^(\d+)([dmy])$/.exec(v)
        if (!n) return true
        const span = Number(n[1]) * (n[2] === 'd' ? 86_400_000 : n[2] === 'm' ? 30 * 86_400_000 : 365 * 86_400_000)
        return op === 'newer_than' ? m.dateMs >= now - span : m.dateMs < now - span
      }
      default: break // an unknown operator is a plain word below
    }
  }
  const w = unq(term)
  return !w || m.from.includes(w) || m.to.includes(w) || m.subject.includes(w) || m.body.includes(w)
}

export function gmailQueryMatches(m: Msg, q: string, now = Date.now()): boolean {
  const terms = tokenizeGmailQuery(q.trim())
  const explicitPlace = terms.some(t => /^-?in:(trash|spam|anywhere)$/i.test(t))
  if (!explicitPlace && m.labelIds.some(l => l === 'TRASH' || l === 'SPAM')) return false
  return terms.every(t => t.startsWith('-') && t.length > 1 ? !termMatches(m, t.slice(1), now) : termMatches(m, t, now))
}

function overlaps(ev: Record<string, unknown>, min: number, max: number): boolean {
  const t = (x: unknown) => {
    const o = (x ?? {}) as { dateTime?: string; date?: string }
    return Date.parse(o.dateTime ?? o.date ?? '')
  }
  const s = t(ev.start); const e = t(ev.end)
  if (Number.isNaN(s)) return false
  return s < max && (Number.isNaN(e) ? s : e) > min
}

function fixtureEvent(e: CalendarFixtureEvent, i: number): Ev {
  const time = (v: string, tz?: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) ? { date: v } : { dateTime: v, ...(tz ? { timeZone: tz } : {}) }
  const attendees = (e.attendees ?? []).map(a => typeof a === 'string' ? { email: a, responseStatus: 'needsAction' } : a)
  return {
    calendarId: e.calendarId ?? 'primary',
    event: {
      id: e.id ?? `evt-${i + 1}`, status: 'confirmed', summary: e.summary,
      ...(e.description ? { description: e.description } : {}),
      ...(e.location ? { location: e.location } : {}),
      start: time(e.start, e.timeZone), end: time(e.end, e.timeZone),
      ...(attendees.length ? { attendees } : {}),
      organizer: { email: e.organizer ?? 'tony@eval.example', self: !e.organizer }
    }
  }
}

export interface FakeGoogle {
  fetch: typeof fetch
}

/** The fixture Google for one world. `me` is the world account's address. */
export function createFakeGoogle(setup: EvalSetup, me: string, capture: Capture, now: () => number = Date.now): FakeGoogle {
  const g = setup.gmail ?? {}
  const msgs: Msg[] = [
    ...(g.messages ?? []).map((m, i) => toMsg(m, i, false, me)),
    ...(g.sent ?? []).map((m, i) => toMsg(m, i, true, me))
  ]
  const drafts = new Map<string, Draft>()
  let seq = 0
  const nextId = (p: string) => `${p}-eval-${++seq}`
  const events: Ev[] = (setup.calendar?.events ?? []).map(fixtureEvent)
  const calendars = [...new Set(['primary', ...events.map(e => e.calendarId)])]

  const threadOf = (id: string) => {
    const ms = msgs.filter(m => m.threadId === id).sort((a, b) => a.dateMs - b.dateMs)
    if (!ms.length) return null
    return { id, snippet: ms.at(-1)!.snippet, messages: ms.map(m => ({ id: m.id, threadId: m.threadId, labelIds: m.labelIds, internalDate: m.internalDate, snippet: m.snippet, payload: m.payload })) }
  }
  const draftHeaders = (raw: string) => {
    const h = rawMessageHeaders(raw).headers ?? []
    const get = (n: string) => h.find(x => x.name.toLowerCase() === n)?.value ?? ''
    const text = Buffer.from(raw, 'base64url').toString('utf8')
    const at = text.search(/\r?\n\r?\n/)
    return { to: get('to'), cc: get('cc'), subject: get('subject'), body: at === -1 ? '' : text.slice(at).replace(/^\r?\n\r?\n/, '') }
  }
  const draftView = (d: Draft, format: string) => {
    if (format === 'raw') return { id: d.id, message: { id: d.messageId, threadId: d.threadId, raw: d.raw } }
    if (format === 'minimal') return { id: d.id, message: { id: d.messageId, threadId: d.threadId } }
    const h = rawMessageHeaders(d.raw)
    const { body } = draftHeaders(d.raw)
    return { id: d.id, message: { id: d.messageId, threadId: d.threadId, labelIds: ['DRAFT'], payload: { mimeType: 'text/plain', headers: h.headers, body: { data: b64(body) } } } }
  }
  const applyLabels = (ms: Msg[], add: string[], remove: string[]) => {
    for (const m of ms) {
      m.labelIds = [...new Set([...m.labelIds.filter(l => !remove.includes(l)), ...add])]
    }
  }

  async function gmail(method: string, path: string, u: URL, body: Record<string, unknown>): Promise<Response> {
    let m: RegExpExecArray | null
    if (method === 'GET' && path === '/threads') {
      const q = u.searchParams.get('q') ?? ''
      const max = Number(u.searchParams.get('maxResults') ?? 20)
      const hit = msgs.filter(x => gmailQueryMatches(x, q, now())).sort((a, b) => b.dateMs - a.dateMs)
      const ids = [...new Set(hit.map(x => x.threadId))].slice(0, max)
      return json(200, { threads: ids.map(id => ({ id, snippet: threadOf(id)!.snippet })) })
    }
    if (method === 'GET' && (m = /^\/threads\/([^/]+)$/.exec(path))) {
      const t = threadOf(decodeURIComponent(m[1]!))
      return t ? json(200, t) : notFound('thread')
    }
    if (method === 'POST' && (m = /^\/threads\/([^/]+)\/modify$/.exec(path))) {
      const id = decodeURIComponent(m[1]!)
      const ms = msgs.filter(x => x.threadId === id)
      if (!ms.length) return notFound('thread')
      const add = (body.addLabelIds as string[] | undefined) ?? []; const remove = (body.removeLabelIds as string[] | undefined) ?? []
      capture('gmail.modify', { threadId: id, add, remove })
      applyLabels(ms, add, remove)
      return json(200, threadOf(id))
    }
    if (method === 'POST' && path === '/messages/batchModify') {
      const ids = (body.ids as string[] | undefined) ?? []
      const add = (body.addLabelIds as string[] | undefined) ?? []; const remove = (body.removeLabelIds as string[] | undefined) ?? []
      capture('gmail.modify', { messageIds: ids, add, remove })
      applyLabels(msgs.filter(x => ids.includes(x.id)), add, remove)
      return json(204)
    }
    if (method === 'GET' && path === '/messages') {
      const q = u.searchParams.get('q') ?? ''
      const max = Number(u.searchParams.get('maxResults') ?? 20)
      return json(200, { messages: msgs.filter(x => gmailQueryMatches(x, q, now())).slice(0, max).map(x => ({ id: x.id, threadId: x.threadId })) })
    }
    if (method === 'GET' && (m = /^\/messages\/([^/]+)$/.exec(path))) {
      const x = msgs.find(y => y.id === decodeURIComponent(m![1]!))
      return x ? json(200, { id: x.id, threadId: x.threadId, labelIds: x.labelIds, internalDate: x.internalDate, snippet: x.snippet, payload: x.payload }) : notFound('message')
    }
    if (method === 'GET' && path === '/labels') {
      const system = ['INBOX', 'SENT', 'DRAFT', 'TRASH', 'SPAM', 'STARRED', 'UNREAD', 'IMPORTANT']
      const custom = [...new Set(msgs.flatMap(x => x.labelIds))].filter(l => !system.includes(l))
      return json(200, { labels: [...system.map(id => ({ id, name: id, type: 'system' })), ...custom.map(id => ({ id, name: id, type: 'user' }))] })
    }
    if (method === 'POST' && path === '/drafts') {
      const msg = (body.message ?? {}) as { raw?: string; threadId?: string }
      const d: Draft = { id: nextId('draft'), messageId: nextId('dmsg'), threadId: msg.threadId, raw: msg.raw ?? '' }
      drafts.set(d.id, d)
      capture('gmail.draft.create', { draftId: d.id, threadId: d.threadId ?? null, ...draftHeaders(d.raw) })
      return json(200, draftView(d, 'minimal'))
    }
    if ((m = /^\/drafts\/([^/]+)$/.exec(path)) && m[1] !== 'send') {
      const id = decodeURIComponent(m[1]!)
      const d = drafts.get(id)
      if (!d) return notFound('draft')
      if (method === 'GET') return json(200, draftView(d, u.searchParams.get('format') ?? 'full'))
      if (method === 'PUT') {
        const msg = (body.message ?? {}) as { raw?: string; threadId?: string }
        d.raw = msg.raw ?? d.raw; d.threadId = msg.threadId ?? d.threadId; d.messageId = nextId('dmsg')
        capture('gmail.draft.update', { draftId: d.id, threadId: d.threadId ?? null, ...draftHeaders(d.raw) })
        return json(200, draftView(d, 'minimal'))
      }
      if (method === 'DELETE') {
        drafts.delete(id)
        capture('gmail.draft.delete', { draftId: id })
        return json(204)
      }
    }
    if (method === 'POST' && path === '/drafts/send') {
      const d = drafts.get(String(body.id ?? ''))
      if (!d) return notFound('draft')
      drafts.delete(d.id)
      const h = draftHeaders(d.raw)
      capture('gmail.send', { draftId: d.id, threadId: d.threadId ?? null, ...h })
      const sent = toMsg({ id: nextId('sent'), threadId: d.threadId, from: me, to: h.to ? h.to.split(/,\s*/) : [], subject: h.subject, body: h.body, date: new Date(now()).toISOString() }, msgs.length, true, me)
      msgs.push(sent)
      return json(200, { id: sent.id, threadId: sent.threadId, labelIds: sent.labelIds })
    }
    return unrouted(method, `gmail${path}`)
  }

  async function people(method: string, path: string, u: URL): Promise<Response> {
    if (method !== 'GET') return unrouted(method, `people${path}`)
    if (path === '/v1/otherContacts:search') return json(200, { results: [] })
    if (path === '/v1/people:searchContacts') {
      const q = (u.searchParams.get('query') ?? '').toLowerCase()
      const hits = (g.contacts ?? []).filter(c => q && (c.name.toLowerCase().includes(q) || c.emails.some(e => e.toLowerCase().includes(q))))
      return json(200, { results: hits.map(c => ({ person: { names: [{ displayName: c.name }], emailAddresses: c.emails.map(value => ({ value })), phoneNumbers: (c.phones ?? []).map(value => ({ value })) } })) })
    }
    return unrouted(method, `people${path}`)
  }

  async function calendar(method: string, path: string, u: URL, body: Record<string, unknown>): Promise<Response> {
    let m: RegExpExecArray | null
    if (method === 'GET' && path === '/users/me/calendarList') {
      return json(200, { items: calendars.map(id => ({ id, summary: id === 'primary' ? me : id, primary: id === 'primary', selected: true, accessRole: 'owner' })) })
    }
    if (method === 'POST' && path === '/freeBusy') {
      const min = Date.parse(String(body.timeMin)); const max = Date.parse(String(body.timeMax))
      const ids = ((body.items as { id: string }[] | undefined) ?? []).map(i => i.id)
      const cals: Record<string, { busy: { start: string; end: string }[] }> = {}
      for (const id of ids) {
        cals[id] = { busy: events.filter(e => e.calendarId === id && overlaps(e.event, min, max) && e.event.transparency !== 'transparent').map(e => {
          const s = e.event.start as { dateTime?: string; date?: string }; const en = e.event.end as { dateTime?: string; date?: string }
          return { start: new Date(Date.parse(s.dateTime ?? s.date ?? '')).toISOString(), end: new Date(Date.parse(en.dateTime ?? en.date ?? '')).toISOString() }
        }) }
      }
      return json(200, { calendars: cals })
    }
    if ((m = /^\/calendars\/([^/]+)\/events$/.exec(path))) {
      const cid = decodeURIComponent(m[1]!)
      if (method === 'GET') {
        const min = Date.parse(u.searchParams.get('timeMin') ?? '') ; const max = Date.parse(u.searchParams.get('timeMax') ?? '')
        const q = (u.searchParams.get('q') ?? '').toLowerCase()
        const items = events.filter(e => e.calendarId === cid
          && overlaps(e.event, Number.isNaN(min) ? -Infinity : min, Number.isNaN(max) ? Infinity : max)
          && (!q || JSON.stringify([e.event.summary, e.event.description, e.event.location]).toLowerCase().includes(q)))
          .map(e => e.event)
          .sort((a, b) => overlapsKey(a) - overlapsKey(b))
        return json(200, { items })
      }
      if (method === 'POST') {
        const ev = { ...body, id: nextId('evt'), status: 'confirmed' } as Ev['event']
        events.push({ calendarId: cid, event: ev })
        capture('calendar.insert', { calendarId: cid, sendUpdates: u.searchParams.get('sendUpdates'), event: body })
        return json(200, ev)
      }
    }
    if ((m = /^\/calendars\/([^/]+)\/events\/([^/]+)$/.exec(path))) {
      const cid = decodeURIComponent(m[1]!); const eid = decodeURIComponent(m[2]!)
      const i = events.findIndex(e => e.calendarId === cid && e.event.id === eid)
      if (i === -1) return notFound('event')
      if (method === 'GET') return json(200, events[i]!.event)
      if (method === 'PATCH') {
        capture('calendar.patch', { calendarId: cid, eventId: eid, sendUpdates: u.searchParams.get('sendUpdates'), patch: body })
        events[i] = { calendarId: cid, event: { ...events[i]!.event, ...body, id: eid } }
        return json(200, events[i]!.event)
      }
      if (method === 'DELETE') {
        capture('calendar.delete', { calendarId: cid, eventId: eid, sendUpdates: u.searchParams.get('sendUpdates') })
        events.splice(i, 1)
        return json(204)
      }
    }
    return unrouted(method, `calendar${path}`)
  }

  function unrouted(method: string, what: string): Response {
    capture('google.unrouted', { method, path: what })
    return notFound(`eval: no fixture route for ${method} ${what}`)
  }

  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    const method = (init?.method ?? 'GET').toUpperCase()
    let body: Record<string, unknown> = {}
    if (typeof init?.body === 'string' && init.body) {
      try { body = JSON.parse(init.body) as Record<string, unknown> } catch { body = {} }
    }
    if (u.pathname.startsWith('/gmail/v1/users/me')) return gmail(method, u.pathname.slice('/gmail/v1/users/me'.length), u, body)
    if (u.pathname.startsWith('/calendar/v3')) return calendar(method, u.pathname.slice('/calendar/v3'.length), u, body)
    if (u.hostname === 'people.googleapis.com') return people(method, u.pathname, u)
    return unrouted(method, `${u.hostname}${u.pathname}`)
  }
  return { fetch: impl as typeof fetch }
}

function overlapsKey(ev: Record<string, unknown>): number {
  const s = (ev.start ?? {}) as { dateTime?: string; date?: string }
  return Date.parse(s.dateTime ?? s.date ?? '') || 0
}
