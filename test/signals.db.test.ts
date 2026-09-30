// DB-backed — harness pattern from test/jobs-reliability.db.test.ts / test/channels-inbound.db.test.ts.
//
// Cycle 76, Task 4: engagement signals on job messages (server/lib/agent/signals/write.ts) and the
// hooks that write them (queue.ts enqueue, channels/inbound.ts tapbacks). The dev DB is SHARED with
// real data and live dev servers, so:
//   - a SCRATCH conversation stands in for main: noteUserReply gets it through its
//     `mainConversationId` seam, and the read-only findMain is mocked to it for the enqueue hook
//     (which calls noteUserReply without the seam); getOrCreateMain is mocked to THROW (the signal
//     path must never create main) — nothing here ever reads or writes real main;
//   - the `signals_started_at` setting is passed through closeObservations' `startedAt` seam,
//     except in the one test of the key itself, which snapshots the real row and restores it;
//   - jobs are created DISABLED with slug prefix `sig-` (no real tick fires them); their runs are
//     inserted directly as `done` (never claimable), plus one permanent `running` INTERACTIVE
//     sentinel run in the scratch thread so no pump anywhere claims the one queued run the
//     enqueue test creates (alive_at 2100, so no live recoverStale interrupts it);
//   - job messages are backdated into separate days of the year 2000 per test, so one test's
//     reply window never covers another's messages; closeObservations is scoped with onlyJobIds;
//   - deliveries are `sent` with next_attempt_at in 2100 and a tagged external_id; the approval
//     row expires in 2100 (no live expiry touches it);
//   - afterAll deletes by collected ids / the `sig-` prefix and re-counts.
process.loadEnvFile('.env')

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

const ALLOWED = '+15557654321'
const CHAT = `iMessage;-;${ALLOWED}`
const holder = vi.hoisted(() => ({ mainId: '', noMain: false }))

vi.mock('../server/lib/channels/config', async (orig) => {
  const actual = await orig<typeof import('../server/lib/channels/config')>()
  return {
    ...actual,
    loadChannelsConfig: async () => ({
      imessage: { enabled: true, serverUrl: '', passwordEnc: null, webhookToken: 'x', allowedHandles: ['+15557654321'], defaultHandle: '+15557654321', defaultChatGuid: null },
      email: { enabled: false, to: null },
      presenceAwayMinutes: 10
    })
  }
})
vi.mock('../server/lib/agent/signals/write', async (orig) => {
  const actual = await orig<typeof import('../server/lib/agent/signals/write')>()
  return { ...actual, openObservation: vi.fn(actual.openObservation), noteTapback: vi.fn(actual.noteTapback) }
})
vi.mock('../server/lib/agent/runtime/sessions', async (orig) => {
  const actual = await orig<typeof import('../server/lib/agent/runtime/sessions')>()
  return {
    ...actual,
    findMain: async () => {
      if (holder.noMain) return null
      if (!holder.mainId) throw new Error('test reached findMain before the scratch main existed')
      return holder.mainId
    },
    getOrCreateMain: async () => { throw new Error('the signal path must never create main') }
  }
})

import { and, eq, inArray, like } from 'drizzle-orm'
import { useDb } from '../server/db'
import {
  agentConfigRevisions, agentJobs, agentRuns, agentSignals, channelApprovals, channelDeliveries, conversationMessages, conversations,
  settings, type AgentRun
} from '../server/db/schema'
import { createConversation } from '../server/services/conversations'
import { createJob } from '../server/lib/agent/jobs/store'
import { enqueue } from '../server/lib/agent/runtime/queue'
import { handleInbound } from '../server/lib/channels/inbound'
import type { TapbackEvent } from '../server/lib/channels/types'
import { OBSERVATION_WINDOW_MS } from '../server/lib/agent/signals/classify'
import { closeObservations, noteTapback, noteUserReply, openObservation, SIGNALS_STARTED_AT_KEY, CLOSE_LOOKBACK_MS } from '../server/lib/agent/signals/write'
import { onRunFinished } from '../server/lib/agent/jobs/outcome'

