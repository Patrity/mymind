// test/agent-queue.db.test.ts
//
// DB-backed test — harness copied from test/agent-runs.db.test.ts (`.env` load +
// `useRuntimeConfig` stub BEFORE importing server/db). The dev DB is shared: only rows in
// conversations this file created are deleted.
process.loadEnvFile('.env')
import { describe, it, expect, afterAll, vi } from 'vitest'
vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { conversations, conversationMessages, agentRuns, agentInbox } from '@mymind/core/db/schema'
import { enqueue, pumpOnce, abortActive, workerTick, checkStillRunning } from '@mymind/core/lib/agent/runtime/queue'
import { recoverOnBoot } from '@mymind/core/lib/agent/runtime/recover'
import { claimNextRun, createRun, BOOT_ID } from '@mymind/core/lib/agent/runtime/runs'
import { resolveSession } from '@mymind/core/lib/agent/runtime/sessions'
import { pushSteer, requeueUnconsumed } from '@mymind/core/lib/agent/runtime/inbox'
import { registerAbort, releaseAbort } from '@mymind/core/lib/agent/runtime/aborts'
import { eq, inArray, sql } from 'drizzle-orm'
import { useDb } from '@mymind/core/db'
import type { AgentRun } from '@mymind/core/db/schema'

// The real headless slot cap (1) is a global counter over the WHOLE shared dev DB, not scoped
// by onlyConversations — other real processes' headless runs count against it. Tests that
// need to actually CLAIM a headless run (not just create one) pass this instead, same
// convention as test/agent-runner.db.test.ts.
const HEADLESS_TEST_SLOTS = 1000

const convIds: string[] = []
afterAll(async () => {
  const db = useDb()
  await db.delete(agentInbox).where(inArray(agentInbox.conversationId, convIds))
  await db.delete(agentRuns).where(inArray(agentRuns.conversationId, convIds))
  await db.delete(conversationMessages).where(inArray(conversationMessages.conversationId, convIds))
  await db.delete(conversations).where(inArray(conversations.id, convIds))
})

