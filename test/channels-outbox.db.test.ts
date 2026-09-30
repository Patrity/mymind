// DB-backed — harness pattern from test/jobs-tick.db.test.ts / test/channels-schema.db.test.ts.
//
// Cycle 75, Task 6: the delivery outbox (server/lib/channels/outbox.ts). The dev DB is SHARED
// with live dev servers in other checkouts and holds real data, so:
//   - every deliveriesTick call is scoped with `onlyIds` (rows this file created);
//   - every row is due only in the year 2100 and every tick passes `now` from then — a real
//     worker's tick (real clock) can never find these rows due or reclaimable;
//   - the channel is a scripted stub (registry mocked) — nothing reaches BlueBubbles or Resend;
//   - the failure note lands in a SCRATCH conversation via the `mainConversationId` seam;
//   - every row / conversation is tracked by id and deleted in afterAll.
process.loadEnvFile('.env')

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { Client } from 'pg'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

type Send = { id: string; target: string; payload: { text: string; images?: string[] }; attempts: number; firstClaimedAt: Date | null }
type Result = { ok: true; externalId?: string; unconfirmed?: boolean } | { ok: false; error: string; retryable: boolean }

const script = vi.hoisted(() => ({
  calls: [] as Send[],
  next: [] as Result[],
  /** A result chosen by the payload text — for concurrent sends, where call order is not fixed. */
  byText: {} as Record<string, Result>,
  delayMs: 0
}))
vi.mock('../server/lib/channels/registry', () => ({
  channelFor: (id: string) => ({
    id,
    isEnabled: async () => true,
    async send(d: Send): Promise<Result> {
      script.calls.push(structuredClone(d))
      if (script.delayMs) await new Promise(r => setTimeout(r, script.delayMs))
      return script.byText[d.payload.text] ?? script.next.shift() ?? { ok: true, externalId: `ext-${d.id}` }
    }
  })
}))

import { and, asc, eq, inArray } from 'drizzle-orm'
import { useDb } from '../server/db'
import { channelDeliveries, conversationMessages, conversations } from '../server/db/schema'
import { createConversation } from '../server/services/conversations'
import { insertDeliveries, deliveriesTick, SENDING_RECLAIM_MS, type NewDelivery } from '../server/lib/channels/outbox'
import { MAX_ATTEMPTS } from '../server/lib/channels/backoff'
import { workerTick, _deliveriesSettled } from '../server/lib/agent/runtime/queue'

const db = () => useDb()
const T0 = new Date('2100-01-01T00:00:00Z')
const at = (ms: number) => new Date(T0.getTime() + ms)
const CHAT = 'iMessage;-;+15550000006'

const deliveryIds: string[] = []
let scratchMain = ''

beforeAll(async () => {
  scratchMain = (await createConversation({ title: 'chout-scratch-main' })).id
})

afterAll(async () => {
  if (deliveryIds.length) await db().delete(channelDeliveries).where(inArray(channelDeliveries.id, deliveryIds))
  if (scratchMain) {
    await db().delete(conversationMessages).where(eq(conversationMessages.conversationId, scratchMain))
    await db().delete(conversations).where(eq(conversations.id, scratchMain))
  }
})

beforeEach(async () => {
  script.calls.length = 0
  script.next.length = 0
  script.delayMs = 0
  script.byText = {}
  await db().delete(conversationMessages).where(eq(conversationMessages.conversationId, scratchMain))
  await db().update(conversations).set({ activeLeafId: null, messageCount: 0 }).where(eq(conversations.id, scratchMain))
})

// The ONLY insert path in this file. The move to 2100 happens in the SAME transaction as the
// insert, so no committed row is ever due on the real clock — a real worker tick on the shared
// DB can never claim one.
async function insert(rows: NewDelivery[]): Promise<string[]> {
  const ids = await db().transaction(async (tx) => {
    const inserted = await insertDeliveries(tx, rows)
    await tx.update(channelDeliveries).set({ nextAttemptAt: T0 }).where(inArray(channelDeliveries.id, inserted))
    return inserted
  })
  deliveryIds.push(...ids)
  return ids
}

const one = (text = 'hello', over: Partial<NewDelivery> = {}): NewDelivery =>
  ({ channel: 'imessage', target: CHAT, payload: { text }, source: 'reply', ...over })

async function row(id: string) {
  const [r] = await db().select().from(channelDeliveries).where(eq(channelDeliveries.id, id))
  return r!
}

async function notes() {
  return db().select().from(conversationMessages)
    .where(and(eq(conversationMessages.conversationId, scratchMain), eq(conversationMessages.origin, 'channel:delivery-failed')))
    .orderBy(asc(conversationMessages.createdAt))
}

