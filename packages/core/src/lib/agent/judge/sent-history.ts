// Cycle 84: the Gmail-backed sent-history lookup the rule tier uses for gmail_send (rules.ts). There
// is no local sent-mail index, so it asks Gmail itself: the draft's To/Cc/Bcc (with the draft's
// current message id — the revision whose recipients were checked, bound to the card's pin by
// bindGmailRuleToPin), then an `in:sent {to: cc: bcc:}` search per recipient. A search HIT is not
// proof (Gmail's `to:` matching is token-based): an address counts as mailed only when it appears,
// exactly (case-insensitive), in the To/Cc/Bcc headers of a returned sent message (fix round 1, R2).
// A verified address is cached for a few hours (it cannot become "never mailed" again); a miss is not
// cached. Every failure throws — gmailSendRule turns that into `high`.
import type { GoogleDeps } from '../../google/client'
import { resolveOneAccount } from '../../google/accounts'
import { getDraft, sentMessagesTo } from '../../google/gmail'
import { header } from '../../google/mime'
import type { GmailHistoryLookup } from './rules'

const KNOWN_TTL_MS = 6 * 60 * 60 * 1000
const MAX_CACHE = 2000
const known = new Map<string, number>() // `${connectionId}|${address}` → cached at

/** Test seam: forget the cache. */
export function _resetSentHistoryCache(): void { known.clear() }

/** Split one address-list header into its mailboxes: on `,`/`;` outside quoted strings, comments
 *  and angle brackets (`"Doe, Ann" <ann@x.com>` is one mailbox). */
function mailboxesOf(header: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  let depth = 0 // comment nesting
  let angle = false
  for (let i = 0; i < header.length; i++) {
    const ch = header[i]!
    if (ch === '\\' && (quoted || depth > 0)) { cur += ch + (header[i + 1] ?? ''); i++; continue }
    if (quoted) { if (ch === '"') quoted = false; cur += ch; continue }
    if (depth > 0) { if (ch === '(') depth++; else if (ch === ')') depth--; cur += ch; continue }
    if (ch === '"') quoted = true
    else if (ch === '(') depth = 1
    else if (ch === '<') angle = true
    else if (ch === '>') angle = false
    else if ((ch === ',' || ch === ';') && !angle) { out.push(cur); cur = ''; continue }
    cur += ch
  }
  out.push(cur)
  return out
}

/** An addr-spec token (`'` is valid in a local part — Task 2 carry N2 — so it is not a delimiter). */
const ADDR = /[^\s<>,;"()]+@[^\s<>,;"()]+/g

/**
 * Every address in To/Cc/Bcc header values, lowercased, de-duplicated. Per mailbox, quoted strings
 * and comments are dropped first — a display name is never an address (Task 2 carry N1:
 * `"ann@x.com" <bob@evil.com>` is bob only) — then the angle-addr wins when there is one; otherwise
 * the bare addr-spec.
 */
export function addressesIn(values: Array<string | undefined>): string[] {
  const out: string[] = []
  for (const v of values) {
    if (!v) continue
    for (const box of mailboxesOf(v)) {
      let plain = box.replace(/"(?:[^"\\]|\\.)*"?/g, ' ')
      // Comments nest: strip innermost-first; an unclosed one runs to the end.
      for (let prev = ''; prev !== plain;) { prev = plain; plain = plain.replace(/\([^()]*\)/g, ' ') }
      plain = plain.replace(/\(.*$/, ' ')
      const angles = [...plain.matchAll(/<([^<>]*)>/g)].map(m => m[1]!)
      const source = angles.length ? angles.join(' ') : plain
      for (const m of source.matchAll(ADDR)) {
        const a = m[0].toLowerCase()
        if (!out.includes(a)) out.push(a)
      }
    }
  }
  return out
}

/** Fix round 1 (I2): each Gmail request of a lookup gives up after this long. */
export const LOOKUP_REQUEST_TIMEOUT_MS = 5_000

/** `signal` aborts every request still in flight (the approval judge's rule-tier cap / Stop); each
 *  request also has its own LOOKUP_REQUEST_TIMEOUT_MS. An aborted or timed-out request throws —
 *  gmailSendRule turns that into `high`. */
export function gmailSentHistory(base: GoogleDeps = {}, signal?: AbortSignal, requestTimeoutMs = LOOKUP_REQUEST_TIMEOUT_MS): GmailHistoryLookup {
  const doFetch = base.fetch ?? globalThis.fetch
  const deps: GoogleDeps = {
    ...base,
    fetch: async (input, init) => {
      // One controller per request, held for its lifetime (a composite AbortSignal.any of a timeout
      // signal can be collected before it fires).
      const ac = new AbortController()
      const abort = (reason: unknown) => ac.abort(reason)
      const timer = setTimeout(() => abort(new Error(`gmail lookup timed out after ${requestTimeoutMs} ms`)), requestTimeoutMs)
      const outer = [init?.signal, signal].filter((x): x is AbortSignal => !!x)
      const onOuter = function (this: AbortSignal) { abort(this.reason) }
      for (const o of outer) { if (o.aborted) abort(o.reason); else o.addEventListener('abort', onOuter, { once: true }) }
      try {
        return await doFetch(input, { ...init, signal: ac.signal })
      } finally {
        clearTimeout(timer)
        for (const o of outer) o.removeEventListener('abort', onOuter)
      }
    }
  }
  async function conn(account: string) {
    const acc = await resolveOneAccount(account)
    if (!acc.ok) throw new Error(acc.error)
    return acc.c
  }
  return {
    async recipients(account, draftId) {
      const c = await conn(account)
      const d = await getDraft(c, draftId, deps, 'metadata')
      const p = d.message?.payload ?? {}
      return { messageId: d.message?.id ?? null, addresses: addressesIn([header(p, 'To'), header(p, 'Cc'), header(p, 'Bcc')]) }
    },
    async mailedBefore(account, address) {
      const c = await conn(account)
      const addr = address.toLowerCase()
      if (addr === c.email.toLowerCase()) return true
      const key = `${c.id}|${addr}`
      const at = known.get(key)
      if (at !== undefined && Date.now() - at < KNOWN_TTL_MS) return true
      const msgs = await sentMessagesTo(c, addr, deps)
      const sent = msgs.some((m) => {
        const p = m.payload ?? {}
        return addressesIn([header(p, 'To'), header(p, 'Cc'), header(p, 'Bcc')]).includes(addr)
      })
      if (sent) {
        if (known.size >= MAX_CACHE) known.delete(known.keys().next().value!)
        known.set(key, Date.now())
      }
      return sent
    }
  }
}