const db = () => useDb()
const PREFIX = 'sig-'
const TAG = `${PREFIX}${Date.now().toString(36)}-`
const FAR_FUTURE = new Date('2100-01-01T00:00:00Z')
const HOUR = 60 * 60 * 1000
const md = (fm: string, body: string) => `---\n${fm}\n---\n${body}\n`

let scratchMain = ''
let other = ''
const convIds: string[] = []
const deliveryIds: string[] = []
const approvalIds: string[] = []
let jobA = ''
let jobB = ''
let jobC = ''
let jobD = ''
let jobE = ''
let seq = 0

/** One day of the year 2000 per test: windows of different tests never overlap. */
const day = (n: number) => new Date(Date.UTC(2000, 0, n, 12))

async function cleanupJobs() {
  const rows = await db().select({ id: agentJobs.id }).from(agentJobs).where(like(agentJobs.slug, `${TAG}%`))
  if (!rows.length) return
  const ids = rows.map(r => r.id)
  await db().delete(agentSignals).where(inArray(agentSignals.jobId, ids))
  await db().delete(agentRuns).where(inArray(agentRuns.jobId, ids))
  await db().delete(agentConfigRevisions).where(and(eq(agentConfigRevisions.targetKind, 'job'), inArray(agentConfigRevisions.targetId, ids)))
  await db().delete(agentJobs).where(inArray(agentJobs.id, ids))
}

beforeAll(async () => {
  for (const t of ['main', 'other']) convIds.push((await createConversation({ title: `${TAG}${t}` })).id)
  ;[scratchMain, other] = convIds as [string, string]
  holder.mainId = scratchMain
  await db().insert(agentRuns).values({
    conversationId: scratchMain, sessionKey: `thread:${scratchMain}`, trigger: 'user', profile: 'interactive',
    status: 'running', aliveAt: FAR_FUTURE, input: { text: 'sentinel', modality: 'text' }
  })
  jobA = (await createJob({ slug: `${TAG}a`, content: md('trigger: every 30m', 'A.'), actor: 'human' })).id
  jobB = (await createJob({ slug: `${TAG}b`, content: md('trigger: every 30m', 'B.'), actor: 'human' })).id
  jobC = (await createJob({ slug: `${TAG}c`, content: md('trigger: every 30m', 'C.'), actor: 'human' })).id
  jobD = (await createJob({ slug: `${TAG}d`, content: md('trigger: every 30m', 'D.'), actor: 'human' })).id
  jobE = (await createJob({ slug: `${TAG}e`, content: md('trigger: every 30m', 'E.'), actor: 'human' })).id
})

afterAll(async () => {
  const msgIds = (await db().select({ id: conversationMessages.id }).from(conversationMessages)
    .where(inArray(conversationMessages.conversationId, convIds))).map(r => r.id)
  if (msgIds.length) await db().delete(agentSignals).where(inArray(agentSignals.messageId, msgIds))
  if (approvalIds.length) await db().delete(channelApprovals).where(inArray(channelApprovals.id, approvalIds))
  if (deliveryIds.length) await db().delete(channelDeliveries).where(inArray(channelDeliveries.id, deliveryIds))
  await db().delete(agentRuns).where(inArray(agentRuns.conversationId, convIds))
  await cleanupJobs()
  await db().delete(conversationMessages).where(inArray(conversationMessages.conversationId, convIds))
  await db().delete(conversations).where(inArray(conversations.id, convIds))
  // Nothing of ours is left behind.
  expect(await db().select({ id: conversations.id }).from(conversations).where(like(conversations.title, `${TAG}%`))).toHaveLength(0)
  expect(await db().select({ id: agentJobs.id }).from(agentJobs).where(like(agentJobs.slug, `${TAG}%`))).toHaveLength(0)
  if (msgIds.length) expect(await db().select({ id: agentSignals.id }).from(agentSignals).where(inArray(agentSignals.messageId, msgIds))).toHaveLength(0)
})

