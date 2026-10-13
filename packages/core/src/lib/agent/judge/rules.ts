// Cycle 84 (spec §2.1 step 1, D4): the judge's instant RULE TIER. Deterministic checks per tool give
// a floor — `high`/`critical`/`deny` are never auto-approvable (C1), whatever the LLM judge says.
// Everything here is pure except gmail_send's recipient check, which needs the account's sent
// history — injected through `ctx.gmail` (the default, sent-history.ts, asks Gmail). Anything that
// cannot be verified there is `high` (fix round 1, R2), never an exception and never `review`.
//
// Cycle 86: host `exec` (and its rule) is gone — Bridget's workspace commands need no approval.
import type { RuleFloor, RuleVerdict } from './types'

/** The tool facts the rules read. An AgentTool satisfies it. */
export interface RuleTool {
  name: string
  outbound?: boolean
}

/** The draft revision a recipient check read: its message id (Gmail mints a new one per edit) and
 *  every To/Cc/Bcc address, lowercased. */
export interface DraftRecipients {
  messageId: string | null
  addresses: string[]
}

/** gmail_send's sent-history lookup (sent-history.ts is the Gmail-backed default). */
export interface GmailHistoryLookup {
  /** The draft that would be sent: its revision id and recipients. */
  recipients(account: string, draftId: string): Promise<DraftRecipients>
  /** Has this account ever sent mail to `address`? */
  mailedBefore(account: string, address: string): Promise<boolean>
}

export interface RuleContext {
  /** Fix round 1 (I2): aborts the default Gmail lookups (the approval judge caps the tier). */
  signal?: AbortSignal
  /** Defaults to the Gmail-backed lookup (sent-history.ts). */
  gmail?: GmailHistoryLookup
}

const ORDER: Record<RuleFloor, number> = { low: 0, review: 1, high: 2, critical: 3, deny: 4 }

/** The stricter of two floors. */
export function maxFloor(a: RuleFloor, b: RuleFloor): RuleFloor {
  return ORDER[a] >= ORDER[b] ? a : b
}

interface Finding { floor: RuleFloor; reason?: string }

function combine(findings: Finding[]): RuleVerdict {
  let floor: RuleFloor = 'review'
  const reasons: string[] = []
  for (const f of findings) {
    floor = maxFloor(floor, f.floor)
    if (f.reason && !reasons.includes(f.reason)) reasons.push(f.reason)
  }
  return { floor, reasons }
}

// --- outbound URLs ---------------------------------------------------------------------------------

/** Paste, file-drop and request-capture hosts — where exfiltrated text usually goes. A host matches
 *  itself and any subdomain. */
export const PASTE_HOSTS = [
  'pastebin.com', 'paste.ee', 'hastebin.com', 'ghostbin.com', 'ghostbin.co', 'rentry.co', 'rentry.org',
  'dpaste.org', 'dpaste.com', 'controlc.com', 'privatebin.net', 'paste.rs', 'termbin.com', 'ix.io',
  'sprunge.us', '0x0.st', 'transfer.sh', 'file.io', 'tmpfiles.org', 'catbox.moe', 'gofile.io',
  'filebin.net', 'bashupload.com', 'temp.sh', 'wetransfer.com', 'we.tl', 'anonfiles.com',
  'webhook.site', 'requestbin.com', 'requestbin.net', 'pipedream.net', 'beeceptor.com', 'hookbin.com',
  'postb.in', 'ptsv2.com', 'ptsv3.com', 'ngrok.io', 'ngrok.app', 'ngrok-free.app', 'trycloudflare.com',
  'serveo.net', 'loca.lt', 'localtunnel.me', 'interact.sh', 'oast.fun', 'oast.pro', 'oast.live',
  'oast.site', 'oast.online', 'oast.me', 'burpcollaborator.net', 'canarytokens.com'
] as const

/** Query strings longer than this are a channel for carrying text out (spec §2.1). */
export const MAX_QUERY_CHARS = 200

function isRawIpHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '')
  if (h.includes(':')) return true // IPv6 literal
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(h)) return true
  // Integer / hex / octal-dotted forms (http://2130706433, http://0x7f.1) the URL parser normalises.
  return /^(?:0x[0-9a-f]+|\d+)(?:\.(?:0x[0-9a-f]+|\d+))*$/i.test(h)
}

function isPasteHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')
  return PASTE_HOSTS.some(d => h === d || h.endsWith(`.${d}`))
}

/** Every http(s) URL in a piece of text. */
export function urlsIn(text: string): URL[] {
  const out: URL[] = []
  for (const m of text.matchAll(/\bhttps?:\/\/[^\s'"<>`]+/gi)) {
    try { out.push(new URL(m[0])) } catch { /* not a URL */ }
  }
  return out
}

function urlFindings(text: string): Finding[] {
  const findings: Finding[] = []
  for (const u of urlsIn(text)) {
    if (isRawIpHost(u.hostname)) findings.push({ floor: 'high', reason: `sends to a raw IP address (${u.hostname})` })
    if (isPasteHost(u.hostname)) findings.push({ floor: 'high', reason: `sends to a paste / file-drop host (${u.hostname.toLowerCase()})` })
    const query = u.search.replace(/^\?/, '')
    if (query.length > MAX_QUERY_CHARS) findings.push({ floor: 'high', reason: `URL carries ${query.length} chars of query (${u.hostname.toLowerCase()})` })
  }
  return findings
}

/** Every string inside a value (deep), for scanning tool args. */
function stringsIn(v: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 6) return out
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) for (const x of v) stringsIn(x, out, depth + 1)
  else if (v && typeof v === 'object') for (const x of Object.values(v)) stringsIn(x, out, depth + 1)
  return out
}

/** Pure: the outbound rule — raw IPs, paste hosts and long queries in any URL arg → high; a web
 *  search query over MAX_QUERY_CHARS → high (the query itself leaves the box); otherwise review. */
export function outboundRule(toolName: string, input: Record<string, unknown>): RuleVerdict {
  const findings = stringsIn(input).flatMap(urlFindings)
  if (toolName === 'web_search' && typeof input.query === 'string' && input.query.length > MAX_QUERY_CHARS) {
    findings.push({ floor: 'high', reason: `search query is ${input.query.length} chars long` })
  }
  return combine(findings)
}

// --- calendar ---------------------------------------------------------------------------------------

/** Pure: calendar deletes and changes involving other attendees → high. */
export function calendarRule(toolName: string, input: Record<string, unknown>): RuleVerdict {
  const op = input.op
  if (toolName === 'calendar_guest_event') {
    if (op === 'cancel') return { floor: 'high', reasons: ['cancels an event and emails every guest'] }
    if (op === 'update') return { floor: 'high', reasons: ['changes an event with other attendees (Google emails every guest)'] }
    const n = Array.isArray(input.attendees) ? input.attendees.length : 0
    if (n > 0) return { floor: 'high', reasons: [`invites ${n} guest${n === 1 ? '' : 's'} (Google emails each)`] }
    return { floor: 'review', reasons: [] }
  }
  if (toolName === 'calendar_write_event' && op === 'delete') return { floor: 'high', reasons: ['deletes a calendar event'] }
  return { floor: 'review', reasons: [] }
}

// --- gmail ------------------------------------------------------------------------------------------

