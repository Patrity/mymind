// Cycle 81 (spec §5.3/5.4): telling Tony about a workstream through the existing channels.
//   - always: an event message in the conversation it was started from (origin `workstream:<id>`),
//     carrying the link — the app's notification (Task 6 renders it as a card);
//   - when he is away (presence.ts isAway) and iMessage is set up: a text to his default chat
//     through the outbox (channel_deliveries, source 'note' — retried, never re-noted on failure);
//   - approvals while away: the iMessage approval prompt (channels/approvals.ts), raced with the card.
// Every outbound effect is behind `workstreamNotifyDeps` so the DB tests (the dev DB is shared with a
// live BlueBubbles setup) never text the real phone.
import { appendEvent } from '../../../services/conversations'
import { publishChange } from '../../../utils/live-bus'
import { useDb } from '../../../db'
import { coreConfig } from '../../../config'
import { isAway } from '../../channels/presence'
import { loadChannelsConfig } from '../../channels/config'
import { directChatGuid } from '../../channels/bluebubbles/client'
import { insertDeliveries } from '../../channels/outbox'
import { imessageApprovalChannel } from '../../channels/approvals'
import type { ApprovalRequest } from '../types'
import type { ApprovalVerdictDTO } from '../judge/types'
import { workstreamPath } from '../../../shared/types/workstreams'
import type { WorkstreamRow } from './store'

/** An iMessage approval prompt waits this long before it stops listening (the card keeps waiting —
 *  a workstream approval has no timeout; this only bounds the channel_approvals row). */
export const WORKSTREAM_IMESSAGE_APPROVAL_MS = 30 * 24 * 60 * 60 * 1000

async function defaultChat(): Promise<string | null> {
  const cfg = await loadChannelsConfig()
  if (!cfg.imessage.enabled) return null
  return cfg.imessage.defaultChatGuid ?? (cfg.imessage.defaultHandle ? directChatGuid(cfg.imessage.defaultHandle) : null)
}

export const workstreamNotifyDeps = {
  isAway: () => isAway(),
  /** Text Tony (outbox). Returns the delivery ids queued (none when iMessage is not set up). */
  text: async (text: string, conversationId: string | null): Promise<string[]> => {
    const target = await defaultChat()
    if (!target) return []
    const ids = await useDb().transaction(tx => insertDeliveries(tx, [{ channel: 'imessage', target, payload: { text }, source: 'note', conversationId }]))
    for (const id of ids) publishChange({ resource: 'channelDelivery', action: 'created', id })
    return ids
  },
  /** The iMessage approval prompt for a workstream's card, or null when there is no chat to ask in. */
  /** `verdict` (cycle 84): the card's judge state — its `⚖` line is texted with the prompt. */
  imessageApproval: async (runId: string, req: ApprovalRequest, signal: AbortSignal, verdict?: () => ApprovalVerdictDTO | null): Promise<{ approved: boolean } | null> => {
    const target = await defaultChat()
    if (!target) return null
    return imessageApprovalChannel(runId, target, { signal, timeoutMs: WORKSTREAM_IMESSAGE_APPROVAL_MS, ...(verdict ? { verdict } : {}) })(req)
  }
}

export function workstreamLink(id: string): string {
  const base = (coreConfig().betterAuthUrl ?? '').replace(/\/+$/, '')
  return `${base}${workstreamPath(id)}`
}

/** An event row in the origin chat only (no text) — e.g. an approval card is waiting (its own
 *  iMessage prompt covers the phone). Never throws. */
export async function noteOrigin(ws: Pick<WorkstreamRow, 'id' | 'originConversationId'>, text: string): Promise<void> {
  if (!ws.originConversationId) return
  await appendEvent(ws.originConversationId, `${text}\n${workstreamPath(ws.id)}`, `workstream:${ws.id}`)
    .catch(err => console.error('[workstreams] origin note failed:', err))
}

/**
 * Tell Tony: the origin conversation gets an event row with the link; when he is away, his phone
 * gets a text too. Never throws (a notification must not fail the workstream's own transition).
 */
export async function notifyTony(ws: Pick<WorkstreamRow, 'id' | 'goal' | 'originConversationId' | 'conversationId'>, text: string): Promise<void> {
  const link = workstreamLink(ws.id)
  if (ws.originConversationId) {
    await appendEvent(ws.originConversationId, `${text}\n${workstreamPath(ws.id)}`, `workstream:${ws.id}`)
      .catch(err => console.error('[workstreams] origin note failed:', err))
  }
  try {
    if (await workstreamNotifyDeps.isAway()) await workstreamNotifyDeps.text(`${text}\n${link}`, ws.originConversationId ?? ws.conversationId)
  } catch (err) {
    console.error('[workstreams] away notification failed:', err)
  }
}
