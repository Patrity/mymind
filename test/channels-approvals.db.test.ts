// DB-backed — harness pattern from test/jobs-tick.db.test.ts / test/channels-inbound.db.test.ts.
//
// Cycle 75, Task 9: exec approvals over iMessage (server/lib/channels/approvals.ts). The dev DB
// is SHARED with live dev servers and holds real data, so:
//   - approvals hang off SCRATCH runs (status `done`, never claimable) in a SCRATCH conversation
//     titled `chap-…`; every channel_approvals row is found by those run ids and deleted in
//     afterAll (the run delete cascades too);
//   - expireApprovals / catchUpTick are always scoped with `onlyIds` / `onlyApprovalIds`;
//   - BlueBubbles is the in-process fake; the channel config is stubbed (no settings writes);
//   - recordEvent is captured in memory (no activity rows, no alert email).
process.loadEnvFile('.env')

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

const ALLOWED = '+15551234567'
const CHAT = `iMessage;-;${ALLOWED}`
const events = vi.hoisted(() => [] as { name: string; meta?: Record<string, unknown> }[])

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
vi.mock('../server/lib/observability/record', async (orig) => {
  const actual = await orig<typeof import('../server/lib/observability/record')>()
  return { ...actual, recordEvent: (e: { name: string; meta?: Record<string, unknown> }) => { events.push(e) } }
})

import { eq, inArray, count } from 'drizzle-orm'
import { useDb } from '../server/db'
import { agentRuns, channelApprovals, conversations } from '../server/db/schema'
import { createConversation } from '../server/services/conversations'
import { blueBubblesClient, type BlueBubblesClient } from '../server/lib/channels/bluebubbles/client'
import {
  imessageApprovalChannel, replyToApprovalChannel, resolveTapback, expireApprovals, _dropWaiters, APPROVAL_TIMEOUT_MS
} from '../server/lib/channels/approvals'
import { catchUpTick, lastHealth, _resetCatchUp } from '../server/lib/channels/inbound'
import type { ApprovalRequest } from '../server/lib/agent/types'
import type { TapbackEvent } from '../server/lib/channels/types'
import { startFakeBlueBubbles, type FakeBlueBubbles } from './fixtures/fake-bluebubbles'

const db = () => useDb()
const TAG = `chap-${Date.now().toString(36)}`
const FAST = { pollMs: 50, timeoutMs: 500 }
const REQ: ApprovalRequest = { tool: 'exec', command: 'ls -la /tmp', proposedPattern: 'ls *' }

let fake: FakeBlueBubbles
let failFake: FakeBlueBubbles
let bb: BlueBubblesClient
let convId = ''
const runIds: string[] = []
let approvalsBefore = 0

async function approvalCount(): Promise<number> {
  const [r] = await db().select({ n: count() }).from(channelApprovals)
  return Number(r!.n)
}

async function newRun(replyTo: unknown = { channel: 'imessage', chatGuid: CHAT, messageGuid: `${TAG}-in` }): Promise<string> {
  const [r] = await db().insert(agentRuns).values({
    conversationId: convId, sessionKey: `thread:${convId}`, trigger: 'user', profile: 'interactive',
    status: 'done', input: { text: 'scratch', modality: 'text' }, replyTo: replyTo as never
  }).returning({ id: agentRuns.id })
  runIds.push(r!.id)
  return r!.id
}

async function rowsFor(runId: string) {
  return db().select().from(channelApprovals).where(eq(channelApprovals.runId, runId))
}

/** Wait until the run's approval prompt has been sent and its guid stored. */
async function promptFor(runId: string): Promise<{ id: string; promptGuid: string; chatGuid: string }> {
  for (let i = 0; i < 100; i++) {
    const [row] = await rowsFor(runId)
    if (row?.promptGuid) return { id: row.id, promptGuid: row.promptGuid, chatGuid: row.chatGuid }
    await new Promise(r => setTimeout(r, 10))
  }
  throw new Error('prompt never sent')
}

function tapback(targetGuid: string, over: Partial<TapbackEvent> = {}): TapbackEvent {
  return { kind: 'tapback', guid: `${TAG}-tb-${Math.random()}`, chatGuid: CHAT, sender: ALLOWED, targetGuid, tapback: 'like', removed: false, isFromMe: false, ...over }
}

beforeAll(async () => {
  approvalsBefore = await approvalCount()
  fake = await startFakeBlueBubbles({ privateApi: true })
  failFake = await startFakeBlueBubbles({ privateApi: true, failSends: 1000 })
  bb = blueBubblesClient({ serverUrl: fake.url, password: fake.password, privateApi: true })
  convId = (await createConversation({ title: `${TAG}-scratch` })).id
})

afterAll(async () => {
  await fake?.close()
  await failFake?.close()
  const removed = runIds.length
    ? await db().delete(channelApprovals).where(inArray(channelApprovals.runId, runIds)).returning({ id: channelApprovals.id })
    : []
  if (runIds.length) await db().delete(agentRuns).where(inArray(agentRuns.id, runIds))
  if (convId) await db().delete(conversations).where(eq(conversations.id, convId))
  _resetCatchUp()
  const after = await approvalCount()
  console.info(`[chap] channel_approvals: before=${approvalsBefore} after=${after} (removed ${removed.length} test rows)`)
})

