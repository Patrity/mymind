// test/agent-runner.db.test.ts
//
// DB-backed test — harness copied from test/agent-runs.db.test.ts (`.env` load +
// `useRuntimeConfig` stub BEFORE importing server/db). The dev DB is shared: only rows in
// conversations this file created are deleted.
process.loadEnvFile('.env')
import { describe, it, expect, afterAll, vi } from 'vitest'
vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

// Cycle 75, Task 8: channel config is stubbed (never written — the dev DB is shared), and every
// delivery row the runner inserts is pushed to the year 2100 INSIDE the same transaction, so no
// live worker's deliveriesTick can ever find one due. Rows are tracked and deleted in afterAll.
const chan = vi.hoisted(() => ({ deliveryIds: [] as string[], failInsert: false, failPlan: false }))
// chan.failPlan: planning runs a query that FAILS on the db it was handed (which aborts a plain
// transaction), then throws — the reply must still commit.
vi.mock('../server/lib/channels/deliver', async (importOriginal) => {
  const real = await importOriginal<typeof import('../server/lib/channels/deliver')>()
  const { sql } = await import('drizzle-orm')
  return {
    ...real,
    planDeliveries: async (...args: Parameters<typeof real.planDeliveries>) => {
      if (chan.failPlan) {
        await args[2]!.execute(sql`select 1/0`)
        throw new Error('unreachable: the query above throws')
      }
      return real.planDeliveries(...args)
    }
  }
})
vi.mock('../server/lib/channels/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/lib/channels/config')>()),
  loadChannelsConfig: async () => ({
    imessage: { enabled: true, serverUrl: '', passwordEnc: null, webhookToken: 'x', allowedHandles: [], defaultHandle: '+15550000091', defaultChatGuid: 'iMessage;-;+15550000091' },
    email: { enabled: true, to: 'tony@example.test' },
    presenceAwayMinutes: 10
  })
}))
vi.mock('../server/lib/channels/outbox', async (importOriginal) => {
  const real = await importOriginal<typeof import('../server/lib/channels/outbox')>()
  const { channelDeliveries } = await import('../server/db/schema')
  const { inArray } = await import('drizzle-orm')
  return {
    ...real,
    insertDeliveries: async (tx: Parameters<typeof real.insertDeliveries>[0], rows: Parameters<typeof real.insertDeliveries>[1]) => {
      if (chan.failInsert) throw new Error('delivery insert failed')
      const ids = await real.insertDeliveries(tx, rows)
      if (ids.length) await tx.update(channelDeliveries).set({ nextAttemptAt: new Date('2100-01-01T00:00:00Z') }).where(inArray(channelDeliveries.id, ids))
      chan.deliveryIds.push(...ids)
      return ids
    }
  }
})

import { useDb } from '../server/db'
import { conversations, conversationMessages, agentRuns, agentInbox, agentJobs, agentConfigRevisions, channelApprovals, channelDeliveries } from '../server/db/schema'
import { startFakeBlueBubbles } from './fixtures/fake-bluebubbles'
import { createJob } from '../server/lib/agent/jobs/store'
import { channelPresence } from '../server/lib/channels/presence'
import { createRun, claimNextRun } from '../server/lib/agent/runtime/runs'
import { resolveSession } from '../server/lib/agent/runtime/sessions'
import { runTurn } from '../server/lib/agent/runtime/runner'
import { StreamHub } from '../server/lib/agent/runtime/stream'
import { abortRun } from '../server/lib/agent/runtime/aborts'
import { registerApprovalChannel, hasApprovalChannel, approvalFor } from '../server/lib/agent/runtime/approvals'
import { appendMessages } from '../server/services/conversations'
import { pushSteer } from '../server/lib/agent/runtime/inbox'
import { jobOutcomeOf } from '../server/lib/agent/jobs/outcome'
import { and, eq, inArray, like } from 'drizzle-orm'

const convIds: string[] = []
// Runs here are never finished (runTurn leaves that to its caller), so a headless run stays
// 'running' and would block the next wake claim at the real 1-slot limit.
const HEADLESS_TEST_SLOTS = 1000
afterAll(async () => {
  const db = useDb()
  if (chan.deliveryIds.length) await db.delete(channelDeliveries).where(inArray(channelDeliveries.id, chan.deliveryIds))
  const jobs = await db.select({ id: agentJobs.id }).from(agentJobs).where(like(agentJobs.slug, 'rtest-deliver-%'))
  if (jobs.length) {
    await db.delete(agentConfigRevisions).where(and(eq(agentConfigRevisions.targetKind, 'job'), inArray(agentConfigRevisions.targetId, jobs.map(j => j.id))))
    await db.delete(agentJobs).where(inArray(agentJobs.id, jobs.map(j => j.id)))
  }
  await db.delete(agentInbox).where(inArray(agentInbox.conversationId, convIds))
  await db.delete(agentRuns).where(inArray(agentRuns.conversationId, convIds))
  await db.delete(conversationMessages).where(inArray(conversationMessages.conversationId, convIds))
  await db.delete(conversations).where(inArray(conversations.id, convIds))
})