/** A job run that spoke: a `done` run + its assistant message at `at`, in `conversationId`. */
async function jobMessage(jobId: string, at: Date, conversationId = scratchMain) {
  const [m] = await db().insert(conversationMessages).values({
    conversationId, role: 'assistant', content: `${TAG}job says ${++seq}`, modality: 'text', origin: 'wake:job', createdAt: at
  }).returning({ id: conversationMessages.id })
  const [r] = await db().insert(agentRuns).values({
    conversationId, sessionKey: `thread:${conversationId}`, trigger: 'wake', profile: 'headless', status: 'done',
    input: { text: 'x', modality: 'text' }, jobId, assistantMessageId: m!.id, finishedAt: at
  }).returning({ id: agentRuns.id })
  return { messageId: m!.id, runId: r!.id }
}

async function signalsFor(messageId: string) {
  return db().select().from(agentSignals).where(eq(agentSignals.messageId, messageId))
}
const kindsFor = async (messageId: string) => (await signalsFor(messageId)).map(s => s.kind).sort()

const reply = (text: string, at: Date) => noteUserReply({ conversationId: scratchMain, text, at }, { mainConversationId: scratchMain })

async function jobDelivery(jobId: string, m: { messageId: string; runId: string }) {
  const externalId = `${TAG}bb-${++seq}`
  const [d] = await db().insert(channelDeliveries).values({
    channel: 'imessage', target: CHAT, conversationId: scratchMain, messageId: m.messageId, jobId, runId: m.runId,
    source: 'job', payload: { text: 'job text' }, status: 'sent', nextAttemptAt: FAR_FUTURE, externalId, sentAt: new Date()
  }).returning({ id: channelDeliveries.id })
  deliveryIds.push(d!.id)
  return { id: d!.id, externalId }
}

const tapback = (targetGuid: string, over: Partial<TapbackEvent> = {}): TapbackEvent => ({
  kind: 'tapback', guid: `${TAG}tb-${++seq}`, chatGuid: CHAT, sender: ALLOWED, targetGuid, tapback: 'love', removed: false, isFromMe: false, ...over
})

