// DB-backed — harness pattern from test/jobs-tick.db.test.ts / test/channels-outbox.db.test.ts.
//
// Cycle 75, Task 7: the inbound iMessage pipeline (server/lib/channels/inbound.ts). The dev DB is
// SHARED with live dev servers in other checkouts and holds real data, so:
//   - nothing is ever enqueued on the real main: the fake enqueue creates REAL agent_runs rows in
//     a SCRATCH conversation holding a permanent `running` INTERACTIVE sentinel run (claimNextRun
//     never claims a queued run of a conversation with one running, so no pump anywhere executes
//     them; its alive_at is in 2100 so no live recoverStale ever interrupts it); the real-enqueue
//     tests use `kick: false` and the `mainConversationId` seam, and always delete their queued
//     runs BEFORE the busy run stops running;
//   - every inbound GUID is prefixed `chin-` and deleted in afterAll;
//   - BlueBubbles is the in-process fake; STT is an injected stub (the real chain is never called);
//   - images land in a temp storage dir (removed after); their rows are hard-deleted by name
//     prefix `chin-`;
//   - the unknown-sender warning goes through a recorder with a DB sink but NO email notifier;
//     its activity rows are deleted by id;
//   - delivery rows for the confirmation tests live in the year 2100 and are passed by id, with
//     `now` from then — a real worker's catch-up (real clock) never finds them old enough to touch.
process.loadEnvFile('.env')

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'

const STORE = mkdtempSync(join(tmpdir(), 'chin-store-'))
vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL, storageDriver: 'local', storageLocalDir: STORE }))

const ALLOWED = '+15551234567'
const CHAT = `iMessage;-;${ALLOWED}`
const captured = vi.hoisted(() => ({ activityIds: [] as string[], flush: null as null | (() => Promise<void>) }))

vi.mock('../server/lib/channels/config', async (orig) => {
  const actual = await orig<typeof import('../server/lib/channels/config')>()
  return {
    ...actual,
    loadChannelsConfig: async () => ({
      imessage: { enabled: true, serverUrl: '', passwordEnc: null, webhookToken: 'x', allowedHandles: ['+15551234567'], defaultHandle: '+15551234567', defaultChatGuid: null },
      email: { enabled: false, to: null },
      presenceAwayMinutes: 10
    })
  }
})
// The real row builder, a DB sink, and no notifier (a warn row must never trigger an alert email).
vi.mock('../server/lib/observability/record', async (orig) => {
  const actual = await orig<typeof import('../server/lib/observability/record')>()
  const { useDb } = await import('../server/db')
  const { activityLog } = await import('../server/db/schema')
  const rec = actual.createRecorder({
    sink: async (rows) => {
      await useDb().insert(activityLog).values(rows)
      captured.activityIds.push(...rows.map(r => r.id!))
    }
  })
  captured.flush = rec.flush
  return { ...actual, recordEvent: rec.recordEvent, withSpan: rec.withSpan }
})

import { and, eq, inArray, like } from 'drizzle-orm'
import { useDb } from '../server/db'
import { activityLog, agentInbox, agentRuns, channelDeliveries, channelInbound, conversationMessages, conversations, images } from '../server/db/schema'
import { storage } from '../server/utils/storage'
import { createConversation } from '../server/services/conversations'
import { createRun } from '../server/lib/agent/runtime/runs'
import { enqueue, type EnqueueRequest } from '../server/lib/agent/runtime/queue'
import { blueBubblesClient, type BlueBubblesClient } from '../server/lib/channels/bluebubbles/client'
import { parseWebhook } from '../server/lib/channels/bluebubbles/parse'
import { handleInbound, catchUpTick, lastHealth, _resetCatchUp, type InboundDeps } from '../server/lib/channels/inbound'
import type { InboundMessage } from '../server/lib/channels/types'
import { startFakeBlueBubbles, type FakeBlueBubbles } from './fixtures/fake-bluebubbles'
import emoji from './fixtures/bluebubbles/emoji-reaction.json'

const db = () => useDb()
const TAG = `chin-${Date.now().toString(36)}-`
let seq = 0
const FAR_FUTURE = new Date('2100-01-01T00:00:00Z')
const guid = (label: string) => `${TAG}${label}-${++seq}`

