// DB-backed — harness pattern from test/jobs-tick.db.test.ts / test/agent-runs.db.test.ts.
//
// Cycle 75, Task 1: the channels schema (channel_deliveries outbox, channel_inbound dedupe,
// channel_approvals) plus agent_runs.reply_to. The dev DB is SHARED with live dev servers in
// other checkouts, so every row this file creates is tracked by id and deleted in afterAll —
// no unscoped UPDATE/DELETE. Nothing it commits is claimable by a live worker (final review I4):
// each scratch conversation holds a `running` sentinel (alive_at 2100) so its queued runs are
// never claimed, and the delivery row is due only in 2100.
process.loadEnvFile('.env')

import { describe, it, expect, afterAll, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { eq, inArray, sql } from 'drizzle-orm'
import { useDb } from '../server/db'
import { agentRuns, channelDeliveries, conversations } from '../server/db/schema'
import { createRun } from '../server/lib/agent/runtime/runs'

const convIds: string[] = []
const runIds: string[] = []
const deliveryIds: string[] = []
const FAR_FUTURE = new Date('2100-01-01T00:00:00Z')

/** A scratch conversation whose `running` sentinel keeps every queued run in it unclaimable. */
async function scratchConversation(title: string): Promise<string> {
  const [c] = await useDb().insert(conversations).values({ title }).returning()
  convIds.push(c!.id)
  const [s] = await useDb().insert(agentRuns).values({
    conversationId: c!.id, sessionKey: `thread:${c!.id}`, trigger: 'user', profile: 'interactive',
    status: 'running', aliveAt: FAR_FUTURE, input: { text: 'sentinel', modality: 'text' }
  }).returning({ id: agentRuns.id })
  runIds.push(s!.id)
  return c!.id
}

afterAll(async () => {
  const db = useDb()
  if (deliveryIds.length) await db.delete(channelDeliveries).where(inArray(channelDeliveries.id, deliveryIds))
  if (runIds.length) await db.delete(agentRuns).where(inArray(agentRuns.id, runIds))
  if (convIds.length) await db.delete(conversations).where(inArray(conversations.id, convIds))
})

describe('channels schema (0057)', () => {
  it('agent_runs.reply_to round-trips through createRun', async () => {
    const c = { id: await scratchConversation('CHANNELS-SCHEMA-TEST reply-to') }

    const replyTo = { channel: 'imessage' as const, chatGuid: 'iMessage;-;+15550000001', messageGuid: 'chtest-1' }
    const run = await createRun({
      conversationId: c!.id, sessionKey: `thread:${c!.id}`, trigger: 'user', profile: 'interactive',
      input: { text: 'hi', modality: 'text' }, replyTo
    })
    runIds.push(run.id)

    const [row] = await useDb().select().from(agentRuns).where(eq(agentRuns.id, run.id))
    expect(row!.replyTo).toEqual(replyTo)
  })

  it('channel_deliveries.run_id is nulled when the referenced run is deleted (onDelete: set null)', async () => {
    const c = { id: await scratchConversation('CHANNELS-SCHEMA-TEST delivery-fk') }

    const run = await createRun({
      conversationId: c!.id, sessionKey: `thread:${c!.id}`, trigger: 'user', profile: 'interactive',
      input: { text: 'hi', modality: 'text' }
    })
    runIds.push(run.id)

    const [delivery] = await useDb().insert(channelDeliveries).values({
      channel: 'imessage', target: 'iMessage;-;+15550000001', runId: run.id,
      payload: { text: 'reply text' }, nextAttemptAt: FAR_FUTURE
    }).returning()
    deliveryIds.push(delivery!.id)
    expect(delivery!.runId).toBe(run.id)

    await useDb().delete(agentRuns).where(eq(agentRuns.id, run.id))
    runIds.splice(runIds.indexOf(run.id), 1) // already deleted — don't try again in afterAll

    const [after] = await useDb().select().from(channelDeliveries).where(eq(channelDeliveries.id, delivery!.id))
    expect(after!.runId).toBeNull()
  })

  it('0058: channel_deliveries has an index on conversation_id (the per-thread deliveries read)', async () => {
    const r = await useDb().execute(sql`select indexdef from pg_indexes where tablename = 'channel_deliveries' and indexname = 'channel_deliveries_conversation_idx'`)
    expect((r.rows[0] as { indexdef?: string } | undefined)?.indexdef).toMatch(/\(conversation_id\)/)
  })
})
