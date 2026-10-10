// DB-backed — harness pattern from test/channels-deliver.db.test.ts / test/channels-outbox.db.test.ts.
//
// Cycle 75, Task 10: the send_message agent tool (server/lib/agent/tools/channels.ts). The dev
// DB is SHARED with live dev servers and holds real data, so:
//   - the channel config is stubbed (never written) — enabling iMessage/email in the real
//     settings row, even briefly, would switch it on for every live dev server on this DB;
//   - the tool's "sent" event note is redirected to a SCRATCH conversation via the
//     `channelToolDeps.mainConversationId` seam — it must never touch real main;
//   - the rate-limit test seeds 20 rows tagged with a marker `conversation_id` that is not a
//     real conversation, and overrides `channelToolDeps.countSince` to scope the count to that
//     marker only — it must never count (or be blocked by) real 'tool' deliveries;
//   - every delivery row this file creates is tracked by id and deleted in afterAll/inline;
//   - no real iMessage/email ever sends here — this only inserts channel_deliveries rows, it
//     never runs the outbox worker. And no LIVE worker can claim them either (final review I4):
//     the tool's insertDeliveries is wrapped to move its rows to 2100 in the SAME transaction,
//     and the rate-limit seed rows are inserted due in 2100 (both stay `pending`, never due).
process.loadEnvFile('.env')

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

const cfg = vi.hoisted(() => ({
  imessage: { enabled: true, defaultHandle: '+15550000091' as string | null, defaultChatGuid: 'iMessage;-;+15550000091' as string | null },
  email: { enabled: true, to: 'tony@example.test' as string | null }
}))
const FAR_FUTURE = vi.hoisted(() => new Date('2100-01-01T00:00:00Z'))
vi.mock('@mymind/core/lib/channels/outbox', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mymind/core/lib/channels/outbox')>()
  const { channelDeliveries } = await import('@mymind/core/db/schema')
  const { inArray } = await import('drizzle-orm')
  return {
    ...real,
    insertDeliveries: async (tx: Parameters<typeof real.insertDeliveries>[0], rows: Parameters<typeof real.insertDeliveries>[1]) => {
      const ids = await real.insertDeliveries(tx, rows)
      if (ids.length) await tx.update(channelDeliveries).set({ nextAttemptAt: FAR_FUTURE }).where(inArray(channelDeliveries.id, ids))
      return ids
    }
  }
})
vi.mock('@mymind/core/lib/channels/config', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mymind/core/lib/channels/config')>()
  return {
    ...real,
    loadChannelsConfig: async () => ({
      imessage: { enabled: cfg.imessage.enabled, serverUrl: '', passwordEnc: null, webhookToken: 'x', allowedHandles: [], defaultHandle: cfg.imessage.defaultHandle, defaultChatGuid: cfg.imessage.defaultChatGuid },
      email: { enabled: cfg.email.enabled, to: cfg.email.to },
      presenceAwayMinutes: 10
    })
  }
})

import { and, eq, gte, inArray, sql } from 'drizzle-orm'
import { useDb } from '@mymind/core/db'
import { channelDeliveries, conversationMessages, conversations } from '@mymind/core/db/schema'
import { createConversation } from '@mymind/core/services/conversations'
import { agentTools } from '@mymind/core/lib/agent/tools'
import { channelToolDeps, SEND_MESSAGE_RATE_LIMIT } from '@mymind/core/lib/agent/tools/channels'
import { classifyForHeadless } from '@mymind/core/lib/agent/runtime/gate'

const tool = agentTools.find(t => t.name === 'send_message')!
const ctx = { signal: new AbortController().signal }

// Not a real conversation row (channel_deliveries.conversation_id has no FK) — just a value the
// rate-limit test's seeded rows and its scoped countSince override both key on.
const MARKER = '00000000-0000-4000-8000-0000000000c7'

let scratchMain = ''
const deliveryIds: string[] = []

async function eventsOnScratch() {
  return useDb().select().from(conversationMessages)
    .where(and(eq(conversationMessages.conversationId, scratchMain), eq(conversationMessages.origin, 'channel:sent')))
}

async function deliveriesWithText(text: string) {
  return useDb().select().from(channelDeliveries).where(sql`${channelDeliveries.payload}->>'text' = ${text}`)
}

beforeAll(async () => {
  scratchMain = (await createConversation({ title: 'chtool-scratch-main' })).id
  channelToolDeps.mainConversationId = scratchMain
})

afterAll(async () => {
  if (deliveryIds.length) await useDb().delete(channelDeliveries).where(inArray(channelDeliveries.id, deliveryIds))
  if (scratchMain) {
    await useDb().delete(conversationMessages).where(eq(conversationMessages.conversationId, scratchMain))
    await useDb().delete(conversations).where(eq(conversations.id, scratchMain))
  }
  channelToolDeps.mainConversationId = undefined
})

beforeEach(() => {
  cfg.imessage = { enabled: true, defaultHandle: '+15550000091', defaultChatGuid: 'iMessage;-;+15550000091' }
  cfg.email = { enabled: true, to: 'tony@example.test' }
})

afterEach(async () => {
  // Keeps each test's event assertions isolated without deleting the scratch conversation itself.
  await useDb().delete(conversationMessages).where(eq(conversationMessages.conversationId, scratchMain))
})