const ATTACHMENTS = {
  'chin-att-photo': { mime: 'image/png', name: 'chin-photo.png' },
  'chin-att-voice': { mime: 'audio/x-caf', name: 'Audio Message.caf' }
}

let fake: FakeBlueBubbles
let heicFake: FakeBlueBubbles
let bb: BlueBubblesClient
let scratch = ''     // "main" for the fake enqueue (sentinel-guarded)
let scratchReal = '' // "main" for the real enqueue (holds a running run per test)
const convIds: string[] = []
const deliveryIds: string[] = []

beforeAll(async () => {
  fake = await startFakeBlueBubbles({ privateApi: false, attachmentTypes: ATTACHMENTS })
  heicFake = await startFakeBlueBubbles({ heicAttachments: true, attachmentTypes: ATTACHMENTS })
  bb = blueBubblesClient({ serverUrl: fake.url, password: fake.password })
  for (let i = 0; i < 2; i++) convIds.push((await createConversation({ title: `${TAG}scratch-${i}` })).id)
  ;[scratch, scratchReal] = convIds as [string, string]
  await db().insert(agentRuns).values({
    conversationId: scratch, sessionKey: `thread:${scratch}`, trigger: 'user', profile: 'interactive',
    // alive_at in 2100: a live dev server's recoverStale (60 s staleness) never interrupts it,
    // so the queued runs behind it are never claimable for as long as the file runs.
    status: 'running', aliveAt: FAR_FUTURE, input: { text: 'sentinel', modality: 'text' }
  })
})

afterAll(async () => {
  await fake?.close()
  await heicFake?.close()
  await db().delete(channelInbound).where(like(channelInbound.guid, 'chin-%'))
  if (deliveryIds.length) await db().delete(channelDeliveries).where(inArray(channelDeliveries.id, deliveryIds))
  await db().delete(agentRuns).where(inArray(agentRuns.conversationId, convIds)) // agent_inbox cascades
  await db().delete(conversationMessages).where(inArray(conversationMessages.conversationId, convIds))
  await db().delete(conversations).where(inArray(conversations.id, convIds))
  const imgs = await db().delete(images).where(like(images.originalName, 'chin-%')).returning({ storageKey: images.storageKey })
  for (const i of imgs) await storage().delete(i.storageKey).catch(() => {})
  if (captured.activityIds.length) await db().delete(activityLog).where(inArray(activityLog.id, captured.activityIds))
  rmSync(STORE, { recursive: true, force: true })
  console.info(`[chin] cleanup: ${imgs.length} image rows + storage objects, ${captured.activityIds.length} activity rows`)
})

// The fake enqueue: records the request; creates a real queued (never claimable) run carrying
// the request's reply_to.
const calls: EnqueueRequest[] = []
let enqueueThrows = false
const fakeEnqueue = (async (req: EnqueueRequest) => {
  calls.push(structuredClone(req))
  if (enqueueThrows) throw new Error('enqueue exploded')
  const run = await createRun({
    conversationId: scratch, sessionKey: `thread:${scratch}`, trigger: req.trigger, profile: req.profile,
    input: req.input, replyTo: req.replyTo ?? null
  })
  return { runId: run.id, conversationId: scratch, steered: false, created: false, queuedBehind: true }
}) as typeof enqueue

const transcribe = vi.fn(async (_a: Uint8Array, _o: { mime: string; filename: string }) => 'buy milk')
const deps = (extra: Partial<InboundDeps> = {}): InboundDeps => ({ enqueueFn: fakeEnqueue, client: bb, mainConversationId: scratch, transcribe, ...extra })

function msg(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    kind: 'message', guid: guid('m'), chatGuid: CHAT, sender: ALLOWED, text: 'hey bridget', attachments: [],
    date: new Date(1790000000000), isFromMe: false, isGroup: false, ...over
  }
}

async function inboundRow(g: string) {
  const [row] = await db().select().from(channelInbound).where(eq(channelInbound.guid, g))
  return row
}

beforeEach(() => {
  calls.length = 0
  enqueueThrows = false
  transcribe.mockReset()
  transcribe.mockResolvedValue('buy milk')
})

