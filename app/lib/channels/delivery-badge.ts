// app/lib/channels/delivery-badge.ts
// How a channel delivery (an assistant reply sent on to iMessage or email) is badged under its
// bubble in /agent. Pure, so the status → badge mapping is unit-tested (test/delivery-badge.test.ts).
import type { MessageDeliveryDTO } from '~~/shared/types/conversation'

export interface DeliveryBadge {
  icon: string
  label: string
  color: 'success' | 'warning' | 'error' | 'neutral'
}

const ICON: Record<MessageDeliveryDTO['channel'], string> = {
  imessage: 'i-lucide-smartphone',
  email: 'i-lucide-mail'
}

export function deliveryBadge(d: MessageDeliveryDTO): DeliveryBadge {
  const icon = ICON[d.channel] ?? 'i-lucide-send'
  switch (d.status) {
    case 'sent': return { icon, label: 'sent', color: 'success' }
    case 'sent_unconfirmed': return { icon, label: 'sent (unconfirmed)', color: 'neutral' }
    case 'pending':
    case 'sending': return { icon, label: 'sending', color: 'neutral' }
    case 'failed': return { icon, label: 'failed', color: 'error' }
    default: return { icon, label: d.status, color: 'warning' }
  }
}

// Worst first: one badge per channel shows the state of the delivery that most needs attention.
const RANK: Record<string, number> = { failed: 0, pending: 1, sending: 1, sent_unconfirmed: 2, sent: 3 }

/**
 * One entry per channel. The outbox splits an iMessage reply with images into a text row plus one
 * row per image (server/lib/channels/outbox.ts), so a single reply can own several rows on the
 * same channel — collapsed here to the least-finished status, imessage before email.
 */
export function summarizeDeliveries(list: readonly MessageDeliveryDTO[]): MessageDeliveryDTO[] {
  const byChannel = new Map<MessageDeliveryDTO['channel'], MessageDeliveryDTO>()
  for (const d of list) {
    const prev = byChannel.get(d.channel)
    if (!prev || (RANK[d.status] ?? -1) < (RANK[prev.status] ?? -1)) byChannel.set(d.channel, { channel: d.channel, status: d.status })
  }
  return (['imessage', 'email'] as const).flatMap(c => byChannel.get(c) ?? [])
}