const noAssemble = async () => ({ context: '', usedMemoryIds: [], used: 0, droppedTurns: 0 })
function fakeAgent(reply: string, opts: { delayMs?: number } = {}) {
  return async function* (_m: unknown, ctx: { signal: AbortSignal }) {
    for (const ch of reply.split(' ')) {
      if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs))
      if (ctx.signal.aborted) return
      yield { type: 'text-delta', text: ch + ' ' } as const
    }
    yield { type: 'done' } as const
  }
}
async function queued(text: string, extra: Partial<Parameters<typeof createRun>[0]> = {}) {
  const s = await resolveSession('thread:new', { titleHint: `RUNNER-TEST ${text}` })
  convIds.push(s.conversationId)
  await createRun({ conversationId: s.conversationId, sessionKey: `thread:${s.conversationId}`, trigger: 'user', profile: 'interactive', input: { text, modality: 'text' }, ...extra })
  const run = await claimNextRun({ onlyConversations: [s.conversationId] })
  return { run: run!, conversationId: s.conversationId }
}
// Rows of one appendMessages call share created_at, so (created_at, id) cannot order them —
// the parent chain can. Walks from the root of a single-branch thread.
async function chain(id: string) {
  const all = await rows(id)
  const out: typeof all = []
  let next = all.find(x => x.parentId === null)
  while (next) {
    out.push(next)
    const at = next.id
    next = all.find(x => x.parentId === at)
  }
  expect(out.length).toBe(all.length) // single branch, nothing orphaned
  return out
}
// Drains once mid-stream (as runAgent's prepareStep would at a step boundary), after a steer was
// pushed for this very run, then replies — or throws, for the rescue path.
function steeredAgent(runId: string, conversationId: string, steer: string, opts: { reply?: string, throwAfter?: boolean } = {}) {
  return async function* (_m: unknown, ctx: { signal: AbortSignal, drainSteer?: () => Promise<string[]> }) {
    yield { type: 'text-delta', text: 'first ' } as const
    await pushSteer(runId, conversationId, steer, 'user')
    const got = await ctx.drainSteer!()
    expect(got).toEqual([steer]) // the runner hands runAgent the drained text unchanged
    if (opts.throwAfter) throw new Error('model died')
    if (opts.reply !== undefined) yield { type: 'text-delta', text: opts.reply } as const
    yield { type: 'done' } as const
  }
}
const rows = (id: string) => useDb().select().from(conversationMessages).where(eq(conversationMessages.conversationId, id)).orderBy(conversationMessages.createdAt, conversationMessages.id)

