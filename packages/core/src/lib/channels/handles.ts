// server/lib/channels/handles.ts
// Normalises iMessage/email handles to a canonical form so allowlists, DB keys, and BlueBubbles
// payloads can compare reliably regardless of how a handle was punctuated or cased.

/**
 * Canonicalise a phone number or email address.
 *
 * Emails: strip `mailto:`, trim, lowercase. Phones: strip `tel:`, strip everything but digits,
 * keep a leading `+` when present, and assume a bare 10-digit US number (no country code).
 */
export function normaliseHandle(raw: string): string {
  const s = raw.trim().replace(/^(mailto:|tel:)/i, '')
  if (s.includes('@')) return s.toLowerCase()
  const plus = s.startsWith('+')
  const digits = s.replace(/\D/g, '')
  if (!digits) return ''
  if (plus) return `+${digits}`
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return `+${digits}`
}

/** True when `handle` normalises to the same value as some entry in `allowlist` (both sides normalised). */
export function isAllowed(handle: string, allowlist: string[]): boolean {
  const h = normaliseHandle(handle)
  return !!h && allowlist.some(a => normaliseHandle(a) === h)
}

/**
 * True when `chatGuid` is `sender`'s own direct chat: `<service>;-;<handle>` (any service prefix —
 * iMessage, SMS, any) whose handle part normalises to the sender. The webhook is public behind a
 * token, and the allowlist checks the payload's sender while replies go to its chat, so the two
 * must name the same person (final review I2) — otherwise a forged payload could ask as Tony and
 * have the answer texted to another number.
 */
export function isSendersDirectChat(chatGuid: string, sender: string): boolean {
  const m = /^[^;]+;-;(.+)$/.exec(chatGuid)
  const s = normaliseHandle(sender)
  return !!m && !!s && normaliseHandle(m[1]!) === s
}

/** Mask a handle for logs: last 4 digits of a phone, or first letter + domain of an email. */
export function maskHandle(h: string): string {
  if (h.includes('@')) {
    const [u, d] = h.split('@')
    return `${u!.slice(0, 1)}•••@${d}`
  }
  return h.length <= 5 ? '•••' : `${h.slice(0, 1)}${'•'.repeat(h.length - 5)}${h.slice(-4)}`
}