const tick = (ids: string[], now: Date) => deliveriesTick({ onlyIds: ids, mainConversationId: scratchMain, now })

describe('insertDeliveries', () => {
  it('M7: iMessage text is stored as plain text; email keeps its markdown', async () => {
    const md = '## Plan\n**Buy** [milk](https://shop.test)'
    const ids = await insert([
      one(md),
      { channel: 'email', target: 'tony@example.com', payload: { text: md, subject: 'Bridget · message' }, source: 'job' }
    ])
    const rows = await Promise.all(ids.map(row))
    expect(rows.map(r => (r.payload as { text: string }).text)).toEqual(['Plan\nBuy milk (https://shop.test)', md])
  })

  it('splits an iMessage payload with images into a text row + one row per image; email is never split', async () => {
    const ids = await insert([
      one('look', { payload: { text: 'look', images: ['img-a', 'img-b'] } }),
      one('', { payload: { text: '', images: ['img-c'] } }),
      { channel: 'email', target: 'tony@example.com', payload: { text: 'mail', images: ['img-d'], subject: 'Bridget · message' }, source: 'job' }
    ])
    const rows = await Promise.all(ids.map(row))
    expect(rows.map(r => [r.channel, r.payload])).toEqual([
      ['imessage', { text: 'look' }],
      ['imessage', { text: '', images: ['img-a'] }],
      ['imessage', { text: '', images: ['img-b'] }],
      ['imessage', { text: '', images: ['img-c'] }],
      ['email', { text: 'mail', images: ['img-d'], subject: 'Bridget · message' }]
    ])
    expect(rows.every(r => r.status === 'pending' && r.attempts === 0)).toBe(true)
    expect(rows[4]!.source).toBe('job')
  })
})

