// server/lib/channels/bluebubbles/channel.ts
// The outbound iMessage adapter: one delivery row → text (+ image attachments) into a chat.
//
// Retry safety (Review Focus 4): a retry after an unconfirmed or failed attempt first looks for
// Bridget's own message with the same text in that chat since the row was first claimed. If it
// is there, the earlier attempt went out — report success without sending again. If that check
// itself fails, the result is a retryable error and nothing is sent: an unknown answer must never
// turn into a second text. An image-only row (the outbox splits images into their own rows) has
// no text to match, so it skips the check — a rare duplicate photo beats a lost one.
import type { Channel, SendResult } from '../types'
import { loadChannelsConfig } from '../config'
import { getImageBytes } from '../../../services/images'
import { imessageClient, BlueBubblesError } from './client'

/** How far before `firstClaimedAt` an own message still counts (clock skew between hosts). */
const OWN_MESSAGE_LOOKBACK_MS = 5_000

function extFor(mime: string): string {
  const sub = mime.split('/')[1]?.split(';')[0]?.trim() || 'bin'
  return sub === 'jpeg' ? 'jpg' : sub.replace(/[^a-z0-9]/gi, '') || 'bin'
}

function failure(e: unknown): SendResult {
  if (e instanceof BlueBubblesError) return { ok: false, error: e.message, retryable: e.retryable }
  return { ok: false, error: e instanceof Error ? e.message : String(e), retryable: true }
}

export const imessageChannel: Channel = {
  id: 'imessage',

  async isEnabled() {
    if (process.env.BLUEBUBBLES_FAKE_URL) return true
    const c = (await loadChannelsConfig()).imessage
    return c.enabled && !!c.serverUrl && c.passwordEnc !== null
  },

  async send(d) {
    let client
    try { client = await imessageClient() }
    catch (e) { return failure(e) }
    if (!client) return { ok: false, error: 'iMessage is not configured', retryable: false }

    try {
      const text = d.payload.text
      if (d.attempts > 0 && d.firstClaimedAt && text) {
        let found: string | null
        try { found = await client.findOwnMessage(d.target, text, d.firstClaimedAt.getTime() - OWN_MESSAGE_LOOKBACK_MS) }
        catch (e) {
          return { ok: false, error: `duplicate check failed, not resending yet: ${e instanceof Error ? e.message : String(e)}`, retryable: true }
        }
        if (found) return { ok: true, externalId: found }
      }

      let externalId: string | undefined
      let unconfirmed = false
      let sentAny = false
      if (text) {
        const r = await client.sendText(d.target, text, d.id)
        externalId = r.guid ?? undefined
        unconfirmed ||= r.unconfirmed
        sentAny = true
      }

      const ids = d.payload.images ?? []
      for (let i = 0; i < ids.length; i++) {
        const img = await getImageBytes(ids[i]!)
        if (!img) {
          console.warn(`[channels] imessage delivery ${d.id}: image ${ids[i]} not found, skipped`)
          continue
        }
        const r = await client.sendAttachment(d.target, { name: `image-${i + 1}.${extFor(img.mime)}`, mime: img.mime, data: img.bytes }, `${d.id}-img${i}`)
        externalId ??= r.guid ?? undefined
        unconfirmed ||= r.unconfirmed
        sentAny = true
      }

      if (!sentAny) return { ok: false, error: 'nothing to send', retryable: false }
      return unconfirmed ? { ok: true, externalId, unconfirmed: true } : { ok: true, externalId }
    }
    catch (e) {
      return failure(e)
    }
  }
}
