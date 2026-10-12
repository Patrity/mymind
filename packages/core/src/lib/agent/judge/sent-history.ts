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

/** Every address in To/Cc/Bcc header values, lowercased, de-duplicated. */
export function addressesIn(values: Array<string | undefined>): string[] {
  const out: string[] = []
  for (const v of values) {
    if (!v) continue
    for (const m of v.matchAll(/[^\s<>,;"'()]+@[^\s<>,;"'()]+/g)) {
      const a = m[0].toLowerCase()
      if (!out.includes(a)) out.push(a)
    }
  }
  return out
}

export function gmailSentHistory(deps: GoogleDeps = {}): GmailHistoryLookup {
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