beforeEach(() => {
  _resetCatchUp() // health.privateApi = null (unknown), not "off"
  events.length = 0
})

describe('imessageApprovalChannel', () => {
  it('sends the prompt to the chat and a like tapback approves', async () => {
    const run = await newRun()
    const sentBefore = fake.sent.length
    const p = imessageApprovalChannel(run, CHAT, { client: bb, ...FAST })(REQ)
    const { id, promptGuid } = await promptFor(run)
    const sent = fake.sent.slice(sentBefore)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ kind: 'text', chatGuid: CHAT, message: 'Run `ls -la /tmp`?\n👍 to approve · 👎 to deny', guid: promptGuid })
    expect(await resolveTapback(tapback(promptGuid))).toBe('tapback')
    expect(await p).toEqual({ approved: true })
    const [row] = await rowsFor(run)
    expect(row).toMatchObject({ id, status: 'approved', chatGuid: CHAT })
    expect(row!.resolvedAt).not.toBeNull()
    expect(row!.expiresAt.getTime() - row!.createdAt.getTime()).toBeGreaterThanOrEqual(400)
  })

  it('a love tapback approves too', async () => {
    const run = await newRun()
    const p = imessageApprovalChannel(run, CHAT, { client: bb, ...FAST })(REQ)
    const { promptGuid } = await promptFor(run)
    await resolveTapback(tapback(promptGuid, { tapback: 'love' }))
    expect(await p).toEqual({ approved: true })
  })

  it('a dislike tapback denies', async () => {
    const run = await newRun()
    const p = imessageApprovalChannel(run, CHAT, { client: bb, ...FAST })(REQ)
    const { promptGuid } = await promptFor(run)
    await resolveTapback(tapback(promptGuid, { tapback: 'dislike' }))
    expect(await p).toEqual({ approved: false })
    expect((await rowsFor(run))[0]!.status).toBe('denied')
  })

  it('no tapback → expired and denied', async () => {
    const run = await newRun()
    const t0 = Date.now()
    expect(await imessageApprovalChannel(run, CHAT, { client: bb, ...FAST })(REQ)).toEqual({ approved: false })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(450)
    const [row] = await rowsFor(run)
    expect(row!.status).toBe('expired')
    expect(row!.resolvedAt).not.toBeNull()
  })

  // Each of these must be ignored, so the request runs out its timeout and expires. The group
  // case prompts IN a group chat, so only the group filter (not the chat match) can stop it.
  const ignored: [string, (g: string) => Partial<TapbackEvent>, string?][] = [
    ['a removed tapback', () => ({ removed: true })],
    ['Bridget\'s own tapback', () => ({ isFromMe: true })],
    ['a sender not on the allowlist', () => ({ sender: '+15559999999' })],
    ['a tapback in a group chat', () => ({ chatGuid: 'iMessage;+;chat-chap-group' }), 'iMessage;+;chat-chap-group'],
    ['a tapback on a different message', () => ({ targetGuid: 'fake-msg-not-the-prompt' })],
    ['a tapback on the prompt guid from a different chat', () => ({ chatGuid: 'iMessage;-;+15550001111', sender: ALLOWED })],
    ['a non-approval tapback (laugh)', () => ({ tapback: 'laugh' })]
  ]
  it.each(ignored)('%s is ignored and the request expires', async (_label, over, promptChat) => {
    const chat = promptChat ?? CHAT
    const run = await newRun()
    const p = imessageApprovalChannel(run, chat, { client: bb, ...FAST })(REQ)
    const { promptGuid } = await promptFor(run)
    await resolveTapback(tapback(promptGuid, { chatGuid: chat, ...over(promptGuid) }))
    expect(await p).toEqual({ approved: false })
    expect((await rowsFor(run))[0]!.status).toBe('expired')
  })

  it('restart: with no in-process waiter the poll picks up the status resolveTapback wrote', async () => {
    const run = await newRun()
    const p = imessageApprovalChannel(run, CHAT, { client: bb, pollMs: 50, timeoutMs: 3_000 })(REQ)
    const { promptGuid } = await promptFor(run)
    _dropWaiters()
    const t0 = Date.now()
    await resolveTapback(tapback(promptGuid))
    expect(await p).toEqual({ approved: true })
    expect(Date.now() - t0).toBeLessThan(2_000) // the poll, not the timeout
  })

  it('Private API off → immediate deny, recorded with the reason, nothing sent', async () => {
    const offFake = await startFakeBlueBubbles({ privateApi: false })
    try {
      const offClient = blueBubblesClient({ serverUrl: offFake.url, password: offFake.password })
      await catchUpTick({ client: offClient, force: true, onlyDeliveryIds: [], onlyApprovalIds: [] })
      expect(lastHealth().privateApi).toBe(false)
      const run = await newRun()
      const t0 = Date.now()
      expect(await imessageApprovalChannel(run, CHAT, { client: offClient, ...FAST })(REQ)).toEqual({ approved: false })
      expect(Date.now() - t0).toBeLessThan(400)
      expect(offFake.sent).toHaveLength(0)
      const [row] = await rowsFor(run)
      expect(row!.status).toBe('denied')
      expect(events.some(e => e.name === 'exec:approval' && e.meta?.reason === 'private-api-off' && e.meta?.runId === run)).toBe(true)
    } finally {
      await offFake.close()
    }
  })

  it('no client (iMessage not configured) → immediate deny', async () => {
    const run = await newRun()
    expect(await imessageApprovalChannel(run, CHAT, { client: null, ...FAST })(REQ)).toEqual({ approved: false })
    expect((await rowsFor(run))[0]!.status).toBe('denied')
  })

  it('the prompt send fails → deny', async () => {
    const run = await newRun()
    const failClient = blueBubblesClient({ serverUrl: failFake.url, password: failFake.password, privateApi: true })
    const t0 = Date.now()
    expect(await imessageApprovalChannel(run, CHAT, { client: failClient, ...FAST })(REQ)).toEqual({ approved: false })
    expect(Date.now() - t0).toBeLessThan(400)
    const [row] = await rowsFor(run)
    expect(row!.status).toBe('denied')
    expect(row!.promptGuid).toBeNull()
  })
})

