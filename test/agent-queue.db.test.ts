// test/agent-queue.db.test.ts
//
// DB-backed test — harness copied from test/agent-runs.db.test.ts (`.env` load +
// `useRuntimeConfig` stub BEFORE importing server/db). The dev DB is shared: only rows in
// conversations this file created are deleted.
process.loadEnvFile('.env')
import { describe, it, expect, afterAll, vi } from 'vitest'
vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { conversations, conversationMessages, agentRuns, agentInbox } from '../server/db/schema'
import { enqueue, pumpOnce, abortActive, workerTick } from '../server/lib/agent/runtime/queue'
import { recoverOnBoot } from '../server/lib/agent/runtime/recover'
import { claimNextRun } from '../server/lib/agent/runtime/runs'
import { eq, inArray, sql } from 'drizzle-orm'
import { useDb } from '../server/db'
import type { AgentRun } from '../server/db/schema'

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
    const [row] = await useDb().select().from(agentRuns).where(eq(agentRuns.id, r.runId))
    expect(row!.status).toBe('queued')
  })

  it('a message into a conversation with a RUNNING run becomes a steer, not a second run', async () => {
    const first = await enqueue({ sessionKey: 'thread:new', trigger: 'user', profile: 'interactive', input: { text: 'QUEUE-TEST first', modality: 'text' } }, { kick: false })
    convIds.push(first.conversationId)
    await claimNextRun({ onlyConversations: [first.conversationId] })
    const second = await enqueue({ sessionKey: `thread:${first.conversationId}`, trigger: 'user', profile: 'interactive', input: { text: 'actually, the other doc', modality: 'text' } }, { kick: false })
    expect(second.steered).toBe(true); expect(second.runId).toBe(first.runId)
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
})
