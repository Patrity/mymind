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

vi.mock('@mymind/core/lib/channels/config', async (orig) => {
  const actual = await orig<typeof import('@mymind/core/lib/channels/config')>()
  return {
    ...actual,
    loadChannelsConfig: async () => ({
      imessage: { enabled: true, serverUrl: '', passwordEnc: null, webhookToken: 'x', allowedHandles: ['+15551234567'], defaultHandle: '+15551234567', defaultChatGuid: null },
      email: { enabled: false, to: null },
      presenceAwayMinutes: 10
    })
  }
})
vi.mock('@mymind/core/lib/observability/record', async (orig) => {
  const actual = await orig<typeof import('@mymind/core/lib/observability/record')>()
  return {
    ...actual,
    recordEvent: (e: { name: string; meta?: Record<string, unknown> }) => { events.push(e) },
    // buildAiTools (the Stop-vs-👍 race) wraps a handler that runs in a span: no activity rows.
    withSpan: (_span: unknown, fn: () => unknown) => fn()
  }
})

import { Client } from 'pg'
import { z } from 'zod'
import { eq, inArray, count } from 'drizzle-orm'
import { useDb } from '@mymind/core/db'
import { agentRuns, channelApprovals, conversations } from '@mymind/core/db/schema'
import { createConversation } from '@mymind/core/services/conversations'
import { blueBubblesClient, type BlueBubblesClient } from '@mymind/core/lib/channels/bluebubbles/client'
import {
  imessageApprovalChannel, replyToApprovalChannel, resolveTapback, expireApprovals, _dropWaiters, APPROVAL_TIMEOUT_MS, APPROVAL_WITHDRAWN
} from '@mymind/core/lib/channels/approvals'
import { catchUpTick, lastHealth, _resetCatchUp } from '@mymind/core/lib/channels/inbound'
import type { AgentTool, ApprovalRequest } from '@mymind/core/lib/agent/types'
import { buildAiTools } from '@mymind/core/lib/agent/ai-tools'
import type { TapbackEvent } from '@mymind/core/lib/channels/types'
import { startFakeBlueBubbles, type FakeBlueBubbles } from './fixtures/fake-bluebubbles'
import { createApprovalJudge, type ApprovalJudgeDeps } from '@mymind/core/lib/agent/judge/approval'
import type { JudgeVerdict } from '@mymind/core/lib/agent/judge/types'

const db = () => useDb()
const TAG = `chap-${Date.now().toString(36)}`
const FAST = { pollMs: 50, timeoutMs: 500 }
const REQ: ApprovalRequest = { tool: 'exec', command: 'ls -la /tmp', proposedPattern: 'ls *' }
const REQ_LONG = (command: string): ApprovalRequest => ({ tool: 'exec', command, proposedPattern: 'cat *' })

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