describe('noteUserReply', () => {
  it('a reply within the window → replied, with the reply text as detail', async () => {
    const m = await jobMessage(jobA, day(1))
    expect(await reply('ok, noted', new Date(day(1).getTime() + 90 * 60 * 1000))).toBe(1)
    const [s] = await signalsFor(m.messageId)
    expect(s).toMatchObject({ kind: 'replied', jobId: jobA, runId: m.runId, detail: 'ok, noted' })
  })

  it('a reply after 3 h → nothing', async () => {
    const m = await jobMessage(jobA, day(2))
    expect(await reply('late', new Date(day(2).getTime() + 3 * HOUR))).toBe(0)
    expect(await signalsFor(m.messageId)).toHaveLength(0)
  })

  it('a reply at exactly the window edge still counts; a reply before the message does not', async () => {
    const m = await jobMessage(jobA, day(3))
    expect(await reply('before', new Date(day(3).getTime() - 60_000))).toBe(0)
    expect(await reply('edge', new Date(day(3).getTime() + OBSERVATION_WINDOW_MS))).toBe(1)
    expect(await kindsFor(m.messageId)).toEqual(['replied'])
  })

  it('two replies → a single replied, keeping the first reply as detail', async () => {
    const m = await jobMessage(jobA, day(4))
    expect(await reply('one', new Date(day(4).getTime() + 10 * 60 * 1000))).toBe(1)
    expect(await reply('two', new Date(day(4).getTime() + 20 * 60 * 1000))).toBe(0)
    const rows = await signalsFor(m.messageId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'replied', detail: 'one' })
  })

  it('a later stop or thanks still counts after the message was already replied to, once per kind', async () => {
    const m = await jobMessage(jobA, day(9))
    expect(await reply('ok', new Date(day(9).getTime() + 10 * 60 * 1000))).toBe(1)
    expect(await reply('actually, stop sending these', new Date(day(9).getTime() + 20 * 60 * 1000))).toBe(1)
    expect(await reply('stop. thanks though', new Date(day(9).getTime() + 30 * 60 * 1000))).toBe(1)
    expect(await kindsFor(m.messageId)).toEqual(['replied', 'said_stop', 'said_thanks'])
    const stop = (await signalsFor(m.messageId)).find(r => r.kind === 'said_stop')
    expect(stop!.detail).toBe('actually, stop sending these')
  })

  it('a negated stop word → replied only', async () => {
    const m = await jobMessage(jobA, day(14))
    expect(await reply("don't stop, these are great", new Date(day(14).getTime() + 60_000))).toBe(1)
    expect(await kindsFor(m.messageId)).toEqual(['replied'])
  })

  it('with no main conversation yet → nothing, and main is never created', async () => {
    const m = await jobMessage(jobA, day(15))
    holder.noMain = true
    try {
      expect(await noteUserReply({ conversationId: scratchMain, text: 'hi', at: new Date(day(15).getTime() + 60_000) })).toBe(0)
    } finally {
      holder.noMain = false
    }
    expect(await signalsFor(m.messageId)).toHaveLength(0)
  })

  it('a stop phrase → both replied and said_stop', async () => {
    const m = await jobMessage(jobA, day(5))
    expect(await reply('please stop sending these', new Date(day(5).getTime() + 5 * 60 * 1000))).toBe(2)
    expect(await kindsFor(m.messageId)).toEqual(['replied', 'said_stop'])
  })

  it('every job message still in its window is marked, from different jobs', async () => {
    const a = await jobMessage(jobA, day(6))
    const b = await jobMessage(jobB, new Date(day(6).getTime() + 30 * 60 * 1000))
    expect(await reply('thanks', new Date(day(6).getTime() + HOUR))).toBe(4)
    expect(await kindsFor(a.messageId)).toEqual(['replied', 'said_thanks'])
    expect(await kindsFor(b.messageId)).toEqual(['replied', 'said_thanks'])
    expect((await signalsFor(b.messageId))[0]!.jobId).toBe(jobB)
  })

  it('a reply in a thread that is not main → nothing, and a job message outside main is never marked', async () => {
    const inMain = await jobMessage(jobA, day(7))
    const inOther = await jobMessage(jobA, day(7), other)
    expect(await noteUserReply({ conversationId: other, text: 'hi', at: new Date(day(7).getTime() + 60_000) }, { mainConversationId: scratchMain })).toBe(0)
    expect(await signalsFor(inMain.messageId)).toHaveLength(0)
    expect(await reply('hi', new Date(day(7).getTime() + 60_000))).toBe(1)
    expect(await signalsFor(inOther.messageId)).toHaveLength(0)
  })

  it('only runs from the last 14 days are scanned (final review m6)', async () => {
    const m = await jobMessage(jobA, day(18))
    // A run row older than 14 days: outside the scan even though its message is in the window.
    await db().update(agentRuns).set({ createdAt: new Date(day(18).getTime() - 15 * 24 * HOUR) }).where(eq(agentRuns.id, m.runId))
    expect(await reply('seen it', new Date(day(18).getTime() + HOUR))).toBe(0)
    expect(await signalsFor(m.messageId)).toHaveLength(0)
    // The same message with a run inside the 14 days is marked.
    await db().update(agentRuns).set({ createdAt: day(18) }).where(eq(agentRuns.id, m.runId))
    expect(await reply('seen it', new Date(day(18).getTime() + HOUR))).toBe(1)
  })

  it('an assistant message of a non-job run is never marked', async () => {
    const [m] = await db().insert(conversationMessages).values({
      conversationId: scratchMain, role: 'assistant', content: `${TAG}chat`, modality: 'text', createdAt: day(8)
    }).returning({ id: conversationMessages.id })
    await db().insert(agentRuns).values({
      conversationId: scratchMain, sessionKey: `thread:${scratchMain}`, trigger: 'user', profile: 'interactive', status: 'done',
      input: { text: 'x', modality: 'text' }, assistantMessageId: m!.id
    })
    expect(await reply('thanks', new Date(day(8).getTime() + 60_000))).toBe(0)
    expect(await signalsFor(m!.id)).toHaveLength(0)
  })
})

