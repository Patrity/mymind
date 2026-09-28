// server/lib/channels/bluebubbles/parse.ts
// Parses BlueBubbles server webhook payloads (v1.9+) into our InboundMessage/TapbackEvent shape.
// Every field is type-checked before use and nothing here ever throws — a malformed or
// unexpected payload just yields a null event so the webhook route can 404/ignore it safely.

import type { InboundAttachment, InboundMessage, Tapback, TapbackEvent } from '../types'
import { normaliseHandle } from '../handles'

const TAPBACK_NAMES: readonly Tapback[] = ['love', 'like', 'dislike', 'laugh', 'emphasize', 'question']
// BlueBubbles' numeric associatedMessageType codes: 2000-2005 = add, 3000-3005 = remove, same order as TAPBACK_NAMES.
const TAPBACK_CODE_BASE = 2000
const TAPBACK_REMOVE_CODE_BASE = 3000

function toTapback(assocType: unknown): { tapback: Tapback; removed: boolean } | null {
  if (typeof assocType === 'number') {
    if (assocType >= TAPBACK_CODE_BASE && assocType < TAPBACK_CODE_BASE + TAPBACK_NAMES.length) {
      return { tapback: TAPBACK_NAMES[assocType - TAPBACK_CODE_BASE]!, removed: false }
    }
    if (assocType >= TAPBACK_REMOVE_CODE_BASE && assocType < TAPBACK_REMOVE_CODE_BASE + TAPBACK_NAMES.length) {
      return { tapback: TAPBACK_NAMES[assocType - TAPBACK_REMOVE_CODE_BASE]!, removed: true }
    }
    return null
  }
  if (typeof assocType === 'string') {
    const removed = assocType.startsWith('-')
    const name = removed ? assocType.slice(1) : assocType
    return (TAPBACK_NAMES as readonly string[]).includes(name) ? { tapback: name as Tapback, removed } : null
  }
  return null
}

/** Strip BlueBubbles' `p:<index>/` (per-participant) or `bp:` (bulk) prefix off a target message guid. */
function stripTargetPrefix(guid: string): string {
  return guid.replace(/^(p:\d+\/|bp:)/, '')
}

/**
 * Parse one BlueBubbles `data` object into an InboundMessage or TapbackEvent, or null when the
 * payload is missing required fields. Never throws.
 */
export function parseBlueBubblesMessage(data: unknown): InboundMessage | TapbackEvent | null {
  try {
    if (!data || typeof data !== 'object') return null
    const d = data as Record<string, unknown>
    if (typeof d.guid !== 'string' || !d.guid) return null

    const chats = Array.isArray(d.chats) ? d.chats : []
    const chat0 = chats.length > 0 && chats[0] && typeof chats[0] === 'object' ? (chats[0] as Record<string, unknown>) : null
    const chatGuid = chat0 && typeof chat0.guid === 'string' ? chat0.guid : ''
    if (!chatGuid) return null
    const isGroup = (typeof chat0?.style === 'number' && chat0.style === 43) || chatGuid.includes(';+;')

    const handle = d.handle && typeof d.handle === 'object' ? (d.handle as Record<string, unknown>) : null
    const sender = handle && typeof handle.address === 'string' ? normaliseHandle(handle.address) : ''
    const isFromMe = d.isFromMe === true
    const dateMs = typeof d.dateCreated === 'number' ? d.dateCreated : Date.now()

    const assocGuidRaw = d.associatedMessageGuid
    const assocType = d.associatedMessageType
    if (typeof assocGuidRaw === 'string' && assocGuidRaw) {
      const tb = toTapback(assocType)
      if (tb) {
        const event: TapbackEvent = {
          kind: 'tapback',
          guid: d.guid,
          chatGuid,
          sender,
          targetGuid: stripTargetPrefix(assocGuidRaw),
          tapback: tb.tapback,
          removed: tb.removed,
          isFromMe
        }
        return event
      }
    }

    const attachmentsRaw = Array.isArray(d.attachments) ? d.attachments : []
    const attachments: InboundAttachment[] = attachmentsRaw
      .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
      .map(a => ({
        guid: typeof a.guid === 'string' ? a.guid : '',
        mime: typeof a.mimeType === 'string' ? a.mimeType : '',
        name: typeof a.transferName === 'string' ? a.transferName : ''
      }))
      .filter(a => a.guid)

    const message: InboundMessage = {
      kind: 'message',
      guid: d.guid,
      chatGuid,
      sender,
      text: typeof d.text === 'string' ? d.text : '',
      attachments,
      date: new Date(dateMs),
      isFromMe,
      isGroup,
      // An association that isn't a tapback (emoji reaction 2006/3006, sticker, …): flagged so
      // the inbound pipeline drops it rather than treating it as a plain message.
      ...(typeof assocGuidRaw === 'string' && assocGuidRaw ? { associatedMessageGuid: stripTargetPrefix(assocGuidRaw) } : {})
    }
    return message
  } catch {
    return null
  }
}

/**
 * Parse a full BlueBubbles webhook body. Returns the raw `type` string plus the decoded event.
 * A plain `updated-message` (e.g. a read-receipt update, no tapback association) yields no
 * event — only `new-message` and tapback-carrying `updated-message` payloads do. Never throws.
 */
export function parseWebhook(body: unknown): { type: string; event: InboundMessage | TapbackEvent | null } {
  try {
    if (!body || typeof body !== 'object') return { type: '', event: null }
    const b = body as Record<string, unknown>
    const type = typeof b.type === 'string' ? b.type : ''
    if (type !== 'new-message' && type !== 'updated-message') return { type, event: null }

    const event = parseBlueBubblesMessage(b.data)
    if (type === 'updated-message' && event?.kind !== 'tapback') return { type, event: null }
    return { type, event }
  } catch {
    return { type: '', event: null }
  }
}