/** The run's approval status once it reads `want` (Stop's audit write lands in the background). */
async function statusOnce(runId: string, want: string): Promise<string | undefined> {
  let status: string | undefined
  for (let i = 0; i < 200; i++) {
    status = (await rowsFor(runId))[0]?.status
    if (status === want) break
    await new Promise(r => setTimeout(r, 10))
  }
  return status
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
    expect(await resolveTapback(tapback(promptGuid))).toBe(true)
    expect(await p).toMatchObject({ approved: true })
    const [row] = await rowsFor(run)
    expect(row).toMatchObject({ id, status: 'approved', chatGuid: CHAT })
    expect(row!.resolvedAt).not.toBeNull()
    expect(row!.expiresAt.getTime() - row!.createdAt.getTime()).toBeGreaterThanOrEqual(400)
  })

  it('a long command is texted cut to 300 chars with an ellipsis (T9)', async () => {
    const run = await newRun()
    const long = `cat <<'EOF'\n${'x'.repeat(1000)}\nEOF`
    const sentBefore = fake.sent.length
    const p = imessageApprovalChannel(run, CHAT, { client: bb, ...FAST })(REQ_LONG(long))
    const { promptGuid } = await promptFor(run)
    const msg = fake.sent.slice(sentBefore)[0]!.message!
    const cmd = /^Run `([\s\S]*)`\?\n/.exec(msg)![1]!
    expect(cmd).toHaveLength(300)
    expect(cmd.endsWith('…')).toBe(true)
    expect(long.startsWith(cmd.slice(0, 299))).toBe(true)
    await resolveTapback(tapback(promptGuid, { tapback: 'dislike' }))
    expect(await p).toMatchObject({ approved: false })
  })

  it('a love tapback approves too', async () => {
    const run = await newRun()
    const p = imessageApprovalChannel(run, CHAT, { client: bb, ...FAST })(REQ)
    const { promptGuid } = await promptFor(run)
    await resolveTapback(tapback(promptGuid, { tapback: 'love' }))
    expect(await p).toMatchObject({ approved: true })
  })

  it('a dislike tapback denies', async () => {
    const run = await newRun()
    const p = imessageApprovalChannel(run, CHAT, { client: bb, ...FAST })(REQ)
    const { promptGuid } = await promptFor(run)
    await resolveTapback(tapback(promptGuid, { tapback: 'dislike' }))
    expect(await p).toMatchObject({ approved: false })
    expect((await rowsFor(run))[0]!.status).toBe('denied')
  })

  it('no tapback → expired and denied', async () => {
    const run = await newRun()
    const t0 = Date.now()
    expect(await imessageApprovalChannel(run, CHAT, { client: bb, ...FAST })(REQ)).toMatchObject({ approved: false })
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
    ['a non-approval tapback (laugh)', () => ({ tapback: 'laugh' })],
    // I2: prompt and tapback in the same chat, allowed sender — but it is someone else's chat.
    ['an allowed sender tapping in a chat that is not their own', () => ({ chatGuid: 'iMessage;-;+15550002222', sender: ALLOWED }), 'iMessage;-;+15550002222']
  ]
  it.each(ignored)('%s is ignored and the request expires', async (_label, over, promptChat) => {
    const chat = promptChat ?? CHAT
    const run = await newRun()
    const p = imessageApprovalChannel(run, chat, { client: bb, ...FAST })(REQ)
    const { promptGuid } = await promptFor(run)
    await resolveTapback(tapback(promptGuid, { chatGuid: chat, ...over(promptGuid) }))
    expect(await p).toMatchObject({ approved: false })
    expect((await rowsFor(run))[0]!.status).toBe('expired')
  })

  it('restart: with no in-process waiter the poll picks up the status resolveTapback wrote', async () => {
    const run = await newRun()
    const p = imessageApprovalChannel(run, CHAT, { client: bb, pollMs: 50, timeoutMs: 3_000 })(REQ)
    const { promptGuid } = await promptFor(run)
    _dropWaiters()
    const t0 = Date.now()
    await resolveTapback(tapback(promptGuid))
    expect(await p).toMatchObject({ approved: true })
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
      expect(await imessageApprovalChannel(run, CHAT, { client: offClient, ...FAST })(REQ)).toMatchObject({ approved: false })
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
    expect(await imessageApprovalChannel(run, CHAT, { client: null, ...FAST })(REQ)).toMatchObject({ approved: false })
    expect((await rowsFor(run))[0]!.status).toBe('denied')
  })

  it('the prompt send fails → deny', async () => {
    const run = await newRun()
    const failClient = blueBubblesClient({ serverUrl: failFake.url, password: failFake.password, privateApi: true })
    const t0 = Date.now()
    expect(await imessageApprovalChannel(run, CHAT, { client: failClient, ...FAST })(REQ)).toMatchObject({ approved: false })
    expect(Date.now() - t0).toBeLessThan(400)
    const [row] = await rowsFor(run)
    expect(row!.status).toBe('denied')
    expect(row!.promptGuid).toBeNull()
  })
})