describe('enqueue → noteUserReply (fire-and-forget)', () => {
  it('a user message steered into main marks the job message', async () => {
    const m = await jobMessage(jobC, new Date(Date.now() - 10 * 60 * 1000))
    const r = await enqueue(
      { sessionKey: `thread:${scratchMain}`, trigger: 'user', profile: 'interactive', input: { text: 'thanks!', modality: 'text' } },
      { kick: false, pushSteer: async () => true }
    )
    expect(r.steered).toBe(true)
    await vi.waitFor(async () => expect(await kindsFor(m.messageId)).toEqual(['replied', 'said_thanks']), { timeout: 3000, interval: 50 })
  })

  it('a user message queued as its own run in main marks the job message too', async () => {
    const m = await jobMessage(jobC, new Date(Date.now() - 5 * 60 * 1000))
    // Non-plain (an attachment) never steers: it queues behind the sentinel as its own run.
    const r = await enqueue(
      { sessionKey: `thread:${scratchMain}`, trigger: 'user', profile: 'interactive', input: { text: 'ok', modality: 'text', attachments: [{ id: '00000000-0000-0000-0000-000000000000', kind: 'image', mime: 'image/png' }] } },
      { kick: false }
    )
    expect(r.steered).toBe(false)
    await vi.waitFor(async () => expect(await kindsFor(m.messageId)).toEqual(['replied']), { timeout: 3000, interval: 50 })
  })

  it('a wake enqueue is not a reply', async () => {
    const m = await jobMessage(jobC, new Date(Date.now() - 60_000))
    await enqueue(
      { sessionKey: `thread:${scratchMain}`, trigger: 'wake', profile: 'headless', input: { text: 'tick', modality: 'text' } },
      { kick: false }
    )
    await new Promise(r => setTimeout(r, 300))
    expect(await signalsFor(m.messageId)).toHaveLength(0)
  })
})