describe('handleInbound', () => {
  it('an allowed text is enqueued on main with origin imessage:<chat> and replyTo, and records the GUID → run', async () => {
    const m = msg()
    expect(await handleInbound(m, deps())).toBe('enqueued')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      sessionKey: `thread:${scratch}`, trigger: 'user', profile: 'interactive',
      input: { text: 'hey bridget', modality: 'text', origin: `imessage:${CHAT}` },
      replyTo: { channel: 'imessage', chatGuid: CHAT, messageGuid: m.guid }
    })
    const row = await inboundRow(m.guid)
    expect(row).toMatchObject({ channel: 'imessage', sender: ALLOWED })
    expect(row!.receivedAt.getTime()).toBe(m.date.getTime())
    const [run] = await db().select().from(agentRuns).where(eq(agentRuns.id, row!.runId!))
    expect(run!.replyTo).toEqual({ channel: 'imessage', chatGuid: CHAT, messageGuid: m.guid })
  })

  it('without the seam it targets session `main`', async () => {
    const m = msg()
    await handleInbound(m, deps({ mainConversationId: undefined }))
    expect(calls[0]!.sessionKey).toBe('main')
  })

  it('the same GUID twice: the second is a duplicate and enqueue ran once', async () => {
    const m = msg()
    expect(await handleInbound(m, deps())).toBe('enqueued')
    expect(await handleInbound(m, deps())).toBe('duplicate')
    expect(calls).toHaveLength(1)
  })

  it('a message already taken is a duplicate BEFORE any download or transcription', async () => {
    const m = msg({ text: '', attachments: [{ guid: 'chin-att-voice', mime: 'audio/x-caf', name: 'Audio Message.caf' }] })
    expect(await handleInbound(m, deps())).toBe('enqueued')
    expect(await handleInbound(m, deps())).toBe('duplicate')
    expect(transcribe).toHaveBeenCalledTimes(1)
  })

  it('webhook and catch-up at the same moment: exactly one enqueued', async () => {
    const m = msg({ attachments: [{ guid: 'chin-att-photo', mime: 'image/heic', name: 'IMG_1.HEIC' }] })
    const outcomes = await Promise.all([handleInbound(m, deps()), handleInbound(m, deps())])
    expect(outcomes.sort()).toEqual(['duplicate', 'enqueued'])
    expect(calls).toHaveLength(1)
    // Whichever lost the insert soft-deleted the photo it had already stored.
    const kept = calls[0]!.input.attachments![0]!.id
    const rows = await db().select().from(images).where(like(images.originalName, 'chin-%'))
    const live = rows.filter(r => !r.deletedAt).map(r => r.id)
    expect(live).toContain(kept)
  })

  it('group chat → ignored:group; from-me → ignored:from-me; nothing enqueued', async () => {
    expect(await handleInbound(msg({ isGroup: true, chatGuid: 'iMessage;+;chat123' }), deps())).toBe('ignored:group')
    expect(await handleInbound(msg({ isFromMe: true }), deps())).toBe('ignored:from-me')
    expect(calls).toHaveLength(0)
  })

  it('an iOS 18 emoji reaction (non-tapback association) is never a turn', async () => {
    const ev = parseWebhook(emoji).event as InboundMessage
    expect(await handleInbound({ ...ev, guid: guid('emoji') }, deps())).toBe('ignored:reaction')
    expect(calls).toHaveLength(0)
  })

  it('a tapback goes to approvals, never a turn', async () => {
    const out = await handleInbound({ kind: 'tapback', guid: guid('tb'), chatGuid: CHAT, sender: ALLOWED, targetGuid: 'X', tapback: 'like', removed: false, isFromMe: false }, deps())
    expect(out).toBe('tapback')
    expect(calls).toHaveLength(0)
  })

  it('an unknown sender → ignored:sender + ONE activity warn whose meta holds the masked handle, never the raw one', async () => {
    const m = msg({ sender: '+15559876543', chatGuid: 'iMessage;-;+15559876543' })
    const before = captured.activityIds.length
    expect(await handleInbound(m, deps())).toBe('ignored:sender')
    expect(await handleInbound(m, deps())).toBe('ignored:sender') // catch-up overlap re-read: no second warn
    await captured.flush!()
    const ids = captured.activityIds.slice(before)
    expect(ids).toHaveLength(1)
    const [row] = await db().select().from(activityLog).where(eq(activityLog.id, ids[0]!))
    expect(row).toMatchObject({ name: 'imessage:unknown-sender', severity: 'warn' })
    expect((row!.meta as { sender: string }).sender).toMatch(/^\+•+6543$/)
    expect(JSON.stringify(row)).not.toContain('5559876543')
    expect(calls).toHaveLength(0)
  })

  it('empty text and no attachments → ignored:empty, GUID still recorded', async () => {
    const m = msg({ text: '   ' })
    expect(await handleInbound(m, deps())).toBe('ignored:empty')
    expect(await inboundRow(m.guid)).toBeTruthy()
    expect(calls).toHaveLength(0)
  })

  it('a photo → one image attachment stored from the converted download', async () => {
    const m = msg({ text: '', attachments: [{ guid: 'chin-att-photo', mime: 'image/heic', name: 'IMG_0001.HEIC' }] })
    expect(await handleInbound(m, deps())).toBe('enqueued')
    const atts = calls[0]!.input.attachments!
    expect(atts).toHaveLength(1)
    const [img] = await db().select().from(images).where(eq(images.id, atts[0]!.id))
    expect(img!.originalName).toBe('chin-photo.png') // the PNG BlueBubbles converted it to
    expect(atts[0]).toMatchObject({ kind: 'image', mime: img!.mime })
    expect(calls[0]!.input.text).toBe('')
  })

  it('a download still HEIC after conversion → no attachment, the "(couldn\'t load the photo)" note', async () => {
    const heic = blueBubblesClient({ serverUrl: heicFake.url, password: heicFake.password })
    const m = msg({ text: 'look', attachments: [{ guid: 'chin-att-photo', mime: 'image/heic', name: 'IMG_2.HEIC' }] })
    expect(await handleInbound(m, deps({ client: heic }))).toBe('enqueued')
    expect(calls[0]!.input.attachments).toBeUndefined()
    expect(calls[0]!.input.text).toBe("look\n(couldn't load the photo)")
  })

  it('a voice memo is transcribed with its real MIME and filename and appended as (voice memo)', async () => {
    const m = msg({ text: '', attachments: [{ guid: 'chin-att-voice', mime: 'audio/x-caf', name: 'Audio Message.caf' }] })
    expect(await handleInbound(m, deps())).toBe('enqueued')
    expect(transcribe).toHaveBeenCalledTimes(1)
    expect(transcribe.mock.calls[0]![1]).toEqual({ mime: 'audio/x-caf', filename: 'Audio Message.caf' })
    expect(calls[0]!.input.text).toBe('(voice memo) buy milk')
  })

  it('a failed transcription → the "(a voice memo I couldn\'t transcribe)" note, and the message still goes through', async () => {
    transcribe.mockRejectedValue(new Error('stt down'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const m = msg({ text: 'listen', attachments: [{ guid: 'chin-att-voice', mime: 'audio/x-caf', name: 'Audio Message.caf' }] })
      expect(await handleInbound(m, deps())).toBe('enqueued')
      expect(calls[0]!.input.text).toBe("listen\n(a voice memo I couldn't transcribe)")
    } finally { warn.mockRestore() }
  })

  it('any other attachment becomes a one-line note', async () => {
    const m = msg({ text: '', attachments: [{ guid: 'chin-att-pdf', mime: 'application/pdf', name: 'lease.pdf' }] })
    expect(await handleInbound(m, deps())).toBe('enqueued')
    expect(calls[0]!.input.text).toBe("(an attachment I can't open: lease.pdf)")
  })

  it('enqueue throwing releases the GUID so the next catch-up retries it', async () => {
    enqueueThrows = true
    const m = msg()
    await expect(handleInbound(m, deps())).rejects.toThrow('enqueue exploded')
    expect(await inboundRow(m.guid)).toBeUndefined()
    enqueueThrows = false
    expect(await handleInbound(m, deps())).toBe('enqueued')
  })

  it('C1: every inbound text asks enqueue never to steer (noSteer)', async () => {
    expect(await handleInbound(msg(), deps())).toBe('enqueued')
    expect(calls[0]!.noSteer).toBe(true)
  })
})