describe('abort (final review I1): Stop / /clear unwinds an iMessage approval wait', () => {
  it('aborting mid-wait denies at once and marks the row denied; a later like changes nothing', async () => {
    const run = await newRun()
    const ac = new AbortController()
    const p = imessageApprovalChannel(run, CHAT, { client: bb, pollMs: 60_000, timeoutMs: 60_000, signal: ac.signal })(REQ)
    const { promptGuid } = await promptFor(run)
    const t0 = Date.now()
    ac.abort()
    expect(await p).toMatchObject({ approved: false })
    expect(Date.now() - t0).toBeLessThan(1_000) // the abort, not the 60 s timeout or poll
    expect(await statusOnce(run, 'denied')).toBe('denied')
    await resolveTapback(tapback(promptGuid))
    expect((await rowsFor(run))[0]!.status).toBe('denied')
    expect(events.some(e => e.name === 'exec:approval' && e.meta?.reason === 'aborted' && e.meta?.runId === run)).toBe(true)
  })

  // Cycle 81 (workstream review I1): a prompt WITHDRAWN (the card answered first, or the worker is
  // restarting with the card parked) is closed as expired — nothing was denied.
  it('withdrawn (abort reason APPROVAL_WITHDRAWN) → the wait ends, the row is expired, not denied', async () => {
    const run = await newRun()
    const ac = new AbortController()
    const p = imessageApprovalChannel(run, CHAT, { client: bb, pollMs: 60_000, timeoutMs: 60_000, signal: ac.signal })(REQ)
    await promptFor(run)
    ac.abort(APPROVAL_WITHDRAWN)
    expect(await p).toMatchObject({ approved: false })
    expect(await statusOnce(run, 'expired')).toBe('expired')
  })

  it('already aborted → denied immediately, no prompt texted, no row', async () => {
    const run = await newRun()
    const ac = new AbortController()
    ac.abort()
    const sentBefore = fake.sent.length
    expect(await imessageApprovalChannel(run, CHAT, { client: bb, ...FAST, signal: ac.signal })(REQ)).toMatchObject({ approved: false })
    expect(fake.sent.length).toBe(sentBefore)
    expect(await rowsFor(run)).toHaveLength(0)
  })

  it('I4 (cycle 79 review): a gmail_send approval outcome logs the body-free logSummary, never the draft body', async () => {
    const run = await newRun()
    const ac = new AbortController()
    ac.abort()
    const req: ApprovalRequest = {
      tool: 'gmail_send',
      command: 'From: tony@work.com\nTo: ann@a.com\n\nthe real secret draft body text',
      proposedPattern: '',
      logSummary: 'gmail_send: account=work draftId=d1 to=ann@a.com subjectChars=5'
    }
    expect(await imessageApprovalChannel(run, CHAT, { client: bb, ...FAST, signal: ac.signal })(req)).toMatchObject({ approved: false })
    const ev = events.find(e => e.name === 'exec:approval' && e.meta?.runId === run)
    expect(ev?.meta?.command).toBe(req.logSummary)
    expect(JSON.stringify(ev?.meta)).not.toContain('secret draft body')
  })

  it('replyToApprovalChannel forwards the signal', async () => {
    const run = await newRun()
    const ac = new AbortController()
    const p = replyToApprovalChannel(run, { client: bb, pollMs: 60_000, timeoutMs: 60_000, signal: ac.signal })(REQ)
    await promptFor(run)
    ac.abort()
    expect(await p).toMatchObject({ approved: false })
    expect(await statusOnce(run, 'denied')).toBe('denied')
  })
})

