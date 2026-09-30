// server/lib/channels/outbox.ts
// The delivery outbox: callers insert channel_deliveries rows inside their own transaction;
// the worker tick claims due rows, sends each through its channel adapter, and records the
// outcome — sent / sent_unconfirmed / pending again with backoff / failed (+ one note in main).
//
// Status ladder: pending → sending → sent | sent_unconfirmed | pending (retry) | failed.
// `attempts` counts sends made (backoff.ts ruling 2). A `sending` row whose claim is older than
// SENDING_RECLAIM_MS belonged to a process that died mid-send; reclaiming it counts that
// interrupted attempt as a send (it may have gone out), so the adapter sees attempts >= 1 and
// runs its duplicate check against `firstClaimedAt` before sending again (Review Focus 4).
import { and, eq, inArray, lte, lt, or, sql, type SQL } from 'drizzle-orm'
import { useDb } from '../../db'
import { channelDeliveries, type ChannelDelivery } from '../../db/schema'
import { publishChange } from '../../utils/live-bus'
import { appendEvent } from '../../services/conversations'
import { getOrCreateMain } from '../agent/runtime/sessions'
import { channelFor } from './registry'
import { markdownToPlainText } from './plain-text'
import { MAX_ATTEMPTS, nextAttemptDelayMs } from './backoff'
import type { DeliveryPayload, OutboundChannelId, SendResult } from './types'

export type DbTx = Parameters<Parameters<ReturnType<typeof useDb>['transaction']>[0]>[0]

export interface NewDelivery {
  channel: OutboundChannelId
  target: string
  payload: DeliveryPayload
  source: 'reply' | 'job' | 'tool' | 'note'
  conversationId?: string | null
  messageId?: string | null
  jobId?: string | null
  runId?: string | null
}

export const DELIVERY_CLAIM_LIMIT = 10
export const SENDING_RECLAIM_MS = 120_000

const CHANNEL_LABEL: Record<OutboundChannelId, string> = { imessage: 'iMessage', email: 'email' }

/**
 * An iMessage payload with images becomes one text-only row (when there is text) plus one row
 * per image, each retried on its own — a failed photo must never be lost because the text went
 * out, nor re-send the text when only the photo is retried. Email rows are never split.
 * iMessage text is stored as plain text (markdown stripped — the phone renders none; final review
 * M7), so the send, the duplicate check and the unconfirmed-send check all match the same string.
 * Email keeps its markdown: it is rendered to HTML at send time.
 */
function splitPayload(d: NewDelivery): DeliveryPayload[] {
  if (d.channel !== 'imessage') return [d.payload]
  const payload = { ...d.payload, text: markdownToPlainText(d.payload.text) }
  const images = payload.images ?? []
  if (!images.length) return [payload]
  const { images: _drop, ...rest } = payload
  const parts: DeliveryPayload[] = rest.text ? [rest] : []
  for (const id of images) parts.push({ text: '', images: [id] })
  return parts
}

/** Queue deliveries inside the caller's transaction. Returns the inserted ids in order. */
export async function insertDeliveries(tx: DbTx, rows: NewDelivery[]): Promise<string[]> {
  const values = rows.flatMap(d => splitPayload(d).map(payload => ({
    channel: d.channel,
    target: d.target,
    payload,
    source: d.source,
    conversationId: d.conversationId ?? null,
    messageId: d.messageId ?? null,
    jobId: d.jobId ?? null,
    runId: d.runId ?? null
  })))
  if (!values.length) return []
  const inserted = await tx.insert(channelDeliveries).values(values).returning({ id: channelDeliveries.id })
  return inserted.map(r => r.id)
}

async function claim(now: Date, onlyIds?: string[]): Promise<ChannelDelivery[]> {
  const reclaimBefore = new Date(now.getTime() - SENDING_RECLAIM_MS)
  const due: SQL = or(
    and(eq(channelDeliveries.status, 'pending'), lte(channelDeliveries.nextAttemptAt, now)),
    and(eq(channelDeliveries.status, 'sending'), lt(channelDeliveries.claimedAt, reclaimBefore))
  )!
  return useDb().transaction(async (tx) => {
    const picked = await tx.select({ id: channelDeliveries.id }).from(channelDeliveries)
      .where(onlyIds ? and(inArray(channelDeliveries.id, onlyIds), due) : due)
      .orderBy(channelDeliveries.nextAttemptAt)
      .limit(DELIVERY_CLAIM_LIMIT)
      .for('update', { skipLocked: true })
    if (!picked.length) return []
    // SET expressions read the OLD row, so `status = 'sending'` here means "was reclaimed".
    return tx.update(channelDeliveries).set({
      status: 'sending',
      claimedAt: now,
      firstClaimedAt: sql`coalesce(${channelDeliveries.firstClaimedAt}, ${now.toISOString()}::timestamptz)`,
      attempts: sql`${channelDeliveries.attempts} + case when ${channelDeliveries.status} = 'sending' then 1 else 0 end`
    }).where(inArray(channelDeliveries.id, picked.map(p => p.id))).returning()
  })
}

