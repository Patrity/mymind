// DB-backed — harness pattern from test/jobs-tick.db.test.ts / test/agent-runs.db.test.ts.
//
// Cycle 75, Task 1: the channels schema (channel_deliveries outbox, channel_inbound dedupe,
// channel_approvals) plus agent_runs.reply_to. The dev DB is SHARED with live dev servers in
// other checkouts, so every row this file creates is tracked by id and deleted in afterAll —
// no unscoped UPDATE/DELETE.
process.loadEnvFile('.env')

import { describe, it, expect, afterAll, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { eq, inArray } from 'drizzle-orm'
import { useDb } from '../server/db'
import { agentRuns, channelDeliveries, conversations } from '../server/db/schema'
import { createRun } from '../server/lib/agent/runtime/runs'

const convIds: string[] = []
const runIds: string[] = []
const deliveryIds: string[] = []

afterAll(async () => {
  const db = useDb()
  if (deliveryIds.length) await db.delete(channelDeliveries).where(inArray(channelDeliveries.id, deliveryIds))
  if (runIds.length) await db.delete(agentRuns).where(inArray(agentRuns.id, runIds))
  if (convIds.length) await db.delete(conversations).where(inArray(conversations.id, convIds))
})

describe('channels schema (0057)', () => {
  it('agent_runs.reply_to round-trips through createRun', async () => {
    const [c] = await useDb().insert(conversations).values({ title: 'CHANNELS-SCHEMA-TEST reply-to' }).returning()
    convIds.push(c!.id)

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
    const [c] = await useDb().insert(conversations).values({ title: 'CHANNELS-SCHEMA-TEST delivery-fk' }).returning()
    convIds.push(c!.id)

    const run = await createRun({
      conversationId: c!.id, sessionKey: `thread:${c!.id}`, trigger: 'user', profile: 'interactive',
      input: { text: 'hi', modality: 'text' }
    })
    runIds.push(run.id)

    const [delivery] = await useDb().insert(channelDeliveries).values({
      channel: 'imessage', target: 'iMessage;-;+15550000001', runId: run.id,
      payload: { text: 'reply text' }
    }).returning()
    deliveryIds.push(delivery!.id)
    expect(delivery!.runId).toBe(run.id)

    await useDb().delete(agentRuns).where(eq(agentRuns.id, run.id))
    runIds.splice(runIds.indexOf(run.id), 1) // already deleted — don't try again in afterAll

    const [after] = await useDb().select().from(channelDeliveries).where(eq(channelDeliveries.id, delivery!.id))
    expect(after!.runId).toBeNull()
  })
})