describe('Stop always beats a late 👍 (reliability Task 2)', () => {
  /** A dangerous exec-like tool gated by the iMessage approval channel, exactly as the runner
   *  wires it (buildAiTools → ctx.requestApproval). `ran` records whether the handler executed. */
  function gatedExec(run: string, signal: AbortSignal) {
    const ran: string[] = []
    const t: AgentTool = {
      name: 'fake_exec', description: 'test', kind: 'write', dangerous: true,
      schema: { command: z.string() },
      describeApproval: () => REQ,
      handler: async (input) => { ran.push(String(input.command)); return { result: { ok: true }, summary: 'ran' } }
    }
    const tools = buildAiTools([t], {
      signal, onEvent: () => {},
      requestApproval: imessageApprovalChannel(run, CHAT, { client: bb, pollMs: 60_000, timeoutMs: 60_000, signal })
    })
    const exec = tools.fake_exec as unknown as { execute: (i: unknown, o: unknown) => Promise<unknown> }
    return { ran, call: () => exec.execute({ command: REQ.command }, { toolCallId: `${TAG}-call`, messages: [] }) }
  }

  it('abort, then a like in the same instant: the wait is denied at once, before any DB write lands', async () => {
    const run = await newRun()
    const ac = new AbortController()
    const { ran, call } = gatedExec(run, ac.signal)
    const p = call()
    const { id, promptGuid } = await promptFor(run)
    // Hold the row so NO write to it can land: the abort's and the like's updates both queue.
    // The wait must be decided by the abort itself, not by whichever DB write comes back first
    // (the old code decided only after its write returned, so it could not answer here).
    const locker = new Client({ connectionString: process.env.DATABASE_URL })
    await locker.connect()
    try {
      await locker.query('begin')
      await locker.query('select id from channel_approvals where id = $1 for update', [id])
      ac.abort()
      const tb = resolveTapback(tapback(promptGuid))
      const decided = await Promise.race([p, new Promise(r => setTimeout(() => r('still waiting'), 1_000))])
      expect(decided).toEqual({ denied: true })
      expect(ran).toEqual([])
      await locker.query('commit')
      await tb
      expect(ran).toEqual([])
      expect(await statusOnce(run, 'denied')).toBe('denied')
    } finally {
      await locker.query('rollback').catch(() => {})
      await locker.end()
    }
  })

  it('a like already on its way to the row when Stop is pressed cannot flip the wait to approved', async () => {
    const run = await newRun()
    const ac = new AbortController()
    const { ran, call } = gatedExec(run, ac.signal)
    const p = call()
    const { id, promptGuid } = await promptFor(run)
    // Hold the approval row's lock so both guarded updates queue on it, the tapback's FIRST:
    // its update then wins the row, as a 👍 that reached Postgres a moment before Stop would.
    const locker = new Client({ connectionString: process.env.DATABASE_URL })
    await locker.connect()
    try {
      await locker.query('begin')
      await locker.query('select id from channel_approvals where id = $1 for update', [id])
      const tb = resolveTapback(tapback(promptGuid))
      let queued = false
      for (let i = 0; i < 200 && !queued; i++) {
        // Blocked on OUR lock = the tapback's guarded update (the only writer of this row).
        // Not matched by query text: pg_stat_activity can still show the backend's previous select.
        const r = await locker.query('select count(*)::int as n from pg_stat_activity where pg_backend_pid() = any(pg_blocking_pids(pid))')
        queued = r.rows[0].n > 0
        if (!queued) await new Promise(res => setTimeout(res, 10))
      }
      expect(queued).toBe(true)
      ac.abort() // Stop, while the like's update is still blocked
      await locker.query('commit')
      expect(await p).toEqual({ denied: true })
      await tb
      expect(ran).toEqual([])
      // The like's update usually reaches the row first ('approved'); Stop's own update then
      // overwrites it, so the audit row matches what happened: denied, nothing ran.
      expect(await statusOnce(run, 'denied')).toBe('denied')
    } finally {
      await locker.query('rollback').catch(() => {})
      await locker.end()
    }
  })
})

