// server/lib/channels/types.ts
// Shared contracts for the Bridget channel layer (iMessage via BlueBubbles, email via Resend).
// `Channel` is the outbound adapter interface only — no other code uses it yet (Task 6 wires
// concrete imessage/email adapters against it).

export type ChannelId = 'app' | 'imessage' | 'email'
export type OutboundChannelId = 'imessage' | 'email'

export interface DeliveryPayload {
  text: string
  images?: string[]
  subject?: string
}

export type SendResult =
  | { ok: true; externalId?: string; unconfirmed?: boolean }
  | { ok: false; error: string; retryable: boolean }

export interface Channel {
  id: OutboundChannelId
  isEnabled(): Promise<boolean>
  send(d: { id: string; target: string; payload: DeliveryPayload; attempts: number; firstClaimedAt: Date | null }): Promise<SendResult>
}

export interface InboundAttachment {
  guid: string
  mime: string
  name: string
}

export interface InboundMessage {
  kind: 'message'
  guid: string
  chatGuid: string
  sender: string
  text: string
  attachments: InboundAttachment[]
  date: Date
  isFromMe: boolean
  isGroup: boolean
  /** Set when the payload points at another message (associatedMessageGuid) but is NOT a
   *  recognised tapback — an iOS 18 emoji reaction, a sticker, etc. Never becomes a turn. */
  associatedMessageGuid?: string
}

export type Tapback = 'love' | 'like' | 'dislike' | 'laugh' | 'emphasize' | 'question'

export interface TapbackEvent {
  kind: 'tapback'
  guid: string
  chatGuid: string
  sender: string
  targetGuid: string
  tapback: Tapback
  removed: boolean
  isFromMe: boolean
}