type Outcome = 'sent' | 'retried' | 'failed'

/** `sendMade: false` records a result for a row that was not sent this time (attempts unchanged). */
async function record(row: ChannelDelivery, r: SendResult, now: Date, sendMade = true): Promise<Outcome | null> {
  const attempts = row.attempts + (sendMade ? 1 : 0)
  // Ruling 2: after the n-th failed send, n >= MAX_ATTEMPTS → failed, else wait BACKOFF_MS[n-1].
  const delay = !r.ok && r.retryable && attempts < MAX_ATTEMPTS ? nextAttemptDelayMs(attempts - 1) : null
  let set: Partial<typeof channelDeliveries.$inferInsert>
  let outcome: Outcome
  if (r.ok) {
    outcome = 'sent'
    set = { status: r.unconfirmed ? 'sent_unconfirmed' : 'sent', attempts, externalId: r.externalId ?? null, sentAt: now, lastError: null }
  } else if (delay !== null) {
    outcome = 'retried'
    set = { status: 'pending', attempts, lastError: r.error, nextAttemptAt: new Date(now.getTime() + delay) }
  } else {
    outcome = 'failed'
    set = { status: 'failed', attempts, lastError: r.error }
  }
  // Fenced on our own claim: if a slow send outlived SENDING_RECLAIM_MS and another tick
  // reclaimed the row, that tick owns it now and this result is dropped.
  const updated = await useDb().update(channelDeliveries).set(set)
    .where(and(eq(channelDeliveries.id, row.id), eq(channelDeliveries.status, 'sending'), eq(channelDeliveries.claimedAt, row.claimedAt!)))
    .returning({ id: channelDeliveries.id })
  if (!updated.length) return null
  publishChange({ resource: 'channelDelivery', action: 'updated', id: row.id })
  return outcome
}

async function noteFailure(row: ChannelDelivery, error: string, mainConversationId?: string): Promise<void> {
  const mainId = mainConversationId ?? await getOrCreateMain()
  const label = CHANNEL_LABEL[row.channel as OutboundChannelId] ?? row.channel
  await appendEvent(mainId, `Couldn't deliver to ${label}: ${error}`, 'channel:delivery-failed')
}

async function sendRow(row: ChannelDelivery): Promise<SendResult> {
  try {
    return await channelFor(row.channel as OutboundChannelId).send({
      id: row.id,
      target: row.target,
      payload: row.payload as DeliveryPayload,
      // Sends already made before this one (the column is incremented after the result).
      attempts: row.attempts,
      firstClaimedAt: row.firstClaimedAt
    })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), retryable: true }
  }
}

/**
 * Claim due deliveries and send them. `onlyIds` is the test seam (the dev DB is shared: a test
 * must never claim a real row); `now` overrides the clock (default: Postgres `now()`);
 * `mainConversationId` stands in for main (the failure note).
 */
export async function deliveriesTick(opts: { onlyIds?: string[]; mainConversationId?: string; now?: Date } = {}): Promise<{ sent: number; retried: number; failed: number }> {
  const counts = { sent: 0, retried: 0, failed: 0 }
  if (opts.onlyIds && !opts.onlyIds.length) return counts
  const now = opts.now ?? new Date((((await useDb().execute(sql`select now() as now`)).rows[0]) as { now: string | Date }).now)
  const rows = await claim(now, opts.onlyIds)
  for (const row of rows) publishChange({ resource: 'channelDelivery', action: 'updated', id: row.id })

  // Sent concurrently (the claim limit bounds how many): one slow chat must not hold up the
  // rest of the batch. Each row's result is still written under its own claim guard (record).
  await Promise.all(rows.map(async (row) => {
    // Only a reclaim can bring a row here with its sends used up (its last send was interrupted
    // and counted at claim time): give up rather than make a send past MAX_ATTEMPTS.
    const exhausted = row.attempts >= MAX_ATTEMPTS
    const result: SendResult = exhausted
      ? { ok: false, error: `gave up after ${row.attempts} attempts (the last one was interrupted)${row.lastError ? `; last error: ${row.lastError}` : ''}`, retryable: false }
      : await sendRow(row)
    try {
      const outcome = await record(row, result, now, !exhausted)
      if (!outcome) return
      counts[outcome]++
      if (outcome === 'failed' && !result.ok && row.source !== 'note') {
        await noteFailure(row, result.error, opts.mainConversationId)
          .catch(err => console.error(`[channels] failure note for delivery ${row.id} failed:`, err))
      }
    } catch (err) {
      console.error(`[channels] recording delivery ${row.id} failed:`, err)
    }
  }))
  return counts
}