describe('expiry vs tapback race', () => {
  it('expiry first: a later like is ignored and the waiter reports expired', async () => {
    const run = await newRun()
    const p = imessageApprovalChannel(run, CHAT, { client: bb, pollMs: 50, timeoutMs: 5_000 })(REQ)
    const { id, promptGuid } = await promptFor(run)
    expect(await expireApprovals(new Date(Date.now() + 10_000), { onlyIds: [id] })).toBe(1)
    await resolveTapback(tapback(promptGuid))
    expect(await p).toMatchObject({ approved: false })
    expect((await rowsFor(run))[0]!.status).toBe('expired')
  })

  it('tapback first: a later expiry touches nothing and the approval stands', async () => {
    const run = await newRun()
    const p = imessageApprovalChannel(run, CHAT, { client: bb, pollMs: 50, timeoutMs: 5_000 })(REQ)
    const { id, promptGuid } = await promptFor(run)
    await resolveTapback(tapback(promptGuid))
    expect(await expireApprovals(new Date(Date.now() + 10_000), { onlyIds: [id] })).toBe(0)
    expect(await p).toMatchObject({ approved: true })
    expect((await rowsFor(run))[0]!.status).toBe('approved')
  })

  it('the waiter timer losing to a tapback that already settled the row uses the tapback\'s status', async () => {
    const run = await newRun()
    const p = imessageApprovalChannel(run, CHAT, { client: bb, pollMs: 60_000, timeoutMs: 400 })(REQ)
    const { promptGuid } = await promptFor(run)
    _dropWaiters() // neither the map nor the (slow) poll can deliver it: only the timer's re-read
    await resolveTapback(tapback(promptGuid))
    expect(await p).toMatchObject({ approved: true })
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
    expect(await ch(REQ)).toMatchObject({ approved: false })
    expect(fake.sent.length).toBe(sentBefore)
    expect(await rowsFor(run)).toHaveLength(0)

    await db().update(agentRuns).set({ replyTo: { channel: 'imessage', chatGuid: CHAT, messageGuid: `${TAG}-steer` } }).where(eq(agentRuns.id, run))
    const p = ch(REQ)
    const { promptGuid, chatGuid } = await promptFor(run)
    expect(chatGuid).toBe(CHAT)
    await resolveTapback(tapback(promptGuid))
    expect(await p).toMatchObject({ approved: true })
  })
})

