// server/lib/channels/registry.ts
// Maps an outbound channel id to its adapter.
import type { Channel, OutboundChannelId } from './types'
import { imessageChannel } from './bluebubbles/channel'
import { emailChannel } from './email/channel'

export function channelFor(id: OutboundChannelId): Channel {
  switch (id) {
    case 'imessage': return imessageChannel
    case 'email': return emailChannel
  }
}