/** A recipient that may safely go into a Gmail search query. Anything else counts as never mailed. */
const PLAIN_ADDRESS = /^[^\s"{}()<>:,;\\]+@[^\s"{}()<>:,;\\]+\.[^\s"{}()<>:,;\\]+$/

/** More recipients than this are not looked up at all → high (R2). */
export const MAX_CHECKED_RECIPIENTS = 10
/** At most this many sent-history lookups in flight (R2). */
export const RECIPIENT_LOOKUP_CONCURRENCY = 4

const UNVERIFIED = 'could not verify recipient history'

/** Run `fn` over `items` with at most `limit` in flight; rejects on the first failure. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/**
 * gmail_send (R2): `review` only when every recipient is VERIFIED as mailed before. `high` when any
 * recipient was never mailed, when the recipients cannot be read or verified (no lookup, a Gmail
 * error, a 429/5xx), when the draft has no readable recipient, or when it has more than
 * MAX_CHECKED_RECIPIENTS. The verdict carries `boundMessageId` — the draft revision that was checked.
 */
export async function gmailSendRule(input: Record<string, unknown>, lookup?: GmailHistoryLookup): Promise<RuleVerdict> {
  const account = typeof input.account === 'string' ? input.account : ''
  const draftId = typeof input.draftId === 'string' ? input.draftId : ''
  if (!lookup) return { floor: 'high', reasons: [UNVERIFIED] }
  let draft: DraftRecipients
  try {
    draft = await lookup.recipients(account, draftId)
  } catch {
    return { floor: 'high', reasons: [UNVERIFIED] }
  }
  const bound = { boundMessageId: draft.messageId }
  const addrs = [...new Set(draft.addresses.map(a => a.trim().toLowerCase()).filter(Boolean))]
  if (addrs.length === 0) return { floor: 'high', reasons: ['no recipients could be read from the draft'], ...bound }
  if (addrs.length > MAX_CHECKED_RECIPIENTS) {
    return { floor: 'high', reasons: [`${addrs.length} recipients (over ${MAX_CHECKED_RECIPIENTS}) — history not checked`], ...bound }
  }
  let mailed: boolean[]
  try {
    mailed = await mapLimit(addrs, RECIPIENT_LOOKUP_CONCURRENCY, a => (PLAIN_ADDRESS.test(a) ? lookup.mailedBefore(account, a) : Promise.resolve(false)))
  } catch {
    return { floor: 'high', reasons: [UNVERIFIED], ...bound }
  }
  const never = addrs.filter((_, i) => mailed[i] !== true)
  if (never.length) {
    return { floor: 'high', reasons: [`first email to ${never.slice(0, 3).join(', ')}${never.length > 3 ? ` (+${never.length - 3} more)` : ''}`], ...bound }
  }
  return { floor: 'review', reasons: [], ...bound }
}

/**
 * R3 (for Task 2): bind a gmail_send rule verdict to the draft revision the approval card pinned for
 * this nonce (tools/gmail.ts pinnedSendMessageId). No pin, or a pin for a different revision than the
 * one whose recipients were checked → at least `high` (the recipients judged are not the ones that
 * would be sent).
 */
export function bindGmailRuleToPin(rule: RuleVerdict, pinnedMessageId: string | null | undefined): RuleVerdict {
  if (pinnedMessageId && rule.boundMessageId && rule.boundMessageId === pinnedMessageId) return rule
  const reason = 'the draft changed after its recipients were checked'
  return { ...rule, floor: maxFloor(rule.floor, 'high'), reasons: rule.reasons.includes(reason) ? rule.reasons : [...rule.reasons, reason] }
}

// --- the tier ---------------------------------------------------------------------------------------

const JOB_TOOLS = new Set(['create_job', 'edit_job', 'run_job', 'delete_job', 'schedule_wake'])
const CALENDAR_TOOLS = new Set(['calendar_guest_event', 'calendar_write_event', 'calendar_rsvp'])

/**
 * The rule tier's floor for one call. Never throws. Unknown tools → `review`.
 *   gmail_send → gmailSendRule (sent-history lookup; Task 2 then
 *   applies bindGmailRuleToPin); calendar → calendarRule;
 *   jobs / wakes → review (plus the URL checks — a job body can carry a URL);
 *   any other `outbound` tool → outboundRule.
 */
export async function ruleVerdict(tool: RuleTool, input: Record<string, unknown>, ctx: RuleContext = {}): Promise<RuleVerdict> {
  try {
    if (tool.name === 'gmail_send') {
      const lookup = ctx.gmail ?? (await import('./sent-history')).gmailSentHistory({}, ctx.signal)
      return await gmailSendRule(input, lookup)
    }
    if (CALENDAR_TOOLS.has(tool.name)) return calendarRule(tool.name, input)
    if (JOB_TOOLS.has(tool.name) || tool.outbound) return outboundRule(tool.name, input)
    return { floor: 'review', reasons: [] }
  } catch {
    // A rule that crashed has verified nothing.
    return { floor: 'high', reasons: ['rule check failed'] }
  }
}
