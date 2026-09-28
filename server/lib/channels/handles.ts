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

/** Mask a handle for logs: last 4 digits of a phone, or first letter + domain of an email. */
export function maskHandle(h: string): string {
  if (h.includes('@')) {
    const [u, d] = h.split('@')
    return `${u!.slice(0, 1)}•••@${d}`
  }
  return h.length <= 5 ? '•••' : `${h.slice(0, 1)}${'•'.repeat(h.length - 5)}${h.slice(-4)}`
}
