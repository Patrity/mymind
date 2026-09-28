// server/lib/channels/deliver.ts
// Where a finished run's reply goes besides the app: resolveDeliverChannels (pure) and
// planDeliveries, which reads the run, its job, the channel config and presence, and returns the
// channel_deliveries rows for the runner to insert in the same transaction as the reply.
import { eq } from 'drizzle-orm'
import { useDb } from '../../db'
import { agentJobs, agentRuns, type AgentRun } from '../../db/schema'
import { recordEvent } from '../observability/record'
import { parseJob } from '../agent/jobs/parse'
import { loadChannelsConfig } from './config'
import { isAway } from './presence'
import { directChatGuid } from './bluebubbles/client'
import { emailSubject } from './email/render'
import type { NewDelivery } from './outbox'
import type { DeliveryPayload, OutboundChannelId } from './types'

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

const IMAGE_RAW_RE = /\/api\/images\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/raw\b/gi

/** Upload ids of the images a reply links (`/api/images/<uuid>/raw`), in order, deduped.
 *  Public `/api/i/<slug>` links are not resolved — they stay links in the text. */
export function extractImageIds(markdown: string): string[] {
  const out: string[] = []
  for (const m of markdown.matchAll(IMAGE_RAW_RE)) if (!out.includes(m[1]!)) out.push(m[1]!)
  return out
}

function readReplyChat(v: unknown): string | null {
  const r = v as { channel?: unknown; chatGuid?: unknown } | null
  return r?.channel === 'imessage' && typeof r.chatGuid === 'string' && r.chatGuid ? r.chatGuid : null
}

/** A job named a channel it can't reach right now: skipped, with a log line and an activity warn. */
function warnSkipped(slug: string, channel: OutboundChannelId, why: string): void {
  console.warn(`[channels] job ${slug}: ${channel} delivery skipped — ${why}`)
  recordEvent({ kind: 'job', name: 'channels:deliver-skipped', severity: 'warn', status: 'warn', meta: { job: slug, channel, why } })
}

/**
 * The delivery rows for a run's finished, non-silent reply (spec §5.1):
 * - `reply_to` (read FRESH — an iMessage steer sets it on a run that is already going) → one
 *   iMessage reply to that chat;
 * - a job run → its `deliver` list resolved against channel enablement and presence: iMessage to
 *   the default chat, email to the configured address with subject `Bridget · <slug>`;
 * - both → iMessage de-duplicated by target (the reply wins).
 * Images linked in the reply ride along on iMessage (outbox.ts splits them into their own rows);
 * email keeps them as links in the text. Only reads — the caller inserts the rows.
 */
export async function planDeliveries(
  run: AgentRun,
  reply: { text: string; messageId: string; conversationId: string }
): Promise<NewDelivery[]> {
  const [fresh] = await useDb().select({ replyTo: agentRuns.replyTo, jobId: agentRuns.jobId })
    .from(agentRuns).where(eq(agentRuns.id, run.id)).limit(1)
  const replyChat = readReplyChat(fresh ? fresh.replyTo : run.replyTo)
  const jobId = fresh ? fresh.jobId : run.jobId
  if (!replyChat && !jobId) return []

  const config = await loadChannelsConfig()
  const images = extractImageIds(reply.text)
  const imessagePayload: DeliveryPayload = images.length ? { text: reply.text, images } : { text: reply.text }
  const base = { conversationId: reply.conversationId, messageId: reply.messageId, jobId: jobId ?? null, runId: run.id }
  const out: NewDelivery[] = []
  const addIMessage = (target: string, source: 'reply' | 'job') => {
    if (!out.some(d => d.channel === 'imessage' && d.target === target)) out.push({ channel: 'imessage', target, payload: imessagePayload, source, ...base })
  }

  if (replyChat && config.imessage.enabled) addIMessage(replyChat, 'reply')

  if (jobId) {
    const [job] = await useDb().select({ slug: agentJobs.slug, content: agentJobs.content }).from(agentJobs).where(eq(agentJobs.id, jobId)).limit(1)
    // The timezone is irrelevant to `deliver`; any valid default parses the same list.
    const parsed = job ? parseJob(job.content, { defaultTimezone: 'UTC' }) : null
    if (job && parsed && !parsed.ok) console.warn(`[channels] job ${job.slug}: not delivering, its file does not parse: ${parsed.error}`)
    if (job && parsed?.ok) {
      const deliver = parsed.spec.deliver
      const channels = resolveDeliverChannels(deliver, {
        imessageEnabled: config.imessage.enabled,
        emailEnabled: config.email.enabled,
        away: await isAway()
      })
      // Named explicitly but switched off since the job was saved (ruling 4: not re-validated).
      if (deliver.includes('imessage') && !config.imessage.enabled) warnSkipped(job.slug, 'imessage', 'iMessage is disabled')
      if (deliver.includes('email') && !config.email.enabled) warnSkipped(job.slug, 'email', 'email is disabled')

      if (channels.includes('imessage')) {
        const { defaultChatGuid, defaultHandle } = config.imessage
        const target = defaultChatGuid ?? (defaultHandle ? directChatGuid(defaultHandle) : null)
        if (target) addIMessage(target, 'job')
        else warnSkipped(job.slug, 'imessage', 'no default handle is set')
      }
      if (channels.includes('email')) {
        if (config.email.to) out.push({ channel: 'email', target: config.email.to, payload: { text: reply.text, subject: emailSubject(job.slug) }, source: 'job', ...base })
        else warnSkipped(job.slug, 'email', 'no email address is set')
      }
    }
  }
  return out
}
