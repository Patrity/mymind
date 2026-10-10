// server/lib/google/approval-pins.ts
// The approve → act pin shared by every dangerous Google tool (gmail_send, calendar_guest_event,
// calendar_rsvp). describeApproval records what the card showed (a content fingerprint: a draft's
// message id, an event's etag, a planned request body) keyed by `meta.approvalNonce` — the fresh
// v4 UUID buildAiTools mints for THIS approval request. Never key by the draft/event id (shared
// by every approval request ever built for it, so a denied card's pin could answer for a later
// one — cycle 79 review round 2) and never by the SDK's toolCallId (some providers send `""` or a
// repeated id like `call_0` — round 3, N1). The handler takes its own `ctx.approvalNonce`'s pin,
// which consumes it (one-shot) whether or not it then matches; a missing pin — never set (the
// card failed to load), already consumed, expired, or no nonce at all — means refuse. Entries
// carry a TTL that outlasts the iMessage approval wait (10 min, channels/approvals.ts) and are
// swept on access so an approval nobody decides doesn't leak memory forever.

export const APPROVAL_PIN_TTL_MS = 15 * 60 * 1000

export interface NoncePinStore<T> {
  /** Records `value` for this nonce. An empty nonce is ignored (never an ambiguous "" key). */
  remember(nonce: string | undefined, value: T): void
  /** Returns THIS nonce's live pin and consumes it (one-shot) regardless of outcome. */
  take(nonce: string | undefined): T | undefined
  /** Test seam: forget every pin, as a restart would. */
  clear(): void
}

export function createNoncePinStore<T>(ttlMs: number = APPROVAL_PIN_TTL_MS): NoncePinStore<T> {
  const pins = new Map<string, { value: T, expiresAt: number }>()
  const sweep = (now: number) => {
    for (const [key, pin] of pins) if (pin.expiresAt <= now) pins.delete(key)
  }
  return {
    remember(nonce, value) {
      if (!nonce) return
      const now = Date.now()
      sweep(now)
      pins.set(nonce, { value, expiresAt: now + ttlMs })
    },
    take(nonce) {
      if (!nonce) return undefined
      const now = Date.now()
      sweep(now)
      const pin = pins.get(nonce)
      pins.delete(nonce)
      if (!pin || pin.expiresAt <= now) return undefined
      return pin.value
    },
    clear() {
      pins.clear()
    }
  }
}