describe('tapbacks', () => {
  it('a tapback on a job delivery (through the inbound pipeline) → tapback_positive', async () => {
    const m = await jobMessage(jobB, day(10))
    const d = await jobDelivery(jobB, m)
    expect(await handleInbound(tapback(d.externalId, { tapback: 'laugh' }))).toBe('tapback')
    // Fire-and-forget: handleInbound returns before the signal lands.
    await vi.waitFor(async () => expect(await signalsFor(m.messageId)).toHaveLength(1), { timeout: 3000, interval: 50 })
    const [s] = await signalsFor(m.messageId)
    expect(s).toMatchObject({ kind: 'tapback_positive', jobId: jobB, runId: m.runId, deliveryId: d.id, detail: 'laugh' })
  })

  it('the webhook never waits on the tapback signal', async () => {
    vi.mocked(noteTapback).mockImplementationOnce(() => new Promise<boolean>(() => {})) // never settles
    const out = await Promise.race([
      handleInbound(tapback(`${TAG}hang`)),
      new Promise(r => setTimeout(() => r('handleInbound waited on noteTapback'), 1000))
    ])
    expect(out).toBe('tapback')
    expect(noteTapback).toHaveBeenCalled()
  })

  it('dislike → tapback_negative; question, removed and own tapbacks → nothing', async () => {
    const m = await jobMessage(jobB, day(11))
    const d = await jobDelivery(jobB, m)
    expect(await noteTapback(tapback(d.externalId, { tapback: 'question' }))).toBe(false)
    expect(await noteTapback(tapback(d.externalId, { removed: true }))).toBe(false)
    expect(await noteTapback(tapback(d.externalId, { isFromMe: true }))).toBe(false)
    expect(await signalsFor(m.messageId)).toHaveLength(0)
    expect(await noteTapback(tapback(d.externalId, { tapback: 'dislike' }))).toBe(true)
    expect(await noteTapback(tapback(d.externalId, { tapback: 'dislike' }))).toBe(false) // one per kind
    expect(await kindsFor(m.messageId)).toEqual(['tapback_negative'])
  })

  it("a stranger's tapback, a group chat's and one from a chat that isn't the sender's own → nothing", async () => {
    const m = await jobMessage(jobB, day(16))
    const d = await jobDelivery(jobB, m)
    const STRANGER = '+15550000001'
    expect(await noteTapback(tapback(d.externalId, { sender: STRANGER, chatGuid: `iMessage;-;${STRANGER}` }))).toBe(false)
    expect(await noteTapback(tapback(d.externalId, { chatGuid: 'iMessage;+;chat123456' }))).toBe(false)
    expect(await noteTapback(tapback(d.externalId, { chatGuid: `iMessage;-;${STRANGER}` }))).toBe(false)
    // Through the pipeline too (a stranger's tapback isn't an approval either).
    expect(await handleInbound(tapback(d.externalId, { sender: STRANGER, chatGuid: `iMessage;-;${STRANGER}` }))).toBe('tapback')
    await new Promise(r => setTimeout(r, 300))
    expect(await signalsFor(m.messageId)).toHaveLength(0)
    // The allowed sender in their own chat does count.
    expect(await noteTapback(tapback(d.externalId))).toBe(true)
  })

  it('a tapback on a message that is no job delivery → nothing', async () => {
    expect(await noteTapback(tapback(`${TAG}not-a-delivery`))).toBe(false)
    // An ordinary reply's delivery (no job) is not a job message either.
    const m = await jobMessage(jobB, day(13))
    const d = await jobDelivery(jobB, m)
    await db().update(channelDeliveries).set({ jobId: null, source: 'reply' }).where(eq(channelDeliveries.id, d.id))
    expect(await noteTapback(tapback(d.externalId))).toBe(false)
    expect(await signalsFor(m.messageId)).toHaveLength(0)
  })

  it('an approval tapback is not double-counted', async () => {
    const m = await jobMessage(jobB, day(12))
    const d = await jobDelivery(jobB, m)
    // An approval prompt sharing the delivery's GUID: only the approval may take the tapback.
    const [a] = await db().insert(channelApprovals).values({
      runId: m.runId, request: { command: 'ls' }, chatGuid: CHAT, promptGuid: d.externalId, status: 'pending', expiresAt: FAR_FUTURE
    }).returning({ id: channelApprovals.id })
    approvalIds.push(a!.id)
    expect(await handleInbound(tapback(d.externalId, { tapback: 'like' }))).toBe('tapback')
    const [row] = await db().select({ status: channelApprovals.status }).from(channelApprovals).where(eq(channelApprovals.id, a!.id))
    expect(row!.status).toBe('approved')
    await new Promise(r => setTimeout(r, 300)) // a (wrongly) fired-and-forgotten noteTapback would land by now
    expect(await signalsFor(m.messageId)).toHaveLength(0)
  })
})