// Cycle 84 Task 2 (+ fix round 1 C3/C4/I1/M5): a chat run that answers over iMessage — the judge starts
// first and the prompt waits ≤ VERDICT_WAIT_MS for its verdict ("⚖ pending" after that); Smart
// Approvals (when on for chat) withdraws the prompt — but a 👍/👎 already committed in the DB wins.
describe('iMessage approvals with a judge (cycle 84)', () => {
  const APPROVE: JudgeVerdict = { risk: 'low', recommendation: 'approve', confidence: 0.97, reasons: ['routine'], model: 'J', latencyMs: 1 }
  function judgeFor(chat: boolean) {
    const decisions: Array<[string, string]> = []
    let release!: (v: JudgeVerdict) => void
    const verdict = new Promise<JudgeVerdict>((r) => { release = r })
    const settings = async () => ({ enabled: true, smartApprovals: { workstreams: true, chat }, confidence: 0.9 })
    const deps: ApprovalJudgeDeps = {
      settings, freshSettings: settings,
      rule: async () => ({ floor: 'review', reasons: [] }),
      verdict: async () => verdict,
      recordVerdict: async () => {},
      recordDecision: async (_n, d, b) => { decisions.push([d, b]); return true },
      pinnedSendMessageId: () => undefined,
      ruleContextWaitMs: 5, ruleTimeoutMs: 5_000, verdictTimeoutMs: 5_000
    }
    const judge = createApprovalJudge({ tool: { name: 'calendar_rsvp', description: 'rsvp' }, input: {}, req: { command: 'RSVP' }, nonce: `${TAG}-n-${Math.random()}`, surface: 'chat', isTainted: () => false }, deps)
    return { judge, decisions, release }
  }
  const RSVP: ApprovalRequest = { tool: 'calendar_rsvp', title: 'Send RSVP?', command: 'RSVP accepted', proposedPattern: '' }
  const SLOW = { client: undefined as unknown as BlueBubblesClient, pollMs: 50, timeoutMs: 5_000, verdictWaitMs: 40 }

  it('C4: the prompt waits for the verdict and carries it; chat Smart Approvals off → Tony\'s 👍 decides', async () => {
    const run = await newRun()
    const { judge, decisions, release } = judgeFor(false)
    release(APPROVE)
    const sentBefore = fake.sent.length
    const p = imessageApprovalChannel(run, CHAT, { client: bb, pollMs: 50, timeoutMs: 5_000 })(RSVP, { judge })
    const { promptGuid } = await promptFor(run)
    expect(fake.sent.slice(sentBefore)[0]!.message).toBe('Send RSVP?\n\nRSVP accepted\n\n⚖ low/approve — routine\n👍 to approve · 👎 to deny')
    await resolveTapback(tapback(promptGuid))
    expect(await p).toMatchObject({ approved: true })
    await judge.writes()
    expect(decisions).toEqual([['approved', 'tony']])
  })

  it('C4: the judge approves before anything is texted → nothing texted, row expired, auto/judge', async () => {
    const run = await newRun()
    const { judge, decisions, release } = judgeFor(true)
    release(APPROVE)
    const sentBefore = fake.sent.length
    expect(await imessageApprovalChannel(run, CHAT, { client: bb, pollMs: 50, timeoutMs: 5_000 })(RSVP, { judge })).toMatchObject({ approved: true })
    expect(fake.sent.length).toBe(sentBefore)
    expect((await rowsFor(run))[0]!.status).toBe('expired')
    await judge.writes()
    expect(decisions).toEqual([['auto', 'judge']])
  })

  it('C4: no verdict within the wait → "⚖ pending"; a later approving verdict withdraws the prompt (expired) and approves', async () => {
    const run = await newRun()
    const { judge, decisions, release } = judgeFor(true)
    const sentBefore = fake.sent.length
    const p = imessageApprovalChannel(run, CHAT, { ...SLOW, client: bb })(RSVP, { judge })
    await promptFor(run)
    expect(fake.sent.slice(sentBefore)[0]!.message).toBe('Send RSVP?\n\nRSVP accepted\n\n⚖ pending\n👍 to approve · 👎 to deny')
    release(APPROVE)
    expect(await p).toMatchObject({ approved: true })
    expect((await rowsFor(run))[0]!.status).toBe('expired')
    await judge.writes()
    expect(decisions).toEqual([['auto', 'judge']])
  })

  it('I1: a 👎 committed while the judge withdraws wins — the call is denied, never auto-approved', async () => {
    const run = await newRun()
    const { judge, decisions, release } = judgeFor(true)
    const p = imessageApprovalChannel(run, CHAT, { ...SLOW, client: bb })(RSVP, { judge })
    const { id } = await promptFor(run)
    // resolveTapback's first half: the guarded write commits `denied` — the waiter is not woken yet.
    await db().update(channelApprovals).set({ status: 'denied', resolvedAt: new Date() }).where(eq(channelApprovals.id, id))
    release(APPROVE)                                            // the judge withdraws in that window
    expect(await p).toMatchObject({ approved: false })
    expect((await rowsFor(run))[0]!.status).toBe('denied')
    await judge.writes()
    expect(decisions).toEqual([['denied', 'tony']])
  })

  it('M5: no tapback and a judge that never approves → the prompt times out as a timeout, never as an approval', async () => {
    const run = await newRun()
    const { judge, decisions, release } = judgeFor(true)
    release({ ...APPROVE, recommendation: 'review' })
    expect(await imessageApprovalChannel(run, CHAT, { client: bb, ...FAST })(RSVP, { judge })).toMatchObject({ approved: false })
    expect((await rowsFor(run))[0]!.status).toBe('expired')
    await judge.writes()
    expect(decisions).toEqual([['timeout', 'timeout']])
  })

  it('M5: the row already expired (housekeeping) when the judge withdraws → a timeout, never an auto-approval', async () => {
    const run = await newRun()
    const { judge, decisions, release } = judgeFor(true)
    const p = imessageApprovalChannel(run, CHAT, { ...SLOW, client: bb })(RSVP, { judge })
    const { id } = await promptFor(run)
    // The expiry committed first (catch-up housekeeping) — the waiter is not woken yet.
    await db().update(channelApprovals).set({ status: 'expired', resolvedAt: new Date() }).where(eq(channelApprovals.id, id))
    release(APPROVE)                                            // the judge's withdrawal loses to it
    expect(await p).toMatchObject({ approved: false })
    await judge.writes()
    expect(decisions).toEqual([['timeout', 'timeout']])
  })

  it('C3: Stop while the prompt is out → denied, recorded cancelled / system (not Tony\'s no)', async () => {
    const run = await newRun()
    const { judge, decisions } = judgeFor(false)
    const ac = new AbortController()
    const p = imessageApprovalChannel(run, CHAT, { ...SLOW, client: bb, signal: ac.signal })(RSVP, { judge })
    await promptFor(run)
    ac.abort()
    expect(await p).toMatchObject({ approved: false })
    await judge.writes()
    expect(decisions).toEqual([['cancelled', 'system']])
  })

  // Fix round 2 (Important): Stop beats a 👍 even when it lands before the prompt is texted.
  const recorded: string[] = []
  const rsvpTool: AgentTool = {
    name: 'calendar_rsvp', description: 'rsvp', kind: 'create', toolset: 'calendar', dangerous: true, schema: {},
    describeApproval: () => RSVP, handler: async () => { recorded.push('ran'); return { result: { ok: true }, summary: 'rsvp sent' } }
  }

  it('Stop that fires before the Stop listener exists (during the insert) → nothing texted, the tool never runs', async () => {
    const run = await newRun()
    recorded.length = 0
    // The run is stopped while the client/row are being set up: its `abort` event fired before the
    // channel listened (a no-op addEventListener), so only the re-check after registering can see it.
    let reads = 0
    const stoppedLate = { get aborted() { return reads++ > 0 }, reason: undefined, addEventListener() {}, removeEventListener() {} } as unknown as AbortSignal
    const sentBefore = fake.sent.length
    const set = buildAiTools([rsvpTool], { signal: new AbortController().signal, onEvent: () => {}, requestApproval: imessageApprovalChannel(run, CHAT, { client: bb, ...FAST, signal: stoppedLate }) })
    const out = await (set.calendar_rsvp!.execute as (i: unknown, o: { toolCallId: string }) => Promise<unknown>)({}, { toolCallId: 'c' })
    expect(out).toEqual({ denied: true })
    expect(fake.sent.length).toBe(sentBefore)                  // no prompt to 👍
    expect(recorded).toEqual([])
    expect((await rowsFor(run))[0]!.status).toBe('denied')
  })

  it('Stop while the prompt is being texted, then a 👍 → denied, the tool never runs', async () => {
    const run = await newRun()
    recorded.length = 0
    const ac = new AbortController()
    const stopOnSend: BlueBubblesClient = { ...bb, sendText: async (...a: Parameters<BlueBubblesClient['sendText']>) => { const r = await bb.sendText(...a); ac.abort(); return r } }
    const set = buildAiTools([rsvpTool], { signal: new AbortController().signal, onEvent: () => {}, requestApproval: imessageApprovalChannel(run, CHAT, { client: stopOnSend, ...FAST, signal: ac.signal }) })
    const p = (set.calendar_rsvp!.execute as (i: unknown, o: { toolCallId: string }) => Promise<unknown>)({}, { toolCallId: 'c' })
    const { promptGuid } = await promptFor(run)
    await resolveTapback(tapback(promptGuid))                  // a 👍 after Stop
    expect(await p).toEqual({ denied: true })
    expect(recorded).toEqual([])
  })

  it('fix round 2: expires_at counts from the SEND, not from before the verdict wait', async () => {
    const run = await newRun()
    const { judge, release } = judgeFor(false)
    const p = imessageApprovalChannel(run, CHAT, { client: bb, pollMs: 50, timeoutMs: 5_000, verdictWaitMs: 3_000 })(RSVP, { judge })
    await new Promise(r => setTimeout(r, 300))
    release({ ...APPROVE, recommendation: 'review' })          // the text goes out ~300 ms in
    const { promptGuid } = await promptFor(run)
    const [row] = await rowsFor(run)
    const ms = row!.expiresAt.getTime() - row!.createdAt.getTime()
    expect(ms).toBeGreaterThanOrEqual(5_000 + 250)              // send + timeout, not insert + timeout
    expect(ms).toBeLessThan(5_000 + 2_000)                      // not the provisional insert + wait + timeout
    await resolveTapback(tapback(promptGuid, { tapback: 'dislike' }))
    await p
  })

  it('fix round 2: a fast poll never reads the judge\'s own withdrawal as a timeout', async () => {
    for (let i = 0; i < 4; i++) {
      const run = await newRun()
      const { judge, decisions, release } = judgeFor(true)
      const p = imessageApprovalChannel(run, CHAT, { client: bb, pollMs: 1, timeoutMs: 5_000, verdictWaitMs: 20 })(RSVP, { judge })
      await promptFor(run)
      release(APPROVE)
      expect(await p).toMatchObject({ approved: true, decidedBy: 'judge' })
      await judge.writes()
      expect(decisions).toEqual([['auto', 'judge']])
    }
  })

  it('a judge that is off adds no line', async () => {
    const run = await newRun()
    const off = async () => ({ enabled: false, smartApprovals: { workstreams: true, chat: true }, confidence: 0.9 })
    const judge = createApprovalJudge({ tool: { name: 'exec', description: 'x' }, input: {}, req: { command: 'ls' }, nonce: `${TAG}-off`, surface: 'chat', isTainted: () => false },
      { settings: off, freshSettings: off, rule: async () => ({ floor: 'high', reasons: [] }), verdict: async () => APPROVE, recordVerdict: async () => {}, recordDecision: async () => true, pinnedSendMessageId: () => undefined, ruleContextWaitMs: 5, ruleTimeoutMs: 5_000, verdictTimeoutMs: 5_000 })
    const sentBefore = fake.sent.length
    const p = imessageApprovalChannel(run, CHAT, { client: bb, ...FAST })(REQ, { judge })
    const { promptGuid } = await promptFor(run)
    expect(fake.sent.slice(sentBefore)[0]!.message).toBe('Run `ls -la /tmp`?\n👍 to approve · 👎 to deny')
    await resolveTapback(tapback(promptGuid, { tapback: 'dislike' }))
    expect(await p).toMatchObject({ approved: false })
  })

  it('a mirrored prompt (a workstream card judged elsewhere) texts that card\'s current verdict', async () => {
    const run = await newRun()
    const sentBefore = fake.sent.length
    const p = imessageApprovalChannel(run, CHAT, {
      client: bb, ...FAST,
      verdict: () => ({ rule: { floor: 'high', reasons: [] }, pending: false, autoPossible: false, verdict: { risk: 'medium', recommendation: 'review', confidence: 0.7, reasons: ['new recipient'], model: 'J', latencyMs: 1 } })
    })(REQ)
    const { promptGuid } = await promptFor(run)
    expect(fake.sent.slice(sentBefore)[0]!.message).toBe('Run `ls -la /tmp`?\n⚖ medium/review — new recipient\n👍 to approve · 👎 to deny')
    await resolveTapback(tapback(promptGuid, { tapback: 'dislike' }))
    await p
  })

  it('a withdrawn mirror prompt (the card decided first) whose row a 👍 already committed reports the 👍', async () => {
    const run = await newRun()
    const ac = new AbortController()
    const p = imessageApprovalChannel(run, CHAT, { client: bb, pollMs: 5_000, timeoutMs: 5_000, signal: ac.signal })(REQ)
    const { id } = await promptFor(run)
    await db().update(channelApprovals).set({ status: 'approved', resolvedAt: new Date() }).where(eq(channelApprovals.id, id))
    ac.abort(APPROVAL_WITHDRAWN)
    expect(await p).toMatchObject({ approved: true })
    expect((await rowsFor(run))[0]!.status).toBe('approved')
  })
})