describe('runTurn', () => {
  it('runs with no subscriber at all and persists user + assistant', async () => {
    const { run, conversationId } = await queued('hello')
    const out = await runTurn(run, { runAgent: fakeAgent('hi there') as never, assemble: noAssemble as never, hub: new StreamHub() })
    expect(out.status).toBe('done')
    const r = await rows(conversationId)
    // Sorted by role, not (created_at, id): both rows share one transaction's now(), so the
    // id tie-break orders them arbitrarily.
    expect(r.map(x => [x.role, x.content.trim()]).sort()).toEqual([['assistant', 'hi there'], ['user', 'hello']])
    expect(out.userMessageId).toBeTruthy()
    expect(out.assistantMessageId).toBeTruthy()
    // The ids must name the RIGHT rows, not merely two rows.
    expect(r.find(x => x.id === out.userMessageId)?.role).toBe('user')
    expect(r.find(x => x.id === out.assistantMessageId)?.role).toBe('assistant')
  })

  it('drops the run\'s approval channel when the run ends (no leak until socket close)', async () => {
    const { run } = await queued('channel')
    registerApprovalChannel(run.id, async () => ({ approved: false }))
    expect(hasApprovalChannel(run.id)).toBe(true)
    await runTurn(run, { runAgent: fakeAgent('ok') as never, assemble: noAssemble as never, hub: new StreamHub() })
    expect(hasApprovalChannel(run.id)).toBe(false)
  })

  it('cycle 75: a run with no socket channel gets the reply_to (iMessage) channel; a socket channel is kept', async () => {
    const a = await queued('no socket')
    let during = false
    const probe = async function* () {
      during = hasApprovalChannel(a.run.id)
      yield { type: 'text-delta', text: 'ok ' } as const
      yield { type: 'done' } as const
    }
    await runTurn(a.run, { runAgent: probe as never, assemble: noAssemble as never, hub: new StreamHub() })
    expect(during).toBe(true)
    expect(hasApprovalChannel(a.run.id)).toBe(false)

    const b = await queued('socket')
    const socket = vi.fn(async () => ({ approved: true }))
    registerApprovalChannel(b.run.id, socket)
    let asked: { approved: boolean } | null = null
    const asks = async function* () {
      // A tool name no allowlist row uses, so approvalFor falls through to the channel.
      asked = await approvalFor(b.run.id)({ tool: `exec-rtest-${Date.now()}`, command: 'rtest cmd', proposedPattern: 'rtest *' })
      yield { type: 'text-delta', text: 'ok ' } as const
      yield { type: 'done' } as const
    }
    await runTurn(b.run, { runAgent: asks as never, assemble: noAssemble as never, hub: new StreamHub() })
    expect(socket).toHaveBeenCalledTimes(1)
    expect(asked).toEqual({ approved: true })
  })

  it('appendMessages returns the inserted ids in insertion order', async () => {
    // The rows of one call share a created_at, so this return value is the only reliable order.
    const s = await resolveSession('thread:new', { titleHint: 'RUNNER-TEST append-ids' })
    convIds.push(s.conversationId)
    const ids = await appendMessages(s.conversationId, ['a', 'b', 'c'].map(c => ({ role: 'user' as const, content: c, modality: 'text' as const })))
    const r = await rows(s.conversationId)
    expect(ids.map(id => r.find(x => x.id === id)?.content)).toEqual(['a', 'b', 'c'])
  })

  it('streams frames to a subscriber and ends with a persisted frame', async () => {
    const { run, conversationId } = await queued('stream me')
    const hub = new StreamHub()
    const got: string[] = []
    hub.subscribe(conversationId, { id: 's', send: (d) => {
      if (typeof d === 'string') got.push(d)
    } })
    await runTurn(run, { runAgent: fakeAgent('ok') as never, assemble: noAssemble as never, hub })
    const types = got.map(f => JSON.parse(f).type)
    expect(types).toContain('user-message')
    expect(types).toContain('chunk')
    expect(types[types.length - 1]).toBe('persisted')
  })

  it('an abort mid-reply rescues what was said and reports aborted', async () => {
    const { run, conversationId } = await queued('long one')
    const p = runTurn(run, { runAgent: fakeAgent('one two three four five six', { delayMs: 30 }) as never, assemble: noAssemble as never, hub: new StreamHub() })
    await new Promise(r => setTimeout(r, 70))
    abortRun(run.id)
    const out = await p
    expect(out.status).toBe('aborted')
    const r = await rows(conversationId)
    expect(r.find(x => x.role === 'user')?.content).toBe('long one') // the question survives
    // …and so does what Bridget had said before the Stop.
    expect(r.find(x => x.role === 'assistant')?.content.trim()).toMatch(/^one\b/)
  })

  it('an abort that surfaces as a non-AbortError is still reported aborted', async () => {
    const { run } = await queued('torn down')
    const tearsDown = async function* (_m: unknown, ctx: { signal: AbortSignal }) {
      yield { type: 'text-delta', text: 'start ' } as const
      await new Promise(r => setTimeout(r, 60))
      if (ctx.signal.aborted) throw new Error('socket hang up')
      yield { type: 'text-delta', text: 'never' } as const
    }
    const p = runTurn(run, { runAgent: tearsDown as never, assemble: noAssemble as never, hub: new StreamHub() })
    await new Promise(r => setTimeout(r, 20))
    abortRun(run.id)
    expect((await p).status).toBe('aborted')
  })

  // Cycle 74 D4 (replaces cycle 73's "the event row is kept"): a silent run leaves NOTHING in
  // the thread — only its agent_runs row (outcome suppressed). No rows, no persisted frame.
  it('a wake run that replies NO_REPLY persists zero rows and publishes no persisted frame', async () => {
    const s = await resolveSession('thread:new', { titleHint: 'RUNNER-TEST wake' })
    convIds.push(s.conversationId)
    await createRun({ conversationId: s.conversationId, sessionKey: `thread:${s.conversationId}`, trigger: 'wake', profile: 'headless', wakeReason: 'admin', input: { text: 'anything new?', modality: 'text' } })
    const run = (await claimNextRun({ onlyConversations: [s.conversationId], headlessSlots: HEADLESS_TEST_SLOTS }))!
    const hub = new StreamHub()
    const got: string[] = []
    hub.subscribe(s.conversationId, { id: 'watcher', send: (d) => {
      if (typeof d === 'string') got.push(d)
    } })
    const afterPersist = vi.fn()
    const out = await runTurn(run, { runAgent: fakeAgent('NO_REPLY') as never, assemble: noAssemble as never, hub, afterPersist })
    expect(out).toMatchObject({ status: 'done', suppressed: true })
    // The run's outcome is the only trace — and a job reads it as 'silent' (Task 5's onRunFinished).
    expect(jobOutcomeOf(out).outcome).toBe('silent')
    expect(await rows(s.conversationId)).toEqual([])
    expect(got.map(f => JSON.parse(f).type)).not.toContain('persisted')
    expect(got.map(f => JSON.parse(f).type)).not.toContain('conversation')
    expect(afterPersist).not.toHaveBeenCalled()
  })

  it('a speaking wake run persists [event, assistant]', async () => {
    const s = await resolveSession('thread:new', { titleHint: 'RUNNER-TEST wake speaks' })
    convIds.push(s.conversationId)
    await createRun({ conversationId: s.conversationId, sessionKey: `thread:${s.conversationId}`, trigger: 'wake', profile: 'headless', wakeReason: 'admin', input: { text: 'anything new?', modality: 'text' } })
    const run = (await claimNextRun({ onlyConversations: [s.conversationId], headlessSlots: HEADLESS_TEST_SLOTS }))!
    const out = await runTurn(run, { runAgent: fakeAgent('the build is red') as never, assemble: noAssemble as never, hub: new StreamHub() })
    expect(out).toMatchObject({ status: 'done', suppressed: false })
    expect((await chain(s.conversationId)).map(x => [x.role, x.origin, x.content.trim()])).toEqual([
      ['event', 'wake:admin', 'anything new?'],
      ['assistant', null, 'the build is red']
    ])
  })

  // Cycle 74: `context: 'light'` sends only the last LIGHT_CONTEXT_TURNS (4) turns of history.
  it('a light-context wake over a 10-turn thread sends the model at most 4 prior turns', async () => {
    const s = await resolveSession('thread:new', { titleHint: 'RUNNER-TEST wake light' })
    convIds.push(s.conversationId)
    for (let i = 0; i < 10; i++) {
      await appendMessages(s.conversationId, [
        { role: 'user', content: `q${i}`, modality: 'text' },
        { role: 'assistant', content: `a${i}`, modality: 'text' }
      ])
    }
    await createRun({ conversationId: s.conversationId, sessionKey: `thread:${s.conversationId}`, trigger: 'wake', profile: 'headless', wakeReason: 'light', input: { text: 'anything new?', modality: 'text', context: 'light' } })
    const run = (await claimNextRun({ onlyConversations: [s.conversationId], headlessSlots: HEADLESS_TEST_SLOTS }))!
    let sent: { role: string, content: unknown }[] = []
    const capture = async function* (m: { role: string, content: unknown }[]) {
      sent = m
      yield { type: 'text-delta', text: 'NO_REPLY' } as const
      yield { type: 'done' } as const
    }
    await runTurn(run, { runAgent: capture as never, assemble: noAssemble as never, hub: new StreamHub() })
    const users = sent.filter(x => x.role === 'user')
    expect(users.length).toBeLessThanOrEqual(5) // 4 prior turns + the current prompt
    expect(users.slice(0, -1).map(x => x.content)).toEqual(['q6', 'q7', 'q8', 'q9'])
  })

  it('a full-context wake over the same kind of thread still sends every turn', async () => {
    const s = await resolveSession('thread:new', { titleHint: 'RUNNER-TEST wake full' })
    convIds.push(s.conversationId)
    for (let i = 0; i < 10; i++) {
      await appendMessages(s.conversationId, [
        { role: 'user', content: `q${i}`, modality: 'text' },
        { role: 'assistant', content: `a${i}`, modality: 'text' }
      ])
    }
    await createRun({ conversationId: s.conversationId, sessionKey: `thread:${s.conversationId}`, trigger: 'wake', profile: 'headless', wakeReason: 'full', input: { text: 'anything new?', modality: 'text' } })
    const run = (await claimNextRun({ onlyConversations: [s.conversationId], headlessSlots: HEADLESS_TEST_SLOTS }))!
    let sent: { role: string }[] = []
    const capture = async function* (m: { role: string }[]) {
      sent = m
      yield { type: 'text-delta', text: 'NO_REPLY' } as const
      yield { type: 'done' } as const
    }
    await runTurn(run, { runAgent: capture as never, assemble: noAssemble as never, hub: new StreamHub() })
    expect(sent.filter(x => x.role === 'user')).toHaveLength(11)
  })

  // Controller ruling (carried from Task 7's concern, tightened in fix round 1): a suppressed
  // NO_REPLY wake used to stream its text live to any subscribed socket before being dropped,
  // AND (separately) the usage re-emit below used to open an EMPTY assistant message live for
  // every wake run — ttftMs gets set from the withheld transcript even though nothing was ever
  // actually streamed, so the old guard (`ttftMs !== undefined`) fired regardless. A wake run's
  // assistant TEXT and REASONING must never reach a live subscriber, and with nothing else
  // streamable (no real usage event, as this fake agent never emits one), NO chunk frame at all
  // should reach the subscriber — only the `persisted` re-read shows the (real or absent) reply.
  it('a subscribed sink on a wake run that replies NO_REPLY receives no chunk frames at all', async () => {
    const s = await resolveSession('thread:new', { titleHint: 'RUNNER-TEST wake stream' })
    convIds.push(s.conversationId)
    await createRun({ conversationId: s.conversationId, sessionKey: `thread:${s.conversationId}`, trigger: 'wake', profile: 'headless', wakeReason: 'stream-test', input: { text: 'anything new?', modality: 'text' } })
    const run = (await claimNextRun({ onlyConversations: [s.conversationId], headlessSlots: HEADLESS_TEST_SLOTS }))!
    const hub = new StreamHub()
    const got: string[] = []
    hub.subscribe(s.conversationId, { id: 'watcher', send: (d) => { if (typeof d === 'string') got.push(d) } })
    const out = await runTurn(run, { runAgent: fakeAgent('NO_REPLY') as never, assemble: noAssemble as never, hub })
    expect(out.suppressed).toBe(true)
    const chunkTypes = got.filter(f => JSON.parse(f).type === 'chunk').map(f => JSON.parse(f).chunk.type)
    // Nothing streamable happened (text withheld, no usage event) — no start/finish either.
    expect(chunkTypes).toEqual([])
  })

  it('withholds reasoning frames on a wake run too, even for a real (non-suppressed) reply', async () => {
    const s = await resolveSession('thread:new', { titleHint: 'RUNNER-TEST wake reasoning' })
    convIds.push(s.conversationId)
    await createRun({ conversationId: s.conversationId, sessionKey: `thread:${s.conversationId}`, trigger: 'wake', profile: 'headless', wakeReason: 'reasoning-test', input: { text: 'anything new?', modality: 'text' } })
    const run = (await claimNextRun({ onlyConversations: [s.conversationId], headlessSlots: HEADLESS_TEST_SLOTS }))!
    const thinksThenReplies = async function* () {
      yield { type: 'reasoning-delta', text: 'thinking it over' } as const
      yield { type: 'text-delta', text: 'nothing new' } as const
      yield { type: 'done' } as const
    }
    const hub = new StreamHub()
    const got: string[] = []
    hub.subscribe(s.conversationId, { id: 'watcher', send: (d) => { if (typeof d === 'string') got.push(d) } })
    const out = await runTurn(run, { runAgent: thinksThenReplies as never, assemble: noAssemble as never, hub })
    expect(out.suppressed).toBe(false) // a real reply, not NO_REPLY — still must not stream live
    const chunkTypes = got.filter(f => JSON.parse(f).type === 'chunk').map(f => JSON.parse(f).chunk.type)
    expect(chunkTypes).toEqual([])
  })

  // Fix round 1 ruling: a wake run streams ONLY state frames. With D4 a silent wake sends no
  // `persisted` re-read, so a tool/usage chunk that opened a live assistant message would stay
  // on screen as a ghost — and strand the viewer's next re-read (screen N+1 vs server N).
  it('a wake run with tool calls and usage streams no chunk or user-message frames, only state', async () => {
    const { run, conversationId } = await wakeRun('tools-live')
    const hub = new StreamHub()
    const got: string[] = []
    hub.subscribe(conversationId, { id: 'watcher', send: (d) => {
      if (typeof d === 'string') got.push(d)
    } })
    const toolsThenSilent = async function* () {
      yield { type: 'tool-start', callId: 'c1', name: 'search_tasks', args: {} } as const
      yield { type: 'tool-result', callId: 'c1', name: 'search_tasks', summary: 'listed tasks (0)', args: {}, result: { hits: 0 }, kind: 'read' } as const
      yield { type: 'usage', inputTokens: 10, outputTokens: 2, totalTokens: 12 } as const
      yield { type: 'text-delta', text: 'NO_REPLY' } as const
      yield { type: 'done' } as const
    }
    const out = await runTurn(run, { runAgent: toolsThenSilent as never, assemble: noAssemble as never, hub })
    expect(out).toMatchObject({ status: 'done', suppressed: true })
    const types = got.map(f => JSON.parse(f).type)
    expect(types).not.toContain('chunk')
    expect(types).not.toContain('user-message')
    expect(types).toContain('state') // state still streams (the tool indicator)
    expect(await rows(conversationId)).toEqual([])
  })

  // Fix round 1 ruling: an empty (trimmed) final reply on a wake is silent too — nothing persists
  // and the job reads it as 'silent', matching the rescue path.
  it('a wake whose final reply is empty persists nothing and is silent', async () => {
    const { run, conversationId } = await wakeRun('empty-reply')
    const blank = async function* () {
      yield { type: 'text-delta', text: '   ' } as const
      yield { type: 'done' } as const
    }
    const afterPersist = vi.fn()
    const out = await runTurn(run, { runAgent: blank as never, assemble: noAssemble as never, hub: new StreamHub(), afterPersist })
    expect(out).toMatchObject({ status: 'done', suppressed: true })
    expect(jobOutcomeOf(out).outcome).toBe('silent')
    expect(await rows(conversationId)).toEqual([])
    expect(afterPersist).not.toHaveBeenCalled()
  })

  it('a thrown agent error marks the run failed and still keeps the question', async () => {
    const { run, conversationId } = await queued('explode')
    const boom = async function* () {
      yield { type: 'text-delta', text: 'partial ' } as const
      throw new Error('model died')
    }
    const out = await runTurn(run, { runAgent: boom as never, assemble: noAssemble as never, hub: new StreamHub() })
    expect(out.status).toBe('failed')
    expect(out.error).toMatch(/model died/)
    expect((await rows(conversationId)).find(x => x.role === 'user')?.content).toBe('explode')
  })

  it('cycle 75: an inbound-iMessage run stamps input.origin on its user row only — normal and rescue paths', async () => {
    const origin = 'imessage:iMessage;-;+15551234567'
    const ok = await queued('from my phone', { input: { text: 'from my phone', modality: 'text', origin } })
    await runTurn(ok.run, { runAgent: fakeAgent('got it') as never, assemble: noAssemble as never, hub: new StreamHub() })
    const r1 = await rows(ok.conversationId)
    expect(r1.find(x => x.role === 'user')?.origin).toBe(origin)
    expect(r1.find(x => x.role === 'assistant')?.origin).toBeNull()

    const bad = await queued('phone then boom', { input: { text: 'phone then boom', modality: 'text', origin } })
    const boom = async function* () {
      yield { type: 'text-delta', text: 'partial ' } as const
      throw new Error('model died')
    }
    await runTurn(bad.run, { runAgent: boom as never, assemble: noAssemble as never, hub: new StreamHub() })
    const r2 = await rows(bad.conversationId)
    expect(r2.find(x => x.role === 'user')?.origin).toBe(origin)
  })

  it('a failure before the model ever runs (assembly throws) still keeps the question', async () => {
    const { run, conversationId } = await queued('before-model')
    const boom = async () => {
      throw new Error('assembler exploded')
    }
    const out = await runTurn(run, { runAgent: fakeAgent('never') as never, assemble: boom as never, hub: new StreamHub() })
    expect(out.status).toBe('failed')
    expect((await rows(conversationId)).map(r => [r.role, r.content])).toEqual([['user', 'before-model']])
  })

  async function wakeRun(reason: string) {
    const s = await resolveSession('thread:new', { titleHint: `RUNNER-TEST wake ${reason}` })
    convIds.push(s.conversationId)
    await createRun({ conversationId: s.conversationId, sessionKey: `thread:${s.conversationId}`, trigger: 'wake', profile: 'headless', wakeReason: reason, input: { text: 'anything new?', modality: 'text' } })
    return { run: (await claimNextRun({ onlyConversations: [s.conversationId], headlessSlots: HEADLESS_TEST_SLOTS }))!, conversationId: s.conversationId }
  }
  function throwsAfter(text: string) {
    return async function* () {
      yield { type: 'text-delta', text } as const
      throw new Error('model died')
    }
  }

  it('a wake that throws rescues an EVENT row (raw prompt) plus the partial reply', async () => {
    const { run, conversationId } = await wakeRun('rescue')
    const out = await runTurn(run, { runAgent: throwsAfter('half an answer ') as never, assemble: noAssemble as never, hub: new StreamHub() })
    expect(out.status).toBe('failed')
    const r = await rows(conversationId)
    expect(r.map(x => [x.role, x.origin, x.content.trim()]).sort()).toEqual([
      ['assistant', null, 'half an answer'],
      ['event', 'wake:rescue', 'anything new?']
    ])
  })

  // Cycle 74 D4 (replaces cycle 73's "rescues only the event row"): the event row is
  // meaningless alone, so a rescued wake with a suppressed or empty reply persists nothing.
  it('a wake that throws after NO_REPLY rescues nothing', async () => {
    const { run, conversationId } = await wakeRun('rescue-silent')
    const afterPersist = vi.fn()
    const out = await runTurn(run, { runAgent: throwsAfter('NO_REPLY ') as never, assemble: noAssemble as never, hub: new StreamHub(), afterPersist })
    expect(out.status).toBe('failed')
    expect(await rows(conversationId)).toEqual([])
    expect(afterPersist).not.toHaveBeenCalled()
  })

  it('a wake that throws before saying anything rescues nothing', async () => {
    const { run, conversationId } = await wakeRun('rescue-empty')
    // eslint-disable-next-line require-yield -- the model dies before its first token
    const boom = async function* () {
      throw new Error('model died')
    }
    const out = await runTurn(run, { runAgent: boom as never, assemble: noAssemble as never, hub: new StreamHub() })
    expect(out.status).toBe('failed')
    expect(await rows(conversationId)).toEqual([])
  })

  it('afterPersist fires when the turn persisted or was rescued, and not otherwise', async () => {
    const seen: string[] = []
    const afterPersist = (id: string) => seen.push(id)
    const ok = await queued('persist me')
    await runTurn(ok.run, { runAgent: fakeAgent('fine') as never, assemble: noAssemble as never, hub: new StreamHub(), afterPersist })
    expect(seen).toEqual([ok.conversationId])

    const bad = await queued('rescue me')
    await runTurn(bad.run, { runAgent: throwsAfter('partial ') as never, assemble: noAssemble as never, hub: new StreamHub(), afterPersist })
    expect(seen).toEqual([ok.conversationId, bad.conversationId])

    // Nothing to persist and nothing to rescue: an empty question produces no rows at all.
    const empty = await queued('')
    await runTurn(empty.run, { runAgent: fakeAgent('never') as never, assemble: noAssemble as never, hub: new StreamHub(), afterPersist })
    expect(await rows(empty.conversationId)).toEqual([])
    expect(seen).toEqual([ok.conversationId, bad.conversationId])
  })

  describe('steers drained mid-turn are persisted as user rows, in order (spec §4.4)', () => {
    it('success: [question, steer, reply] in one chain, ids name the question and the reply', async () => {
      const { run, conversationId } = await queued('the question')
      const out = await runTurn(run, { runAgent: steeredAgent(run.id, conversationId, 'actually, also this', { reply: 'done' }) as never, assemble: noAssemble as never, hub: new StreamHub() })
      expect(out.status).toBe('done')
      const c = await chain(conversationId)
      expect(c.map(x => [x.role, x.modality, x.content.trim()])).toEqual([
        ['user', 'text', 'the question'],
        ['user', 'text', 'actually, also this'],
        ['assistant', 'text', 'first done']
      ])
      expect(out.userMessageId).toBe(c[0]!.id)
      expect(out.assistantMessageId).toBe(c[2]!.id)
    })

    it('a drained steer survives a run that produced no reply at all', async () => {
      const { run, conversationId } = await queued('quiet question')
      const silent = async function* (_m: unknown, ctx: { drainSteer?: () => Promise<string[]> }) {
        await pushSteer(run.id, conversationId, 'hello?', 'user')
        await ctx.drainSteer!()
        yield { type: 'done' } as const
      }
      const out = await runTurn(run, { runAgent: silent as never, assemble: noAssemble as never, hub: new StreamHub() })
      expect(out.status).toBe('done')
      expect((await chain(conversationId)).map(x => [x.role, x.content])).toEqual([['user', 'quiet question'], ['user', 'hello?']])
      expect(out.assistantMessageId).toBeUndefined()
    })

    it('rescue (throw after the drain): [question, steer, partial reply]', async () => {
      const { run, conversationId } = await queued('doomed question')
      const out = await runTurn(run, { runAgent: steeredAgent(run.id, conversationId, 'wait, one more thing', { throwAfter: true }) as never, assemble: noAssemble as never, hub: new StreamHub() })
      expect(out.status).toBe('failed')
      expect((await chain(conversationId)).map(x => [x.role, x.content.trim()])).toEqual([
        ['user', 'doomed question'],
        ['user', 'wait, one more thing'],
        ['assistant', 'first']
      ])
    })

    it('rescue with a blank question keeps the steer AND the partial reply: [steer, partial]', async () => {
      // An empty question never reaches the model (handleTurn returns early), so the reachable
      // case is whitespace-only. partialTurnMessages alone would drop the reply as unattributable.
      const { run, conversationId } = await queued('   ')
      const out = await runTurn(run, { runAgent: steeredAgent(run.id, conversationId, 'are you there?', { throwAfter: true }) as never, assemble: noAssemble as never, hub: new StreamHub() })
      expect(out.status).toBe('failed')
      expect((await chain(conversationId)).map(x => [x.role, x.content.trim()])).toEqual([
        ['user', 'are you there?'],
        ['assistant', 'first']
      ])
    })

    it('a wake run keeps its event row first: [event, steer, reply]', async () => {
      const { run, conversationId } = await wakeRun('steered')
      const out = await runTurn(run, { runAgent: steeredAgent(run.id, conversationId, 'Tony chimed in', { reply: 'noted' }) as never, assemble: noAssemble as never, hub: new StreamHub() })
      expect(out.status).toBe('done')
      const c = await chain(conversationId)
      expect(c.map(x => [x.role, x.origin, x.content.trim()])).toEqual([
        ['event', 'wake:steered', 'anything new?'],
        ['user', null, 'Tony chimed in'],
        ['assistant', null, 'first noted']
      ])
      expect(out.userMessageId).toBe(c[0]!.id)
      expect(out.assistantMessageId).toBe(c[2]!.id)
    })
  })
})

