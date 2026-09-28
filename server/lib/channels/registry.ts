// server/lib/channels/registry.ts
// Maps an outbound channel id to its adapter.
import type { Channel, OutboundChannelId } from './types'
import { imessageChannel } from './bluebubbles/channel'

// Task 5 replaces this with the Resend adapter. It throws rather than no-ops so nothing can
// mistake it for a working channel.
const emailChannel: Channel = {
  id: 'email',
  async isEnabled() { throw new Error('email channel not implemented') },
  async send() { throw new Error('email channel not implemented') }
}

export function channelFor(id: OutboundChannelId): Channel {
  switch (id) {
    case 'imessage': return imessageChannel
    case 'email': return emailChannel
  }
}