describe('queue', () => {
  it('enqueue on thread:new creates the thread and a queued run', async () => {
    const r = await enqueue({ sessionKey: 'thread:new', trigger: 'user', profile: 'interactive', input: { text: 'QUEUE-TEST hi', modality: 'text' } }, { kick: false })
    convIds.push(r.conversationId)
    expect(r.created).toBe(true); expect(r.steered).toBe(false)
    expect(r.queuedBehind).toBe(false) // nothing running — it is not behind anything
    const [row] = await useDb().select().from(agentRuns).where(eq(agentRuns.id, r.runId))
    expect(row!.status).toBe('queued')
  })

  it('a message into a conversation with a RUNNING run becomes a steer, not a second run', async () => {
    const first = await enqueue({ sessionKey: 'thread:new', trigger: 'user', profile: 'interactive', input: { text: 'QUEUE-TEST first', modality: 'text' } }, { kick: false })
    convIds.push(first.conversationId)
    await claimNextRun({ onlyConversations: [first.conversationId] })
    const second = await enqueue({ sessionKey: `thread:${first.conversationId}`, trigger: 'user', profile: 'interactive', input: { text: 'actually, the other doc', modality: 'text' } }, { kick: false })
    expect(second.steered).toBe(true); expect(second.runId).toBe(first.runId)
    expect(second.queuedBehind).toBe(false) // steered, not queued
    const inbox = await useDb().select().from(agentInbox).where(eq(agentInbox.runId, first.runId))
    expect(inbox.map(i => i.content)).toEqual(['actually, the other doc'])
    const runs = await useDb().select().from(agentRuns).where(eq(agentRuns.conversationId, first.conversationId))
    expect(runs).toHaveLength(1)
  })

  it('a WAKE into a busy conversation queues behind it (never steers)', async () => {
    const first = await enqueue({ sessionKey: 'thread:new', trigger: 'user', profile: 'interactive', input: { text: 'QUEUE-TEST busy', modality: 'text' } }, { kick: false })
    convIds.push(first.conversationId)
    await claimNextRun({ onlyConversations: [first.conversationId] })
    const w = await enqueue({ sessionKey: `thread:${first.conversationId}`, trigger: 'wake', profile: 'headless', wakeReason: 'test', input: { text: 'check in', modality: 'text' } }, { kick: false })
    expect(w.steered).toBe(false); expect(w.runId).not.toBe(first.runId)
  })

  it('pumpOnce runs queued work to completion through the injected runner', async () => {
    const r = await enqueue({ sessionKey: 'thread:new', trigger: 'user', profile: 'interactive', input: { text: 'QUEUE-TEST pump', modality: 'text' } }, { kick: false })
    convIds.push(r.conversationId)
    const seen: string[] = []
    const fakeRun = async (run: AgentRun) => { seen.push(run.id); return { status: 'done' as const } }
    expect(await pumpOnce({ onlyConversations: [r.conversationId], run: fakeRun as never, rekick: false })).toBe(1)
    await new Promise(res => setTimeout(res, 50))
    expect(seen).toEqual([r.runId])
    const [row] = await useDb().select().from(agentRuns).where(eq(agentRuns.id, r.runId))
    expect(row!.status).toBe('done')
  })

  it('aborting with an unread steer turns the steer into the next queued run', async () => {
    const first = await enqueue({ sessionKey: 'thread:new', trigger: 'user', profile: 'interactive', input: { text: 'QUEUE-TEST abort', modality: 'text' } }, { kick: false })
    convIds.push(first.conversationId)
    const slow = async (run: AgentRun) => { await new Promise(r => setTimeout(r, 200)); return { status: 'aborted' as const, _run: run } }
    await pumpOnce({ onlyConversations: [first.conversationId], run: slow as never, rekick: false })
    await enqueue({ sessionKey: `thread:${first.conversationId}`, trigger: 'user', profile: 'interactive', input: { text: 'never read', modality: 'text' } }, { kick: false })
    await abortActive(first.conversationId)
    await new Promise(r => setTimeout(r, 300))
    const runs = await useDb().select().from(agentRuns).where(eq(agentRuns.conversationId, first.conversationId)).orderBy(agentRuns.createdAt)
    expect(runs.map(x => x.status)).toEqual(['aborted', 'queued'])
    expect((runs[1]!.input as { text: string }).text).toBe('never read')
  })

  it('boot recovery marks a stale running run interrupted and writes an event row', async () => {
    const r = await enqueue({ sessionKey: 'thread:new', trigger: 'user', profile: 'interactive', input: { text: 'QUEUE-TEST crash', modality: 'text' } }, { kick: false })
    convIds.push(r.conversationId)
    await claimNextRun({ onlyConversations: [r.conversationId] })
    await useDb().update(agentRuns).set({ aliveAt: sql`now() - interval '5 minutes'` }).where(eq(agentRuns.id, r.runId))
    expect(await recoverOnBoot({ onlyConversations: [r.conversationId] })).toBe(1)
    const msgs = await useDb().select().from(conversationMessages).where(eq(conversationMessages.conversationId, r.conversationId))
    expect(msgs.map(m => [m.role, m.origin])).toEqual([['event', 'runtime:restart']])
  })

  // Controller ruling (Task 2 review): orphan recovery must ALSO run on the worker's periodic
  // tick, not only at boot — a fast restart (<60s) otherwise leaves a dead 'running' row that
  // blocks its conversation forever. workerTick is the test seam: it runs the same
  // recover-then-pump sequence the 5s interval uses, scoped to onlyConversations so it can
  // never touch another session's live rows in the shared dev DB.
  it('the periodic worker tick recovers a stale running run (not only boot)', async () => {
    const r = await enqueue({ sessionKey: 'thread:new', trigger: 'user', profile: 'interactive', input: { text: 'QUEUE-TEST tick', modality: 'text' } }, { kick: false })
    convIds.push(r.conversationId)
    await claimNextRun({ onlyConversations: [r.conversationId] })
    await useDb().update(agentRuns).set({ aliveAt: sql`now() - interval '5 minutes'` }).where(eq(agentRuns.id, r.runId))
    await workerTick({ onlyConversations: [r.conversationId] })
    const [row] = await useDb().select().from(agentRuns).where(eq(agentRuns.id, r.runId))
    expect(row!.status).toBe('interrupted')
    const msgs = await useDb().select().from(conversationMessages).where(eq(conversationMessages.conversationId, r.conversationId))
    expect(msgs.map(m => [m.role, m.origin])).toEqual([['event', 'runtime:restart']])
  })

  it('overlapping worker ticks do not run recovery concurrently', async () => {
    const r = await enqueue({ sessionKey: 'thread:new', trigger: 'user', profile: 'interactive', input: { text: 'QUEUE-TEST overlap', modality: 'text' } }, { kick: false })
    convIds.push(r.conversationId)
    await claimNextRun({ onlyConversations: [r.conversationId] })
    await useDb().update(agentRuns).set({ aliveAt: sql`now() - interval '5 minutes'` }).where(eq(agentRuns.id, r.runId))
    // Two ticks fired back to back: `workerTick` resolves `true` when it actually ran and
    // `false` when the guard found one already in flight and made it a no-op. Both firing
    // truthy would mean the guard let them race.
    const results = await Promise.all([
      workerTick({ onlyConversations: [r.conversationId] }),
      workerTick({ onlyConversations: [r.conversationId] })
    ])
    expect(results.sort()).toEqual([false, true])
    const [row] = await useDb().select().from(agentRuns).where(eq(agentRuns.id, r.runId))
    expect(row!.status).toBe('interrupted')
  })

  // --- Fix round 1 (Task 8 review) -----------------------------------------------------

  it('an unread steer is requeued on EVERY terminal outcome, not only abort', async () => {
    const first = await enqueue({ sessionKey: 'thread:new', trigger: 'user', profile: 'interactive', input: { text: 'QUEUE-TEST steer-done', modality: 'text' } }, { kick: false })
    convIds.push(first.conversationId)
    // The fake runner pushes a steer while it "runs" but never drains it — simulating a steer
    // that arrives during the last step's generation, or in the gap between the runner
    // returning and finishRun committing — then resolves 'done' (not 'aborted').
    const fakeRun = async (run: AgentRun) => {
      await pushSteer(run.id, run.conversationId, 'unread words', 'user')
      return { status: 'done' as const }
    }
    await pumpOnce({ onlyConversations: [first.conversationId], run: fakeRun as never, rekick: false })
    await new Promise(res => setTimeout(res, 50))
    const runs = await useDb().select().from(agentRuns).where(eq(agentRuns.conversationId, first.conversationId)).orderBy(agentRuns.createdAt)
    expect(runs.map(x => [x.status, x.trigger, x.profile])).toEqual([['done', 'user', 'interactive'], ['queued', 'user', 'interactive']])
    expect((runs[1]!.input as { text: string }).text).toBe('unread words')
  })

  it('pushSteer only inserts while the run is actually running (closes the enqueue race atomically)', async () => {
    const first = await enqueue({ sessionKey: 'thread:new', trigger: 'user', profile: 'interactive', input: { text: 'QUEUE-TEST pushsteer-race', modality: 'text' } }, { kick: false })
    convIds.push(first.conversationId)
    // Still 'queued' — never claimed — so the conditional insert must find nothing to attach to.
    expect(await pushSteer(first.runId, first.conversationId, 'too early', 'user')).toBe(false)
    expect(await useDb().select().from(agentInbox).where(eq(agentInbox.runId, first.runId))).toHaveLength(0)
    await claimNextRun({ onlyConversations: [first.conversationId] })
    expect(await pushSteer(first.runId, first.conversationId, 'in time', 'user')).toBe(true)
    await useDb().update(agentRuns).set({ status: 'done' }).where(eq(agentRuns.id, first.runId))
    expect(await pushSteer(first.runId, first.conversationId, 'too late', 'user')).toBe(false)
  })

  it('enqueue falls back to creating a new run when pushSteer loses the race (the active run finished first)', async () => {
    const first = await enqueue({ sessionKey: 'thread:new', trigger: 'user', profile: 'interactive', input: { text: 'QUEUE-TEST enqueue-race', modality: 'text' } }, { kick: false })
    convIds.push(first.conversationId)
    await claimNextRun({ onlyConversations: [first.conversationId] })
    // Injected: simulates activeRunFor seeing 'running' but the run finishing before the
    // insert lands — pushSteer's own atomic check would return false in that interleaving.
    const racedPushSteer = async () => false
    const second = await enqueue({ sessionKey: `thread:${first.conversationId}`, trigger: 'user', profile: 'interactive', input: { text: 'raced words', modality: 'text' } }, { kick: false, pushSteer: racedPushSteer as never })
    expect(second.steered).toBe(false)
    expect(second.runId).not.toBe(first.runId)
    const [row] = await useDb().select().from(agentRuns).where(eq(agentRuns.id, second.runId))
    expect(row!.status).toBe('queued')
    expect((row!.input as { text: string }).text).toBe('raced words')
  })

  it('recovery requeues a recovered run\'s unread steer, not just the restart note', async () => {
    const r = await enqueue({ sessionKey: 'thread:new', trigger: 'user', profile: 'interactive', input: { text: 'QUEUE-TEST recovery-steer', modality: 'text' } }, { kick: false })
    convIds.push(r.conversationId)
    await claimNextRun({ onlyConversations: [r.conversationId] })
    expect(await pushSteer(r.runId, r.conversationId, 'said this while it died', 'user')).toBe(true)
    await useDb().update(agentRuns).set({ aliveAt: sql`now() - interval '5 minutes'` }).where(eq(agentRuns.id, r.runId))
    expect(await recoverOnBoot({ onlyConversations: [r.conversationId] })).toBe(1)
    const runs = await useDb().select().from(agentRuns).where(eq(agentRuns.conversationId, r.conversationId)).orderBy(agentRuns.createdAt)
    expect(runs.map(x => [x.status, x.trigger, x.profile])).toEqual([['interrupted', 'user', 'interactive'], ['queued', 'user', 'interactive']])
    expect((runs[1]!.input as { text: string }).text).toBe('said this while it died')
  })

  it('checkStillRunning aborts a run marked non-running underneath it (fenced touchRun)', async () => {
    const r = await enqueue({ sessionKey: 'thread:new', trigger: 'user', profile: 'interactive', input: { text: 'QUEUE-TEST fence-abort', modality: 'text' } }, { kick: false })
    convIds.push(r.conversationId)
    await claimNextRun({ onlyConversations: [r.conversationId] })
    const ac = registerAbort(r.runId)
    try {
      expect(ac.signal.aborted).toBe(false)
      // Simulate another process's recovery pass winning while this one still thinks it owns
      // the run (event-loop stall, or another checkout's periodic tick on the shared dev DB).
      await useDb().update(agentRuns).set({ status: 'interrupted' }).where(eq(agentRuns.id, r.runId))
      expect(await checkStillRunning(r.runId)).toBe(false)
      expect(ac.signal.aborted).toBe(true)
    } finally {
      releaseAbort(r.runId)
    }
  })

  it('the periodic tick never recovers a run this process is still executing, even if its alive_at looks stale', async () => {
    const r = await enqueue({ sessionKey: 'thread:new', trigger: 'user', profile: 'interactive', input: { text: 'QUEUE-TEST executing-guard', modality: 'text' } }, { kick: false })
    convIds.push(r.conversationId)
    let releaseRunner!: () => void
    const gate = new Promise<void>(res => { releaseRunner = res })
    const slow = async () => { await gate; return { status: 'done' as const } }
    // pumpOnce returns as soon as it CLAIMS the run — `execute` keeps going in the background
    // (fire-and-forget), and by then `run.id` is already in queue.ts's in-process `executing`
    // set (added synchronously before execute's first await).
    expect(await pumpOnce({ onlyConversations: [r.conversationId], run: slow as never, rekick: false })).toBe(1)
    await useDb().update(agentRuns).set({ aliveAt: sql`now() - interval '5 minutes'` }).where(eq(agentRuns.id, r.runId))
    await workerTick({ onlyConversations: [r.conversationId] })
    const [row] = await useDb().select().from(agentRuns).where(eq(agentRuns.id, r.runId))
    expect(row!.status).toBe('running') // excluded from recovery — this process still owns it
    releaseRunner()
    await new Promise(res => setTimeout(res, 50)) // let execute() finish and clean up
  })

  it('a user message into a conversation whose running run is HEADLESS queues behind it (never steers into a headless run)', async () => {
    const s = await resolveSession('thread:new', { titleHint: 'QUEUE-TEST headless-active' })
    convIds.push(s.conversationId)
    const headless = await createRun({ conversationId: s.conversationId, sessionKey: `thread:${s.conversationId}`, trigger: 'wake', profile: 'headless', wakeReason: 'test', input: { text: 'check in', modality: 'text' } })
    await claimNextRun({ onlyConversations: [s.conversationId], headlessSlots: HEADLESS_TEST_SLOTS })
    const userMsg = await enqueue({ sessionKey: `thread:${s.conversationId}`, trigger: 'user', profile: 'interactive', input: { text: 'hello while headless runs', modality: 'text' } }, { kick: false })
    expect(userMsg.steered).toBe(false)
    // Cycle 74: the socket tells the client it queued (ws.ts sends `queued`), so the bubble shows.
    expect(userMsg.queuedBehind).toBe(true)
    expect(userMsg.runId).not.toBe(headless.id)
    const [row] = await useDb().select().from(agentRuns).where(eq(agentRuns.id, userMsg.runId))
    expect(row!.status).toBe('queued')
    expect(await useDb().select().from(agentInbox).where(eq(agentInbox.runId, headless.id))).toHaveLength(0)
  })

  it('requeueUnconsumed always creates its follow-up as interactive/user, even for a headless run', async () => {
    const s = await resolveSession('thread:new', { titleHint: 'QUEUE-TEST headless-requeue' })
    convIds.push(s.conversationId)
    const headless = await createRun({ conversationId: s.conversationId, sessionKey: `thread:${s.conversationId}`, trigger: 'wake', profile: 'headless', wakeReason: 'test', input: { text: 'check in', modality: 'text' } })
    await claimNextRun({ onlyConversations: [s.conversationId], headlessSlots: HEADLESS_TEST_SLOTS })
    expect(await pushSteer(headless.id, s.conversationId, 'reply while headless ran', 'user')).toBe(true)
    const nextId = await requeueUnconsumed(headless)
    expect(nextId).toBeTruthy()
    const [row] = await useDb().select().from(agentRuns).where(eq(agentRuns.id, nextId!))
    expect(row!.profile).toBe('interactive')
    expect(row!.trigger).toBe('user')
    expect((row!.input as { text: string }).text).toBe('reply while headless ran')
  })

  it('workerTick({ onlyConversations: [] }) acts on nothing, not everything', async () => {
    const stale = await enqueue({ sessionKey: 'thread:new', trigger: 'user', profile: 'interactive', input: { text: 'QUEUE-TEST empty-scope-recover', modality: 'text' } }, { kick: false })
    convIds.push(stale.conversationId)
    await claimNextRun({ onlyConversations: [stale.conversationId] })
    await useDb().update(agentRuns).set({ aliveAt: sql`now() - interval '5 minutes'` }).where(eq(agentRuns.id, stale.runId))
    // A second, unrelated QUEUED run — exercises the pump/claim side of the same "[] means
    // nothing" contract (recoverOrphans and claimNextRun each guard this independently).
    const queued = await enqueue({ sessionKey: 'thread:new', trigger: 'user', profile: 'interactive', input: { text: 'QUEUE-TEST empty-scope-claim', modality: 'text' } }, { kick: false })
    convIds.push(queued.conversationId)
    await workerTick({ onlyConversations: [] })
    const [staleRow] = await useDb().select().from(agentRuns).where(eq(agentRuns.id, stale.runId))
    expect(staleRow!.status).toBe('running') // untouched by recoverOrphans — [] scopes to nothing
    const [queuedRow] = await useDb().select().from(agentRuns).where(eq(agentRuns.id, queued.runId))
    expect(queuedRow!.status).toBe('queued') // untouched by claimNextRun — [] scopes to nothing
  })

  // Final review I3: a steer is text-only, so a message carrying attachments or a skill must
  // queue as its own run with its input intact instead of being spliced (and stripped).
  it.each([
    ['attachments', { attachments: [{ id: '00000000-0000-4000-8000-000000000001', kind: 'image' as const, mime: 'image/png' }] }],
    ['a skill', { skill: 'db-maintenance' }]
  ])('a message with %s into a busy interactive run queues a normal run, never steers', async (_label, extra) => {
    const first = await enqueue({ sessionKey: 'thread:new', trigger: 'user', profile: 'interactive', input: { text: 'QUEUE-TEST steer-rich', modality: 'text' } }, { kick: false })
    convIds.push(first.conversationId)
    await claimNextRun({ onlyConversations: [first.conversationId] })
    const second = await enqueue({ sessionKey: `thread:${first.conversationId}`, trigger: 'user', profile: 'interactive', input: { text: 'look at this', modality: 'text', ...extra } }, { kick: false })
    expect(second.steered).toBe(false)
    expect(second.runId).not.toBe(first.runId)
    expect(await useDb().select().from(agentInbox).where(eq(agentInbox.runId, first.runId))).toHaveLength(0)
    const [row] = await useDb().select().from(agentRuns).where(eq(agentRuns.id, second.runId))
    expect(row!.status).toBe('queued')
    expect(row!.input).toMatchObject(extra)
  })

  it('pushSteer waits on a concurrent finishRun and then refuses (for share closes the millisecond race)', async () => {
    const first = await enqueue({ sessionKey: 'thread:new', trigger: 'user', profile: 'interactive', input: { text: 'QUEUE-TEST steer-lock', modality: 'text' } }, { kick: false })
    convIds.push(first.conversationId)
    await claimNextRun({ onlyConversations: [first.conversationId] })
    // An uncommitted "finishRun" holds the row; pushSteer must block on it and re-check the
    // committed status — not read the pre-update snapshot and insert into a finished run.
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const finishing = useDb().transaction(async (tx) => {
      await tx.update(agentRuns).set({ status: 'done' }).where(eq(agentRuns.id, first.runId))
      await gate
    })
    await new Promise(r => setTimeout(r, 100))
    const steer = pushSteer(first.runId, first.conversationId, 'raced the finish', 'user')
    await new Promise(r => setTimeout(r, 200))
    release()
    await finishing
    expect(await steer).toBe(false)
    expect(await useDb().select().from(agentInbox).where(eq(agentInbox.runId, first.runId))).toHaveLength(0)
  })

  // Final review I4: a run the previous process was executing seconds before a deploy restart
  // looks alive (fresh alive_at). In an exclusive deployment boot recovery takes it over by
  // owner; on the shared dev DB (no flag) it stays age-only.
  describe('boot recovery by owner', () => {
    async function freshForeignRun(label: string) {
      const r = await enqueue({ sessionKey: 'thread:new', trigger: 'user', profile: 'interactive', input: { text: `QUEUE-TEST ${label}`, modality: 'text' } }, { kick: false })
      convIds.push(r.conversationId)
      const claimed = await claimNextRun({ onlyConversations: [r.conversationId] })
      expect(claimed!.owner).toBe(BOOT_ID)
      await useDb().update(agentRuns).set({ owner: 'a-previous-boot', aliveAt: sql`now()` }).where(eq(agentRuns.id, r.runId))
      return r
    }

    it('with AGENT_RUNTIME_EXCLUSIVE=1 a fresh run owned by another boot is recovered; our own is not', async () => {
      const foreign = await freshForeignRun('owner-foreign')
      const ours = await enqueue({ sessionKey: 'thread:new', trigger: 'user', profile: 'interactive', input: { text: 'QUEUE-TEST owner-ours', modality: 'text' } }, { kick: false })
      convIds.push(ours.conversationId)
      await claimNextRun({ onlyConversations: [ours.conversationId] })
      vi.stubEnv('AGENT_RUNTIME_EXCLUSIVE', '1')
      try {
        expect(await recoverOnBoot({ onlyConversations: [foreign.conversationId, ours.conversationId] })).toBe(1)
      } finally { vi.unstubAllEnvs() }
      const [f] = await useDb().select().from(agentRuns).where(eq(agentRuns.id, foreign.runId))
      expect(f!.status).toBe('interrupted')
      const [o] = await useDb().select().from(agentRuns).where(eq(agentRuns.id, ours.runId))
      expect(o!.status).toBe('running')
    })

    it('without the flag a fresh run owned by another boot is left alone (age-only)', async () => {
      const foreign = await freshForeignRun('owner-shared')
      vi.stubEnv('AGENT_RUNTIME_EXCLUSIVE', '')
      try {
        expect(await recoverOnBoot({ onlyConversations: [foreign.conversationId] })).toBe(0)
      } finally { vi.unstubAllEnvs() }
      const [f] = await useDb().select().from(agentRuns).where(eq(agentRuns.id, foreign.runId))
      expect(f!.status).toBe('running')
    })
  })
})
