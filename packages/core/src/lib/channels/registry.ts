// server/lib/channels/registry.ts
// Maps an outbound channel id to its adapter.
import type { Channel, OutboundChannelId } from './types'
import { imessageChannel } from './bluebubbles/channel'
import { emailChannel } from './email/channel'
import { currentEvalScope } from '../eval/context'

export function channelFor(id: OutboundChannelId): Channel {
  // Cycle 85: defence in depth — the real adapters text / e-mail Tony; an eval world never gets one.
  if (currentEvalScope()) throw new Error(`eval: the ${id} channel adapter is disabled in an eval world`)
  switch (id) {
    case 'imessage': return imessageChannel
    case 'email': return emailChannel
  }
}
