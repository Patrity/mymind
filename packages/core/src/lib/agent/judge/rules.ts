// Cycle 84 (spec §2.1 step 1, D4): the judge's instant RULE TIER. Deterministic checks per tool give
// a floor — `critical`/`deny` are never auto-approvable, whatever the LLM judge says; `high` flags
// the call (for the judge's prompt, the card and Tony). Everything here is pure except gmail_send's
// recipient check, which needs the account's sent history — injected through `ctx.gmail` (the
// default, sent-history.ts, asks Gmail). Any failure in that lookup degrades to `review`, never to
// an exception and never to `low`.
import { posix } from 'node:path'
import { isCatastrophic } from '../../exec/outbound'
import type { RuleFloor, RuleVerdict } from './types'

/** The tool facts the rules read. An AgentTool satisfies it. */
export interface RuleTool {
  name: string
  outbound?: boolean
}

/** gmail_send's sent-history lookup (sent-history.ts is the Gmail-backed default). */
export interface GmailHistoryLookup {
  /** Every To/Cc/Bcc address of the draft that would be sent, lowercased. */
  recipients(account: string, draftId: string): Promise<string[]>
  /** Has this account ever sent mail to `address`? */
  mailedBefore(account: string, address: string): Promise<boolean>
}

export interface RuleContext {
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

// --- exec ------------------------------------------------------------------------------------------

/** Package managers installing something (or running a freshly downloaded package / script). */
const INSTALL: RegExp[] = [
  /\b(?:apt-get|apt|dnf|yum|zypper|snap|brew)\s+(?:-\S+\s+)*install\b/i,
  /\bapk\s+(?:-\S+\s+)*add\b/i,
  /\bpacman\s+-S/i,
  /\b(?:pip3?|pipx)\s+(?:-\S+\s+)*install\b/i,
  /\buv\s+(?:pip\s+install|tool\s+install|add)\b/i,
  /\b(?:npm|pnpm|bun)\s+(?:-\S+\s+)*(?:install|i|add)\b/i,
  /\byarn\s+(?:global\s+)?add\b/i,
  /\b(?:gem|cargo|go)\s+install\b/i,
  /\b(?:npx|pnpx|bunx)\s/i,
  /\b(?:curl|wget)\b[^\n;]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/i
]

/** Commands that reach the network. */
const NETWORK = /(?:^|[\s;&|(`$])(?:sudo\s+)?(curl|wget|nc|ncat|netcat|ssh|scp|sftp|rsync|ftp|telnet|socat|nmap|aria2c)(?=\s|$)/i
const GIT_NETWORK = /\bgit\b[^;&|\n]*?\s(?:clone|fetch|pull|push|ls-remote|submodule\s+update)\b/i

/** Where exec writes are expected (the default cwd is the workspace). */
const EXEC_DEFAULT_CWD = '/opt/mymind/workspace'
const KNOWN_WRITE_ROOTS = ['/opt/mymind/workspace', '/tmp', '/var/tmp', '/dev/null', '/dev/stdout', '/dev/stderr']

/** Verbs whose every non-flag argument is written (deleted, chmodded, created…). */
const ALL_ARGS_WRITTEN = new Set(['rm', 'rmdir', 'chmod', 'chown', 'chgrp', 'truncate', 'touch', 'mkdir', 'shred', 'unlink'])
/** Verbs whose LAST non-flag argument is the destination. */
const LAST_ARG_WRITTEN = new Set(['cp', 'mv', 'install', 'ln'])

function underKnownRoot(p: string): boolean {
  return KNOWN_WRITE_ROOTS.some(r => p === r || p.startsWith(`${r}/`))
}

function stripQuotes(t: string): string {
  return t.replace(/^['"]|['"]$/g, '')
}

/** Every path a command visibly writes, resolved against its cwd. Heuristic — shell expansion,
 *  `cd` within the command and variables are not followed (an unresolvable target is ignored). */
export function execWriteTargets(command: string, cwd?: string): string[] {
  const base = cwd && cwd.startsWith('/') ? cwd : posix.join(EXEC_DEFAULT_CWD, cwd ?? '')
  const raw: string[] = []
  for (const m of command.matchAll(/(?:^|[^0-9&<>|])>>?\|?\s*([^\s;|&<>()]+)/g)) raw.push(m[1]!)
  for (const m of command.matchAll(/\btee\s+(?:-\S+\s+)*([^\s;|&<>()]+)/g)) raw.push(m[1]!)
  for (const m of command.matchAll(/\bdd\b[^\n;|&]*\bof=([^\s;|&]+)/g)) raw.push(m[1]!)
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean)
    let i = 0
    while (i < tokens.length && /^(?:sudo|env|nohup|time|[A-Z_][A-Z0-9_]*=\S*)$/.test(tokens[i]!)) i++
    const verb = tokens[i]
    if (!verb) continue
    const isSedInPlace = verb === 'sed' && tokens.some(t => /^-[a-zA-Z]*i/.test(t) || t.startsWith('--in-place'))
    const args = tokens.slice(i + 1).filter(t => !t.startsWith('-'))
    if (ALL_ARGS_WRITTEN.has(verb)) raw.push(...(verb === 'chmod' || verb === 'chown' || verb === 'chgrp' ? args.slice(1) : args))
    else if (LAST_ARG_WRITTEN.has(verb) && args.length >= 2) raw.push(args[args.length - 1]!)
    else if (isSedInPlace && args.length >= 2) raw.push(...args.slice(1))
  }
  const out: string[] = []
  for (const r of raw) {
    const t = stripQuotes(r)
    if (!t || t.includes('$') || t.includes('`') || /^&?\d$/.test(t)) continue
    const resolved = t.startsWith('~') ? `/root${t.slice(1)}` : t.startsWith('/') ? posix.normalize(t) : posix.resolve(base, t)
    if (!out.includes(resolved)) out.push(resolved)
  }
  return out
}

/** Pure: the exec rule (spec §2.1): catastrophic → critical; installs / network / writes outside
 *  the workspace and /tmp → high; otherwise review. */
export function execRule(command: string, cwd?: string): RuleVerdict {
  const findings: Finding[] = []
  if (isCatastrophic(command)) findings.push({ floor: 'critical', reason: 'catastrophic command (wipes, formats or powers off the host)' })
  if (INSTALL.some(re => re.test(command))) findings.push({ floor: 'high', reason: 'installs or runs a downloaded package' })
  const net = NETWORK.exec(command)
  if (net) findings.push({ floor: 'high', reason: `reaches the network (${net[1]!.toLowerCase()})` })
  else if (GIT_NETWORK.test(command)) findings.push({ floor: 'high', reason: 'reaches the network (git remote)' })
  const outside = execWriteTargets(command, cwd).filter(p => !underKnownRoot(p))
  if (outside.length) findings.push({ floor: 'high', reason: `writes outside the workspace and /tmp (${outside.slice(0, 3).join(', ')})` })
  findings.push(...urlFindings(command))
  return combine(findings)
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

/** gmail_send: any recipient this account has never mailed → high; all known → review; the lookup
 *  failing (or none given) → review with the reason. */
export async function gmailSendRule(input: Record<string, unknown>, lookup?: GmailHistoryLookup): Promise<RuleVerdict> {
  const account = typeof input.account === 'string' ? input.account : ''
  const draftId = typeof input.draftId === 'string' ? input.draftId : ''
  if (!lookup) return { floor: 'review', reasons: ['recipient history not checked'] }
  try {
    const recipients = await lookup.recipients(account, draftId)
    const never: string[] = []
    for (const r of recipients) {
      const addr = r.trim().toLowerCase()
      if (!PLAIN_ADDRESS.test(addr) || !(await lookup.mailedBefore(account, addr))) never.push(addr)
    }
    if (never.length) {
      return { floor: 'high', reasons: [`first email to ${never.slice(0, 3).join(', ')}${never.length > 3 ? ` (+${never.length - 3} more)` : ''}`] }
    }
    return { floor: 'review', reasons: [] }
  } catch {
    return { floor: 'review', reasons: ['could not check recipient history'] }
  }
}

// --- the tier ---------------------------------------------------------------------------------------

const JOB_TOOLS = new Set(['create_job', 'edit_job', 'run_job', 'delete_job', 'schedule_wake'])
const CALENDAR_TOOLS = new Set(['calendar_guest_event', 'calendar_write_event', 'calendar_rsvp'])

/**
 * The rule tier's floor for one call. Never throws. Unknown tools → `review`.
 *   exec → execRule; gmail_send → gmailSendRule (sent-history lookup); calendar → calendarRule;
 *   jobs / wakes → review (plus the URL checks — a job body can carry a URL);
 *   any other `outbound` tool → outboundRule.
 */
export async function ruleVerdict(tool: RuleTool, input: Record<string, unknown>, ctx: RuleContext = {}): Promise<RuleVerdict> {
  try {
    if (tool.name === 'exec') {
      return execRule(typeof input.command === 'string' ? input.command : '', typeof input.cwd === 'string' ? input.cwd : undefined)
    }
    if (tool.name === 'gmail_send') {
      const lookup = ctx.gmail ?? (await import('./sent-history')).gmailSentHistory()
      return await gmailSendRule(input, lookup)
    }
    if (CALENDAR_TOOLS.has(tool.name)) return calendarRule(tool.name, input)
    if (JOB_TOOLS.has(tool.name) || tool.outbound) return outboundRule(tool.name, input)
    return { floor: 'review', reasons: [] }
  } catch {
    return { floor: 'review', reasons: ['rule check failed'] }
  }
}