describe('closeObservations', () => {
  it('writes ignored for a silent job message and skips one that already has a signal or is still open', async () => {
    const now = day(20)
    const silent = await jobMessage(jobC, new Date(now.getTime() - 3 * HOUR))
    const answered = await jobMessage(jobC, new Date(now.getTime() - 4 * HOUR))
    const d = await jobDelivery(jobC, answered)
    expect(await noteTapback(tapback(d.externalId))).toBe(true)
    const open = await jobMessage(jobC, new Date(now.getTime() - HOUR))
    const otherJob = await jobMessage(jobA, new Date(now.getTime() - 3 * HOUR))

    const n = await closeObservations(now, { onlyJobIds: [jobC], startedAt: day(1) })
    expect(await kindsFor(silent.messageId)).toEqual(['ignored'])
    expect(await kindsFor(answered.messageId)).toEqual(['tapback_positive'])
    expect(await signalsFor(open.messageId)).toHaveLength(0)
    expect(await signalsFor(otherJob.messageId)).toHaveLength(0) // outside onlyJobIds
    // jobC's earlier enqueue-test messages are real-clock (not yet closed at a year-2000 `now`).
    expect(n).toBe(1)
    expect(await closeObservations(now, { onlyJobIds: [jobC], startedAt: day(1) })).toBe(0) // idempotent
  })

  it('never judges a message from before signals started, nor one older than 14 days', async () => {
    const now = day(28)
    const startedAt = new Date(now.getTime() - 5 * HOUR)
    const beforeStart = await jobMessage(jobD, new Date(now.getTime() - 6 * HOUR))
    const afterStart = await jobMessage(jobD, new Date(now.getTime() - 3 * HOUR))
    expect(await closeObservations(now, { onlyJobIds: [jobD], startedAt })).toBe(1)
    expect(await signalsFor(beforeStart.messageId)).toHaveLength(0)
    expect(await kindsFor(afterStart.messageId)).toEqual(['ignored'])

    // Signals started long ago: the 14-day lookback is the bound.
    const later = new Date(now.getTime() + 30 * 24 * HOUR)
    const tooOld = await jobMessage(jobD, new Date(later.getTime() - CLOSE_LOOKBACK_MS - HOUR))
    const recent = await jobMessage(jobD, new Date(later.getTime() - CLOSE_LOOKBACK_MS + HOUR))
    expect(await closeObservations(later, { onlyJobIds: [jobD], startedAt: day(1) })).toBe(1)
    expect(await signalsFor(tooOld.messageId)).toHaveLength(0)
    expect(await kindsFor(recent.messageId)).toEqual(['ignored'])
  })

  it('the first call writes signals_started_at = now and later calls keep it (real key, restored)', async () => {
    const [snapshot] = await db().select().from(settings).where(eq(settings.key, SIGNALS_STARTED_AT_KEY))
    try {
      await db().delete(settings).where(eq(settings.key, SIGNALS_STARTED_AT_KEY))
      const first = new Date(Date.UTC(2001, 0, 1, 12))
      const old = await jobMessage(jobE, new Date(first.getTime() - 3 * HOUR))
      expect(await closeObservations(first, { onlyJobIds: [jobE] })).toBe(0)
      expect(await signalsFor(old.messageId)).toHaveLength(0) // before signals started
      const [row] = await db().select().from(settings).where(eq(settings.key, SIGNALS_STARTED_AT_KEY))
      expect(row!.value).toBe(first.toISOString())

      const second = new Date(first.getTime() + 10 * HOUR)
      const fresh = await jobMessage(jobE, new Date(first.getTime() + HOUR))
      expect(await closeObservations(second, { onlyJobIds: [jobE] })).toBe(1)
      expect(await kindsFor(fresh.messageId)).toEqual(['ignored'])
      expect(await signalsFor(old.messageId)).toHaveLength(0)
      const [again] = await db().select().from(settings).where(eq(settings.key, SIGNALS_STARTED_AT_KEY))
      expect(again!.value).toBe(first.toISOString()) // not moved by the second call
    } finally {
      await db().delete(settings).where(eq(settings.key, SIGNALS_STARTED_AT_KEY))
      if (snapshot) await db().insert(settings).values(snapshot)
    }
  })

  it('an empty onlyJobIds closes nothing', async () => {
    expect(await closeObservations(new Date(), { onlyJobIds: [] })).toBe(0)
  })
})

describe('openObservation', () => {
  it('onRunFinished opens it for a job run that spoke, and only for that', async () => {
    const m = await jobMessage(jobA, day(26))
    const [run] = await db().select().from(agentRuns).where(eq(agentRuns.id, m.runId)) as AgentRun[]
    const spy = vi.mocked(openObservation)
    spy.mockClear()
    await onRunFinished({ ...run!, assistantMessageId: null }, { status: 'done', suppressed: true, assistantMessageId: m.messageId }, { mainConversationId: scratchMain })
    await onRunFinished({ ...run!, assistantMessageId: null }, { status: 'failed', error: 'x', assistantMessageId: m.messageId }, { mainConversationId: scratchMain })
    expect(spy).not.toHaveBeenCalled()
    await onRunFinished({ ...run!, assistantMessageId: null }, { status: 'done', assistantMessageId: m.messageId }, { mainConversationId: scratchMain })
    expect(spy).toHaveBeenCalledWith({ id: m.runId, jobId: jobA, assistantMessageId: m.messageId })
  })

  it('records nothing', async () => {
    const m = await jobMessage(jobA, day(25))
    await openObservation({ id: m.runId, jobId: jobA, assistantMessageId: m.messageId })
    await openObservation({ id: m.runId, jobId: null, assistantMessageId: m.messageId })
    expect(await signalsFor(m.messageId)).toHaveLength(0)
  })
})