describe('deliveriesTick', () => {
  it('claims, sends and marks a pending row sent; firstClaimedAt is stamped once and never moves', async () => {
    const [id] = await insert([one()])
    expect(await tick([id!], T0)).toEqual({ sent: 1, retried: 0, failed: 0 })
    const r = await row(id!)
    expect(r.status).toBe('sent')
    expect(r.externalId).toBe(`ext-${id}`)
    expect(r.sentAt).not.toBeNull()
    expect(r.firstClaimedAt?.getTime()).toBe(T0.getTime())
    expect(script.calls[0]).toMatchObject({ id, target: CHAT, payload: { text: 'hello' }, attempts: 0 })
    expect(script.calls[0]!.firstClaimedAt?.getTime()).toBe(T0.getTime())

    // firstClaimedAt survives a later claim (a retry) unchanged.
    const [id2] = await insert([one('again')])
    script.next.push({ ok: false, error: 'boom', retryable: true })
    await tick([id2!], T0)
    await tick([id2!], at(31_000))
    expect((await row(id2!)).firstClaimedAt?.getTime()).toBe(T0.getTime())
    expect(script.calls[2]!.firstClaimedAt?.getTime()).toBe(T0.getTime())
  })

  it('a retryable failure goes back to pending with attempts 1 and next_attempt_at now + 30 s, untouched until then', async () => {
    const [id] = await insert([one()])
    script.next.push({ ok: false, error: 'server hiccup', retryable: true })
    expect(await tick([id!], T0)).toEqual({ sent: 0, retried: 1, failed: 0 })
    let r = await row(id!)
    expect(r.status).toBe('pending')
    expect(r.attempts).toBe(1)
    expect(r.lastError).toBe('server hiccup')
    expect(r.nextAttemptAt.getTime()).toBe(T0.getTime() + 30_000)

    expect(await tick([id!], at(10_000))).toEqual({ sent: 0, retried: 0, failed: 0 })
    expect(script.calls).toHaveLength(1)

    expect(await tick([id!], at(30_000))).toEqual({ sent: 1, retried: 0, failed: 0 })
    r = await row(id!)
    expect(r.status).toBe('sent')
    expect(r.attempts).toBe(2)
  })

  it('after MAX_ATTEMPTS (6) retryable failures the row is failed and ONE note lands in main', async () => {
    expect(MAX_ATTEMPTS).toBe(6)
    const [id] = await insert([one()])
    let now = T0
    for (let i = 0; i < 10; i++) {
      script.next.push({ ok: false, error: 'server down', retryable: true })
      await tick([id!], now)
      now = new Date(now.getTime() + 4 * 3_600_000) // past any backoff
    }
    expect(script.calls).toHaveLength(6)
    expect(script.calls.map(c => c.attempts)).toEqual([0, 1, 2, 3, 4, 5])
    const r = await row(id!)
    expect(r.status).toBe('failed')
    expect(r.attempts).toBe(6)
    const n = await notes()
    expect(n).toHaveLength(1)
    expect(n[0]!.role).toBe('event')
    expect(n[0]!.content).toBe("Couldn't deliver to iMessage: server down")
  })

  it('backoff follows 30 s, 2 m, 10 m, 1 h, 1 h between the six sends', async () => {
    const [id] = await insert([one()])
    let now = T0
    const gaps: number[] = []
    for (let i = 0; i < 5; i++) {
      script.next.push({ ok: false, error: 'x', retryable: true })
      await tick([id!], now)
      const next = (await row(id!)).nextAttemptAt
      gaps.push(next.getTime() - now.getTime())
      now = next
    }
    expect(gaps).toEqual([30_000, 120_000, 600_000, 3_600_000, 3_600_000])
  })

  it('a non-retryable failure fails immediately with one note (email label)', async () => {
    const [id] = await insert([{ channel: 'email', target: 'tony@example.com', payload: { text: 'hi' }, source: 'job' }])
    script.next.push({ ok: false, error: 'bad address', retryable: false })
    expect(await tick([id!], T0)).toEqual({ sent: 0, retried: 0, failed: 1 })
    const r = await row(id!)
    expect(r.status).toBe('failed')
    expect(r.attempts).toBe(1)
    const n = await notes()
    expect(n.map(m => m.content)).toEqual(["Couldn't deliver to email: bad address"])
  })

  it('a failed source=note row never writes a note (no recursion)', async () => {
    const [id] = await insert([one('note', { source: 'note' })])
    script.next.push({ ok: false, error: 'nope', retryable: false })
    await tick([id!], T0)
    expect((await row(id!)).status).toBe('failed')
    expect(await notes()).toHaveLength(0)
  })

  it('reclaims a sending row claimed 3 minutes ago, not one claimed 30 seconds ago; the reclaim counts as a send', async () => {
    const [stale, fresh] = await insert([one('stale'), one('fresh')])
    await db().update(channelDeliveries).set({ status: 'sending', claimedAt: at(-180_000), firstClaimedAt: at(-180_000) }).where(eq(channelDeliveries.id, stale!))
    await db().update(channelDeliveries).set({ status: 'sending', claimedAt: at(-30_000), firstClaimedAt: at(-30_000) }).where(eq(channelDeliveries.id, fresh!))
    expect(SENDING_RECLAIM_MS).toBe(120_000)

    expect(await tick([stale!, fresh!], T0)).toEqual({ sent: 1, retried: 0, failed: 0 })
    expect(script.calls.map(c => c.id)).toEqual([stale])
    // The interrupted attempt may have gone out: the channel sees attempts >= 1 (so its duplicate
    // check runs) and the ORIGINAL firstClaimedAt.
    expect(script.calls[0]!.attempts).toBe(1)
    expect(script.calls[0]!.firstClaimedAt?.getTime()).toBe(at(-180_000).getTime())
    expect((await row(stale!)).status).toBe('sent')
    expect((await row(fresh!)).status).toBe('sending')
  })

  it('a reclaimed row whose sends are used up fails with a note instead of a 7th send', async () => {
    const [id] = await insert([one('last')])
    await db().update(channelDeliveries).set({
      status: 'sending', attempts: 5, lastError: 'server down', claimedAt: at(-180_000), firstClaimedAt: at(-7_200_000)
    }).where(eq(channelDeliveries.id, id!))
    expect(await tick([id!], T0)).toEqual({ sent: 0, retried: 0, failed: 1 })
    expect(script.calls).toHaveLength(0)
    const r = await row(id!)
    expect(r.status).toBe('failed')
    expect(r.attempts).toBe(6)
    expect((await notes()).map(n => n.content)).toEqual([
      "Couldn't deliver to iMessage: gave up after 6 attempts (the last one was interrupted); last error: server down"
    ])
  })

  it('unconfirmed → sent_unconfirmed', async () => {
    const [id] = await insert([one()])
    script.next.push({ ok: true, unconfirmed: true })
    expect(await tick([id!], T0)).toEqual({ sent: 1, retried: 0, failed: 0 })
    const r = await row(id!)
    expect(r.status).toBe('sent_unconfirmed')
    expect(r.externalId).toBeNull()
  })

  it('a row locked by another claim is skipped at once, not waited on (SKIP LOCKED, not plain FOR UPDATE)', async () => {
    const [locked, free] = await insert([one('locked'), one('free')])
    const holder = new Client({ connectionString: process.env.DATABASE_URL })
    await holder.connect()
    try {
      await holder.query('begin')
      await holder.query('select id from channel_deliveries where id = $1 for update', [locked])
      const outcome = await Promise.race([
        tick([locked!, free!], T0),
        new Promise<'blocked'>(r => setTimeout(() => r('blocked'), 2_000))
      ])
      expect(outcome).toEqual({ sent: 1, retried: 0, failed: 0 })
      expect(script.calls.map(c => c.id)).toEqual([free])
    }
    finally {
      await holder.query('rollback')
      await holder.end()
    }
    // Once released, the skipped row is claimable as normal.
    expect(await tick([locked!], T0)).toEqual({ sent: 1, retried: 0, failed: 0 })
  })

  it('two concurrent ticks send each row exactly once', async () => {
    const ids = await insert([one('a'), one('b'), one('c'), one('d'), one('e')])
    script.delayMs = 20
    const [r1, r2] = await Promise.all([tick(ids, T0), tick(ids, T0)])
    expect(r1.sent + r2.sent).toBe(5)
    expect(script.calls.map(c => c.id).sort()).toEqual([...ids].sort())
    const rows = await Promise.all(ids.map(row))
    expect(rows.every(r => r.status === 'sent')).toBe(true)
  })

  it('a retry hands the channel attempts: 1 so its duplicate check can run', async () => {
    const [id] = await insert([one()])
    script.next.push({ ok: false, error: 'timeout', retryable: true })
    await tick([id!], T0)
    await tick([id!], at(30_000))
    expect(script.calls.map(c => c.attempts)).toEqual([0, 1])
  })

  it('leaves rows outside onlyIds alone', async () => {
    const [mine, other] = await insert([one('mine'), one('other')])
    await tick([mine!], T0)
    expect((await row(other!)).status).toBe('pending')
    expect(script.calls.map(c => c.id)).toEqual([mine])
  })
})