describe('handleInbound with the real enqueue (kick: false, scratch "main")', () => {
  const realDeps = () => deps({ enqueueFn: (req => enqueue(req, { kick: false })) as typeof enqueue, mainConversationId: scratchReal })

  async function busy(profile: 'interactive' | 'headless') {
    await db().delete(agentRuns).where(eq(agentRuns.conversationId, scratchReal))
    const [run] = await db().insert(agentRuns).values({
      conversationId: scratchReal, sessionKey: `thread:${scratchReal}`, trigger: profile === 'headless' ? 'wake' : 'user',
      profile, status: 'running', aliveAt: FAR_FUTURE, input: { text: 'busy', modality: 'text' }
    }).returning()
    return run!
  }

  // Deletes this conversation's queued runs BEFORE the running one stops running: a queued run
  // behind a finished one is claimable, and a live dev pump would execute it for real.
  async function release(runningId: string) {
    await db().delete(agentRuns).where(and(eq(agentRuns.conversationId, scratchReal), eq(agentRuns.status, 'queued')))
    await db().update(agentRuns).set({ status: 'done' }).where(eq(agentRuns.id, runningId))
  }

  it('C1: Tony texts while an INTERACTIVE run is busy — never steered: its own queued run with reply_to + origin', async () => {
    const running = await busy('interactive')
    try {
      const m = msg({ text: 'also this' })
      expect(await handleInbound(m, realDeps())).toBe('enqueued')
      const row = await inboundRow(m.guid)
      expect(row!.runId).not.toBe(running.id)
      const [q] = await db().select().from(agentRuns).where(eq(agentRuns.id, row!.runId!))
      expect(q).toMatchObject({ status: 'queued', profile: 'interactive', trigger: 'user' })
      expect(q!.replyTo).toEqual({ channel: 'imessage', chatGuid: CHAT, messageGuid: m.guid })
      expect((q!.input as { origin?: string }).origin).toBe(`imessage:${CHAT}`)
      // The busy run is untouched: no steer row, no reply_to.
      const [r] = await db().select().from(agentRuns).where(eq(agentRuns.id, running.id))
      expect(r!.replyTo).toBeNull()
      expect(await db().select().from(agentInbox).where(eq(agentInbox.runId, running.id))).toHaveLength(0)
    } finally { await release(running.id) }
  })

  it('C1: app steering is unchanged — a plain app message into the same busy interactive run still steers', async () => {
    const running = await busy('interactive')
    try {
      const r = await enqueue({ sessionKey: `thread:${scratchReal}`, trigger: 'user', profile: 'interactive', input: { text: 'from the app', modality: 'text' } }, { kick: false })
      expect(r).toMatchObject({ steered: true, runId: running.id })
      const inbox = await db().select().from(agentInbox).where(eq(agentInbox.runId, running.id))
      expect(inbox.map(i => i.content)).toEqual(['from the app'])
    } finally { await release(running.id) }
  })

  it('Review Focus 5: a busy HEADLESS run is not steered into — the text queues as its own run and keeps reply_to', async () => {
    // Held 'running' only for this test (it briefly counts toward the global headless slot).
    const running = await busy('headless')
    try {
      const m = msg({ text: 'while the job runs' })
      expect(await handleInbound(m, realDeps())).toBe('enqueued')
      const row = await inboundRow(m.guid)
      expect(row!.runId).not.toBe(running.id)
      const [q] = await db().select().from(agentRuns).where(eq(agentRuns.id, row!.runId!))
      expect(q).toMatchObject({ status: 'queued', profile: 'interactive', trigger: 'user' })
      expect(q!.replyTo).toEqual({ channel: 'imessage', chatGuid: CHAT, messageGuid: m.guid })
      expect((q!.input as { origin?: string }).origin).toBe(`imessage:${CHAT}`)
      const [h] = await db().select().from(agentRuns).where(eq(agentRuns.id, running.id))
      expect(h!.replyTo).toBeNull()
    } finally { await release(running.id) }
  })
})