describe('send_message tool', () => {
  it('is registered, create-kind, not dangerous, and the schema has no address field', () => {
    expect(tool).toBeTruthy()
    expect(tool.kind).toBe('create')
    expect(tool.dangerous).toBeFalsy()
    expect(Object.keys(tool.schema)).toEqual(['channel', 'text', 'subject'])
  })

  it('the headless gate classifies it as append (runs headless, never proposed)', () => {
    expect(() => classifyForHeadless(tool)).not.toThrow()
    expect(classifyForHeadless(tool)).toBe('run')
  })

  it('happy path: queues one iMessage delivery + one channel:sent event on main', async () => {
    const text = `chtool-happy-imessage-${Date.now()}`
    const exec = await tool.handler({ channel: 'imessage', text }, ctx)
    const result = exec.result as { deliveryId: string, status: string }
    expect(result.status).toBe('pending')
    expect(typeof result.deliveryId).toBe('string')
    deliveryIds.push(result.deliveryId)
    expect(exec.summary).toBe('queued for iMessage')

    const rows = await deliveriesWithText(text)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: result.deliveryId, channel: 'imessage', target: 'iMessage;-;+15550000091',
      source: 'tool', payload: { text }, status: 'pending'
    })
    expect(rows[0]!.nextAttemptAt.getTime()).toBe(FAR_FUTURE.getTime()) // never due for a live worker

    const notes = await eventsOnScratch()
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ origin: 'channel:sent', content: `Sent to iMessage: ${text}` })
  })

  it('happy path: email defaults the subject via emailSubject("message"); an explicit subject wins', async () => {
    const text1 = `chtool-happy-email-default-${Date.now()}`
    const exec1 = await tool.handler({ channel: 'email', text: text1 }, ctx)
    const r1 = exec1.result as { deliveryId: string, status: string }
    deliveryIds.push(r1.deliveryId)
    expect(exec1.summary).toBe('queued for email')
    const rows1 = await deliveriesWithText(text1)
    expect(rows1[0]).toMatchObject({ channel: 'email', target: 'tony@example.test', source: 'tool', payload: { text: text1, subject: 'Bridget · message' } })

    const text2 = `chtool-happy-email-subject-${Date.now()}`
    const exec2 = await tool.handler({ channel: 'email', text: text2, subject: 'Heads up' }, ctx)
    const r2 = exec2.result as { deliveryId: string }
    deliveryIds.push(r2.deliveryId)
    const rows2 = await deliveriesWithText(text2)
    expect(rows2[0]).toMatchObject({ payload: { text: text2, subject: 'Heads up' } })
  })

  it('channel disabled → an explanation, no delivery row, no event', async () => {
    cfg.imessage.enabled = false
    const text = `chtool-disabled-${Date.now()}`
    const exec = await tool.handler({ channel: 'imessage', text }, ctx)
    expect(exec.result).toEqual({ ok: false, error: "iMessage isn't set up — Tony can configure it in Settings → Channels" })
    expect(await deliveriesWithText(text)).toHaveLength(0)
    expect(await eventsOnScratch()).toHaveLength(0)
  })

  it('no default target configured → an explanation, no delivery row, no event', async () => {
    cfg.email = { enabled: true, to: null }
    const text = `chtool-no-target-${Date.now()}`
    const exec = await tool.handler({ channel: 'email', text }, ctx)
    expect(exec.result).toMatchObject({ ok: false })
    expect((exec.result as { error: string }).error).toMatch(/default email address/i)
    expect(await deliveriesWithText(text)).toHaveLength(0)
    expect(await eventsOnScratch()).toHaveLength(0)
  })

  it('the 21st call in an hour hits the rate limit — scoped to this test\'s own seeded rows', async () => {
    const seedRows = Array.from({ length: SEND_MESSAGE_RATE_LIMIT }, (_, i) => ({
      channel: 'imessage', target: 'iMessage;-;+15550000091', payload: { text: `chtool-seed-${i}` },
      source: 'tool' as const, conversationId: MARKER, nextAttemptAt: FAR_FUTURE
    }))
    const inserted = await useDb().insert(channelDeliveries).values(seedRows).returning({ id: channelDeliveries.id })
    const seededIds = inserted.map(r => r.id)
    deliveryIds.push(...seededIds) // afterAll too, should the inline delete below never run

    const original = channelToolDeps.countSince
    channelToolDeps.countSince = async (channel, since) => {
      const [row] = await useDb().select({ n: sql<number>`count(*)::int` }).from(channelDeliveries)
        .where(and(
          eq(channelDeliveries.source, 'tool'), eq(channelDeliveries.channel, channel),
          eq(channelDeliveries.conversationId, MARKER), gte(channelDeliveries.createdAt, since)
        ))
      return row?.n ?? 0
    }

    const text = `chtool-21st-${Date.now()}`
    try {
      const exec = await tool.handler({ channel: 'imessage', text }, ctx)
      expect(exec.result).toEqual({ ok: false, error: 'rate limit reached (20/hour)' })
    } finally {
      channelToolDeps.countSince = original
      await useDb().delete(channelDeliveries).where(inArray(channelDeliveries.id, seededIds))
    }
    expect(await deliveriesWithText(text)).toHaveLength(0)
    expect(await eventsOnScratch()).toHaveLength(0)
  })
})