describe('expiry vs tapback race', () => {
  it('expiry first: a later like is ignored and the waiter reports expired', async () => {
    const run = await newRun()
    const p = imessageApprovalChannel(run, CHAT, { client: bb, pollMs: 50, timeoutMs: 5_000 })(REQ)
    const { id, promptGuid } = await promptFor(run)
    expect(await expireApprovals(new Date(Date.now() + 10_000), { onlyIds: [id] })).toBe(1)
    await resolveTapback(tapback(promptGuid))
    expect(await p).toEqual({ approved: false })
    expect((await rowsFor(run))[0]!.status).toBe('expired')
  })

  it('tapback first: a later expiry touches nothing and the approval stands', async () => {
    const run = await newRun()
    const p = imessageApprovalChannel(run, CHAT, { client: bb, pollMs: 50, timeoutMs: 5_000 })(REQ)
    const { id, promptGuid } = await promptFor(run)
    await resolveTapback(tapback(promptGuid))
    expect(await expireApprovals(new Date(Date.now() + 10_000), { onlyIds: [id] })).toBe(0)
    expect(await p).toEqual({ approved: true })
    expect((await rowsFor(run))[0]!.status).toBe('approved')
  })

  it('the waiter timer losing to a tapback that already settled the row uses the tapback\'s status', async () => {
    const run = await newRun()
    const p = imessageApprovalChannel(run, CHAT, { client: bb, pollMs: 60_000, timeoutMs: 400 })(REQ)
    const { promptGuid } = await promptFor(run)
    _dropWaiters() // neither the map nor the (slow) poll can deliver it: only the timer's re-read
    await resolveTapback(tapback(promptGuid))
    expect(await p).toEqual({ approved: true })
    expect((await rowsFor(run))[0]!.status).toBe('approved')
  })

  it('expireApprovals leaves unexpired rows and returns 0 for an empty id list', async () => {
    const run = await newRun()
    const p = imessageApprovalChannel(run, CHAT, { client: bb, ...FAST })(REQ)
    const { id } = await promptFor(run)
    expect(await expireApprovals(new Date(), { onlyIds: [id] })).toBe(0)
    expect(await expireApprovals(new Date(Date.now() + 10_000), { onlyIds: [] })).toBe(0)
    await p
  })

  it('catchUpTick expires overdue approvals (housekeeping)', async () => {
    const run = await newRun()
    const [row] = await db().insert(channelApprovals).values({
      runId: run, request: REQ, chatGuid: CHAT, promptGuid: `${TAG}-orphan`, expiresAt: new Date(Date.now() - 1_000)
    }).returning({ id: channelApprovals.id })
    await catchUpTick({ client: bb, force: true, onlyDeliveryIds: [], onlyApprovalIds: [row!.id] })
    expect((await rowsFor(run))[0]!.status).toBe('expired')
  })

  it('APPROVAL_TIMEOUT_MS is 10 minutes', () => {
    expect(APPROVAL_TIMEOUT_MS).toBe(600_000)
  })
})

describe('replyToApprovalChannel (runner wiring)', () => {
  it('reads reply_to fresh: none → deny without sending; set later → prompts in that chat', async () => {
    const run = await newRun(null)
    const ch = replyToApprovalChannel(run, { client: bb, ...FAST })
    const sentBefore = fake.sent.length
    expect(await ch(REQ)).toEqual({ approved: false })
    expect(fake.sent.length).toBe(sentBefore)
    expect(await rowsFor(run)).toHaveLength(0)

    await db().update(agentRuns).set({ replyTo: { channel: 'imessage', chatGuid: CHAT, messageGuid: `${TAG}-steer` } }).where(eq(agentRuns.id, run))
    const p = ch(REQ)
    const { promptGuid, chatGuid } = await promptFor(run)
    expect(chatGuid).toBe(CHAT)
    await resolveTapback(tapback(promptGuid))
    expect(await p).toEqual({ approved: true })
  })
})