describe('catchUpTick', () => {
  const T0 = new Date('2100-01-01T00:00:00Z')
  const tick = (extra: Parameters<typeof catchUpTick>[0] = {}) => catchUpTick({ ...deps(), force: true, onlyDeliveryIds: [], onlyApprovalIds: [], ...extra })
  const raw = (g: string, over: Record<string, unknown> = {}) => ({
    guid: g, text: 'from catch-up', isFromMe: false, dateCreated: Date.now(),
    handle: { address: ALLOWED }, chats: [{ guid: CHAT, style: 45 }], attachments: [],
    associatedMessageGuid: null, associatedMessageType: null, ...over
  })

  beforeEach(() => {
    _resetCatchUp()
    fake.setDown(false)
  })

  it('a message after the cursor is enqueued once; running it again does nothing new', async () => {
    const g = guid('cu')
    fake.pushMessage(raw(g))
    expect(await tick()).toEqual({ processed: 1, healthy: true })
    expect(calls.map(c => c.replyTo?.messageGuid)).toEqual([g])
    expect(lastHealth()).toMatchObject({ ok: true, privateApi: false })
    expect(await tick()).toEqual({ processed: 0, healthy: true })
    expect(calls).toHaveLength(1)
  })

  it('without force it is throttled to once per 2 min (null)', async () => {
    expect(await tick()).not.toBeNull()
    expect(await catchUpTick({ ...deps(), onlyDeliveryIds: [], onlyApprovalIds: [] })).toBeNull()
  })

  it('serverInfo failing → unhealthy, nothing processed', async () => {
    fake.setDown(true)
    fake.pushMessage(raw(guid('cu-down')))
    expect(await tick()).toEqual({ processed: 0, healthy: false })
    expect(lastHealth().ok).toBe(false)
    expect(lastHealth().error).toMatch(/503/)
    expect(calls).toHaveLength(0)
    fake.setDown(false)
    expect(await tick()).toEqual({ processed: 1, healthy: true }) // the gap closes once it's back
  })

  it('one failing message does not stop the rest of the scan', async () => {
    const bad = guid('cu-bad'), good = guid('cu-good')
    fake.pushMessage(raw(bad, { text: 'first' }))
    fake.pushMessage(raw(good, { text: 'second', dateCreated: Date.now() + 1 }))
    let n = 0
    const flaky = (async (req: EnqueueRequest) => { if (n++ === 0) throw new Error('boom'); return fakeEnqueue(req) }) as typeof enqueue
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await tick({ enqueueFn: flaky })).toEqual({ processed: 1, healthy: true })
      expect(await tick()).toEqual({ processed: 1, healthy: true }) // the failed one is retried
      expect(calls.map(c => c.replyTo?.messageGuid).sort()).toEqual([bad, good].sort())
    } finally { err.mockRestore() }
  })

  describe('sent_unconfirmed confirmation', () => {
    async function unconfirmed(text: string, firstClaimedAt: Date): Promise<string> {
      const [row] = await db().insert(channelDeliveries).values({
        channel: 'imessage', target: CHAT, payload: text ? { text } : { text: '', images: ['img'] }, source: 'reply',
        status: 'sent_unconfirmed', attempts: 1, nextAttemptAt: T0, claimedAt: firstClaimedAt, firstClaimedAt, sentAt: firstClaimedAt
      }).returning({ id: channelDeliveries.id })
      deliveryIds.push(row!.id)
      return row!.id
    }
    async function status(id: string) {
      const [r] = await db().select().from(channelDeliveries).where(eq(channelDeliveries.id, id))
      return r!
    }
    const minutes = (n: number) => new Date(T0.getTime() - n * 60_000)

    it('found in the chat → sent; not found → still unconfirmed; over a day → failed', async () => {
      const found = await unconfirmed('did it land?', minutes(3))
      fake.pushMessage({ guid: 'chin-own-1', text: 'did it land?', isFromMe: true, dateCreated: minutes(2).getTime(), chats: [{ guid: CHAT }], attachments: [] })
      const missing = await unconfirmed('never arrived', minutes(3))
      const old = await unconfirmed('ancient', minutes(25 * 60))
      await tick({ onlyDeliveryIds: [found, missing, old], now: T0 })
      expect(await status(found)).toMatchObject({ status: 'sent', externalId: 'chin-own-1' })
      expect((await status(missing)).status).toBe('sent_unconfirmed')
      expect(await status(old)).toMatchObject({ status: 'failed' })
    })

    it('image-only rows: sent after 10 min, left alone before', async () => {
      const young = await unconfirmed('', minutes(5))
      const aged = await unconfirmed('', minutes(11))
      await tick({ onlyDeliveryIds: [young, aged], now: T0 })
      expect((await status(young)).status).toBe('sent_unconfirmed')
      expect((await status(aged)).status).toBe('sent')
    })
  })
})
