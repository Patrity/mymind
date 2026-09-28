// server/lib/channels/deliver.ts (pure part; Task 8 adds planDeliveries below it)
import type { OutboundChannelId } from './types'

/**
 * Resolve which outbound channels a job's `deliver` list actually reaches, given channel
 * enablement and presence.
 *
 * `'app'` never implies an outbound channel. `'auto'` implies imessage, and only when away —
 * it never implies email. `'imessage'`/`'email'` entries are explicit and always considered
 * regardless of presence. The result is deduped and ordered imessage-then-email, and a channel
 * that isn't enabled is dropped even if requested.
 */
export function resolveDeliverChannels(
  deliver: string[],
  s: { imessageEnabled: boolean; emailEnabled: boolean; away: boolean }
): OutboundChannelId[] {
  const want = new Set<OutboundChannelId>()
  for (const d of deliver) {
    if (d === 'imessage' || (d === 'auto' && s.away)) want.add('imessage')
    if (d === 'email') want.add('email')
  }
  const out: OutboundChannelId[] = []
  if (want.has('imessage') && s.imessageEnabled) out.push('imessage')
  if (want.has('email') && s.emailEnabled) out.push('email')
  return out
}