// Reliability pass, Task 2: the outbox never blocks the worker tick. The tick is called in its
// scoped test form — `onlyConversations: []` recovers and pumps nothing, and the `deliveries`
// seam scopes the outbox to this file's 2100-dated rows.
describe('the worker tick and the outbox', () => {
  const workerTickFor = (ids: string[]) =>
    workerTick({ onlyConversations: [], deliveries: { onlyIds: ids, mainConversationId: scratchMain, now: T0 } })

  async function until(check: () => Promise<boolean> | boolean): Promise<void> {
    for (let i = 0; i < 200; i++) {
      if (await check()) return
      await new Promise(r => setTimeout(r, 10))
    }
    throw new Error('condition never met')
  }

  it('a slow send does not hold up the tick; a tick while one is in flight starts no second deliveriesTick', async () => {
    const [a] = await insert([one('slow a')])
    script.delayMs = 1_500
    const t0 = Date.now()
    expect(await workerTickFor([a!])).toBe(true)
    await until(() => script.calls.length === 1) // a's send is in flight
    expect(Date.now() - t0).toBeLessThan(1_000)
    expect((await row(a!)).status).toBe('sending')

    // A second tick runs (the tick is not held by the send) but finds the outbox busy: the row
    // queued since is not claimed, let alone sent, until the in-flight tick has finished.
    const [b] = await insert([one('queued b')])
    const t1 = Date.now()
    expect(await workerTickFor([a!, b!])).toBe(true)
    expect(Date.now() - t1).toBeLessThan(1_000)
    await _deliveriesSettled()
    expect((await row(a!)).status).toBe('sent')
    expect((await row(b!)).status).toBe('pending')
    expect(script.calls.map(c => c.id)).toEqual([a])

    // The guard is released: the next tick sends b.
    script.delayMs = 0
    expect(await workerTickFor([b!])).toBe(true)
    await _deliveriesSettled()
    expect((await row(b!)).status).toBe('sent')
  })

  it('claimed rows are sent concurrently and each one gets its own outcome', async () => {
    const [ok, retry, fail] = await insert([one('c ok'), one('c retry'), one('c fail')])
    script.byText = {
      'c retry': { ok: false, error: 'hiccup', retryable: true },
      'c fail': { ok: false, error: 'bad address', retryable: false }
    }
    script.delayMs = 600
    const t0 = Date.now()
    expect(await tick([ok!, retry!, fail!], T0)).toEqual({ sent: 1, retried: 1, failed: 1 })
    // One after another would take >= 1.8 s.
    expect(Date.now() - t0).toBeLessThan(1_500)
    expect(await row(ok!)).toMatchObject({ status: 'sent', attempts: 1, externalId: `ext-${ok}` })
    expect(await row(retry!)).toMatchObject({ status: 'pending', attempts: 1, lastError: 'hiccup' })
    expect(await row(fail!)).toMatchObject({ status: 'failed', attempts: 1, lastError: 'bad address' })
    expect((await notes()).map(n => n.content)).toEqual(["Couldn't deliver to iMessage: bad address"])
  })
})
