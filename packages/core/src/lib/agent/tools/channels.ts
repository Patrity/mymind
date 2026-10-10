// server/lib/agent/tools/channels.ts
// Bridget's send_message tool (cycle 75, Task 10): text or email Tony, and ONLY Tony — there is
// no address parameter (global-constraints.md). Target always comes from the configured default
// (iMessage's defaultChatGuid/defaultHandle, or email.to), never from the model. Follows the
// cycle-74 tools' never-throw contract (server/lib/agent/tools/jobs.ts): every failure mode
// (channel disabled, no default target, rate limit) returns { ok:false, error }, never throws.
import { and, eq, gte, sql } from 'drizzle-orm'
import { z } from 'zod'
import { useDb } from '../../../db'
import { channelDeliveries } from '../../../db/schema'
import { appendEvent } from '../../../services/conversations'
import { publishChange } from '../../../utils/live-bus'
import type { AgentTool } from '../types'
import { getOrCreateMain } from '../runtime/sessions'
import { directChatGuid } from '../../channels/bluebubbles/client'
import { loadChannelsConfig } from '../../channels/config'
import { emailSubject } from '../../channels/email/render'
import { insertDeliveries, type NewDelivery } from '../../channels/outbox'
import type { OutboundChannelId } from '../../channels/types'

export const SEND_MESSAGE_RATE_LIMIT = 20
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000

const CHANNEL_LABEL: Record<OutboundChannelId, string> = { imessage: 'iMessage', email: 'email' }

const notSetUp = (id: OutboundChannelId) => `${CHANNEL_LABEL[id]} isn't set up — Tony can configure it in Settings → Channels`
const noDefaultTarget = (id: OutboundChannelId) =>
  id === 'imessage'
    ? "Tony hasn't set a default iMessage contact — he can add one in Settings → Channels"
    : "Tony hasn't set a default email address — he can add one in Settings → Channels"

/**
 * Test seam (mirrors outbox.ts's `mainConversationId` opt): the dev DB is shared with real data,
 * so a DB test must never count real 'tool' deliveries or post its "sent" note to real main.
 * `countSince` defaults to the real rate-limit query; a test overrides it to scope the count to
 * only the rows it seeded. `mainConversationId` defaults to the real main conversation; a test
 * overrides it to a scratch conversation.
 */
export const channelToolDeps = {
  countSince: async (channel: OutboundChannelId, since: Date): Promise<number> => {
    const [row] = await useDb().select({ n: sql<number>`count(*)::int` }).from(channelDeliveries)
      .where(and(
        eq(channelDeliveries.source, 'tool'),
        eq(channelDeliveries.channel, channel),
        gte(channelDeliveries.createdAt, since)
      ))
    return row?.n ?? 0
  },
  mainConversationId: undefined as string | undefined
}

async function resolveTarget(channel: OutboundChannelId, cfg: Awaited<ReturnType<typeof loadChannelsConfig>>): Promise<string | null> {
  if (channel === 'imessage') {
    return cfg.imessage.defaultChatGuid ?? (cfg.imessage.defaultHandle ? directChatGuid(cfg.imessage.defaultHandle) : null)
  }
  return cfg.email.to
}

export const channelTools: AgentTool[] = [
  {
    name: 'send_message',
    description: 'Text or email Tony — the only person this can reach (there is no address parameter; the target is whatever he configured as his default in Settings → Channels). Use to reach him outside the current conversation, e.g. from a background job or a long-running task. Limited to 20 sends per hour per channel. On failure (channel not set up, no default target, or rate limit) returns ok:false with a plain-English error — say so rather than retrying.',
    kind: 'create',
    toolset: 'channels',
    schema: {
      channel: z.enum(['imessage', 'email']).describe('Which channel to send through'),
      text: z.string().min(1).max(4000).describe('Message body'),
      subject: z.string().max(200).optional().describe('Email subject (email only; ignored for iMessage). Defaults to "Bridget · message".')
    },
    handler: async (a) => {
      try {
        const channel = a.channel as OutboundChannelId
        const text = a.text as string
        const subject = a.subject as string | undefined
        const label = CHANNEL_LABEL[channel]

        const cfg = await loadChannelsConfig()
        const enabled = channel === 'imessage' ? cfg.imessage.enabled : cfg.email.enabled
        if (!enabled) {
          return { result: { ok: false, error: notSetUp(channel) }, summary: `send_message: ${channel} not set up` }
        }

        const target = await resolveTarget(channel, cfg)
        if (!target) {
          return { result: { ok: false, error: noDefaultTarget(channel) }, summary: `send_message: no default ${channel} target` }
        }

        const since = new Date(Date.now() - RATE_LIMIT_WINDOW_MS)
        const count = await channelToolDeps.countSince(channel, since)
        if (count >= SEND_MESSAGE_RATE_LIMIT) {
          return { result: { ok: false, error: `rate limit reached (${SEND_MESSAGE_RATE_LIMIT}/hour)` }, summary: 'send_message: rate limit reached' }
        }

        const payload = channel === 'email' ? { text, subject: subject ?? emailSubject('message') } : { text }
        const newDelivery: NewDelivery = { channel, target, payload, source: 'tool' }
        const [deliveryId] = await useDb().transaction(async (tx) => insertDeliveries(tx, [newDelivery]))
        publishChange({ resource: 'channelDelivery', action: 'created', id: deliveryId! })

        const mainId = channelToolDeps.mainConversationId ?? await getOrCreateMain()
        await appendEvent(mainId, `Sent to ${label}: ${text.slice(0, 120)}`, 'channel:sent')

        return {
          result: { deliveryId, status: 'pending' },
          summary: `queued for ${label}`
        }
      } catch (err) {
        // Never-throw contract (server/lib/agent/tools/jobs.ts): a raw DB/config exception must
        // not escape the tool boundary.
        const message = err instanceof Error ? err.message : String(err)
        return { result: { ok: false, error: message }, summary: `send_message failed: ${message}` }
      }
    }
  }
]