// Cycle 75, Task 8: the reply's channel deliveries are written in the persist transaction.
describe('runTurn — channel deliveries', () => {
  const CHAT = 'iMessage;-;+15550000092'
  const replyTo = { channel: 'imessage' as const, chatGuid: CHAT, messageGuid: 'in-1' }
  // Inserted straight in 'running' (never queued), so no live worker can claim it first.
  async function running(text: string, extra: Partial<typeof agentRuns.$inferInsert> = {}) {
    const s = await resolveSession('thread:new', { titleHint: `RUNNER-TEST ${text}` })
    convIds.push(s.conversationId)
    const [run] = await useDb().insert(agentRuns).values({
      conversationId: s.conversationId, sessionKey: `thread:${s.conversationId}`, trigger: 'user', profile: 'interactive',
      status: 'running', claimedAt: new Date(), aliveAt: new Date(), owner: 'runner-test', input: { text, modality: 'text' }, ...extra
    }).returning()
    return { run: run!, conversationId: s.conversationId }
  }
  const deliveriesOf = (conversationId: string) => useDb().select().from(channelDeliveries).where(eq(channelDeliveries.conversationId, conversationId))
  const boom = async function* () {
    yield { type: 'text-delta', text: 'partial ' } as const
    throw new Error('model died')
  }

  it('a run with replyTo writes one iMessage delivery pointing at the persisted reply', async () => {
    const { run, conversationId } = await running('text me back', { replyTo })
    const out = await runTurn(run, { runAgent: fakeAgent('on it') as never, assemble: noAssemble as never, hub: new StreamHub() })
    expect(out.status).toBe('done')
    const d = await deliveriesOf(conversationId)
    expect(d).toHaveLength(1)
    expect(d[0]).toMatchObject({ channel: 'imessage', target: CHAT, source: 'reply', status: 'pending', messageId: out.assistantMessageId, runId: run.id, payload: { text: 'on it' } })
  })

  it('a job wake writes its deliver channels; a silent (NO_REPLY) one writes none', async () => {
    const job = await createJob({ slug: 'rtest-deliver-email', content: '---\ntrigger: every 30m\ndeliver: [email]\nenabled: false\n---\nBrief.\n', actor: 'human' })
    const wake = { trigger: 'wake', profile: 'headless', jobId: job.id, wakeReason: `job:${job.slug}`, input: { text: 'Brief.', modality: 'text' } } as const
    const a = await running('job wake', wake)
    const out = await runTurn(a.run, { runAgent: fakeAgent('Morning.') as never, assemble: noAssemble as never, hub: new StreamHub() })
    const d = await deliveriesOf(a.conversationId)
    expect(d).toHaveLength(1)
    expect(d[0]).toMatchObject({ channel: 'email', target: 'tony@example.test', source: 'job', jobId: job.id, messageId: out.assistantMessageId, payload: { subject: 'Bridget · rtest-deliver-email' } })

    const b = await running('silent job wake', wake)
    await runTurn(b.run, { runAgent: fakeAgent('NO_REPLY') as never, assemble: noAssemble as never, hub: new StreamHub() })
    expect(await deliveriesOf(b.conversationId)).toHaveLength(0)
  })

  it('starts the chat presence (read + typing) with the run and stops it when the run ends, even on failure', async () => {
    const start = vi.spyOn(channelPresence, 'start')
    const stop = vi.spyOn(channelPresence, 'stop')
    try {
      const ok = await running('presence ok', { replyTo })
      await runTurn(ok.run, { runAgent: fakeAgent('hi') as never, assemble: noAssemble as never, hub: new StreamHub() })
      expect(start).toHaveBeenCalledWith(ok.run)
      expect(stop).toHaveBeenCalledWith(ok.run)
      const bad = await running('presence boom', { replyTo })
      await runTurn(bad.run, { runAgent: boom as never, assemble: noAssemble as never, hub: new StreamHub() })
      expect(stop).toHaveBeenCalledWith(bad.run)
    } finally {
      start.mockRestore()
      stop.mockRestore()
    }
  })

  // Final review I1: the runner hands the run's abort signal to the iMessage approval channel.
  it('Stop during an iMessage approval wait unwinds the run at once and denies the approval row', async () => {
    const bb = await startFakeBlueBubbles({ privateApi: true })
    const prev = process.env.BLUEBUBBLES_FAKE_URL
    process.env.BLUEBUBBLES_FAKE_URL = bb.url // the runner's own imessageClient() → the fake
    try {
      const { run } = await running('approve over imessage', { replyTo })
      const agent = async function* (_m: unknown, ctx: { requestApproval?: (r: { tool: string; command: string; proposedPattern: string }) => Promise<{ approved: boolean }> }) {
        const r = await ctx.requestApproval!({ tool: 'exec', command: 'rtest-i1-abort-approval', proposedPattern: 'rtest-i1-abort-approval' })
        yield { type: 'text-delta', text: r.approved ? 'ran it' : 'not run' } as const
        yield { type: 'done' } as const
      }
      const turn = runTurn(run, { runAgent: agent as never, assemble: noAssemble as never, hub: new StreamHub() })
      let prompted = false
      for (let i = 0; i < 200 && !prompted; i++) {
        const [a] = await useDb().select().from(channelApprovals).where(eq(channelApprovals.runId, run.id))
        prompted = !!a?.promptGuid
        if (!prompted) await new Promise(r => setTimeout(r, 10))
      }
      expect(prompted).toBe(true)
      expect(bb.sent.at(-1)).toMatchObject({ kind: 'text', chatGuid: CHAT })
      const t0 = Date.now()
      abortRun(run.id)
      const out = await turn
      expect(out.status).toBe('aborted')
      expect(Date.now() - t0).toBeLessThan(2_000) // not the 10-minute approval expiry
      const [a] = await useDb().select().from(channelApprovals).where(eq(channelApprovals.runId, run.id))
      expect(a!.status).toBe('denied')
    } finally {
      if (prev === undefined) delete process.env.BLUEBUBBLES_FAKE_URL
      else process.env.BLUEBUBBLES_FAKE_URL = prev
      await bb.close()
    }
  })

  it('an ordinary app run writes no delivery', async () => {
    const { run, conversationId } = await running('just the app')
    await runTurn(run, { runAgent: fakeAgent('hello') as never, assemble: noAssemble as never, hub: new StreamHub() })
    expect(await rows(conversationId)).toHaveLength(2)
    expect(await deliveriesOf(conversationId)).toHaveLength(0)
  })

  it('a rescued (crashed) turn with replyTo writes no delivery', async () => {
    const { run, conversationId } = await running('phone then crash', { replyTo })
    const out = await runTurn(run, { runAgent: boom as never, assemble: noAssemble as never, hub: new StreamHub() })
    expect(out.status).toBe('failed')
    expect((await rows(conversationId)).map(r => r.role).sort()).toEqual(['assistant', 'user']) // rescued
    expect(await deliveriesOf(conversationId)).toHaveLength(0)
  })

  it('a planning failure (even a failed query on the transaction) still saves the reply, without deliveries', async () => {
    const { run, conversationId } = await running('plan fails', { replyTo })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    chan.failPlan = true
    try {
      const out = await runTurn(run, { runAgent: fakeAgent('still saved') as never, assemble: noAssemble as never, hub: new StreamHub() })
      expect(out.status).toBe('done')
      const r = await rows(conversationId)
      expect(r).toHaveLength(2)
      expect(r.find(x => x.id === out.assistantMessageId)?.content).toBe('still saved')
      expect(await deliveriesOf(conversationId)).toHaveLength(0)
      expect(err).toHaveBeenCalledWith('[agent] planning channel deliveries failed:', expect.anything())
    } finally {
      chan.failPlan = false
      err.mockRestore()
    }
  })

  it('a failing delivery insert rolls back the success-path append with it', async () => {
    const { run, conversationId } = await running('insert fails', { replyTo })
    chan.failInsert = true
    try {
      const out = await runTurn(run, { runAgent: fakeAgent('never lands') as never, assemble: noAssemble as never, hub: new StreamHub() })
      // The success append threw (so the turn failed); only the rescue's copy exists — one pair, not two.
      expect(out.status).toBe('failed')
      expect(await rows(conversationId)).toHaveLength(2)
      expect(await deliveriesOf(conversationId)).toHaveLength(0)
    } finally {
      chan.failInsert = false
    }
  })
})
