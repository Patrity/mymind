// Cycle 81 Task 2 — the queue's drain seam the worker's SIGTERM path uses (apps/worker/src/worker.ts):
// stopClaiming() → no further claims (pumpOnce/kick), waitForInFlight() resolves only after the runs
// already executing have fully unwound. Fake runs; scoped to conversations this file creates (the dev
// DB is shared); claiming is resumed after each test so other files in this process are unaffected.
process.loadEnvFile('.env')
import { describe, it, expect, afterAll, afterEach, vi } from 'vitest'
vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { eq, inArray } from 'drizzle-orm'
import { useDb } from '@mymind/core/db'
import { agentInbox, agentRuns, conversationMessages, conversations, type AgentRun } from '@mymind/core/db/schema'
import { _resumeClaimingForTests, abortRunAndWait, claimingIsStopped, enqueue, inFlightRunIds, pumpOnce, stopClaiming, waitForInFlight } from '@mymind/core/lib/agent/runtime/queue'
import type { RunOutcome } from '@mymind/core/lib/agent/runtime/types'

const convIds: string[] = []
afterEach(() => { _resumeClaimingForTests() })
afterAll(async () => {
  const db = useDb()
  await db.delete(agentInbox).where(inArray(agentInbox.conversationId, convIds))
  await db.delete(agentRuns).where(inArray(agentRuns.conversationId, convIds))
  await db.delete(conversationMessages).where(inArray(conversationMessages.conversationId, convIds))
  await db.delete(conversations).where(inArray(conversations.id, convIds))
})

async function queued(text: string) {
  const r = await enqueue({ sessionKey: 'thread:new', trigger: 'user', profile: 'interactive', input: { text: `DRAIN-TEST ${text}`, modality: 'text' } }, { kick: false })
  convIds.push(r.conversationId)
  return r
}
const statusOf = async (runId: string) => (await useDb().select().from(agentRuns).where(eq(agentRuns.id, runId)))[0]!.status

describe('worker drain seam', () => {
  it('stopClaiming stops new claims; waitForInFlight resolves only once the in-flight run settles', async () => {
    const a = await queued('in-flight')
    const b = await queued('must-stay-queued')
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const fake = async (_run: AgentRun): Promise<RunOutcome> => { await gate; return { status: 'done' } }

    expect(await pumpOnce({ onlyConversations: [a.conversationId], run: fake, rekick: false })).toBe(1)
    expect(inFlightRunIds()).toContain(a.runId)

    stopClaiming()
    expect(claimingIsStopped()).toBe(true)
    // A pump after the drain started claims nothing — b stays queued for the next worker.
    expect(await pumpOnce({ onlyConversations: [b.conversationId], run: fake, rekick: false })).toBe(0)
    expect(await statusOf(b.runId)).toBe('queued')

    // Still running: the wait times out (false) rather than resolving early.
    const t0 = Date.now()
    expect(await waitForInFlight(150)).toBe(false)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140)

    const settled = waitForInFlight(5_000)
    let resolved = false
    void settled.then(() => { resolved = true })
    await new Promise(r => setTimeout(r, 100))
    expect(resolved).toBe(false) // never before the run settles
    release()
    expect(await settled).toBe(true)
    expect(inFlightRunIds()).not.toContain(a.runId)
    expect(await statusOf(a.runId)).toBe('done') // fully unwound: finishRun committed before resolve
    expect(await statusOf(b.runId)).toBe('queued')
  })

  it('waitForInFlight with nothing in flight resolves true at once', async () => {
    stopClaiming()
    expect(await waitForInFlight(10)).toBe(true)
  })

  it('abortRunAndWait aborts this process\'s run and reports settled once it unwound', async () => {
    const a = await queued('abort-me')
    let started!: () => void
    const isRunning = new Promise<void>((r) => { started = r })
    const fake = async (run: AgentRun): Promise<RunOutcome> => {
      const { registerAbort, releaseAbort } = await import('@mymind/core/lib/agent/runtime/aborts')
      const ac = registerAbort(run.id)
      started()
      await new Promise<void>(r => ac.signal.addEventListener('abort', () => r(), { once: true }))
      releaseAbort(run.id)
      return { status: 'aborted' }
    }
    await pumpOnce({ onlyConversations: [a.conversationId], run: fake, rekick: false })
    await isRunning
    expect(await abortRunAndWait(a.runId, 5_000)).toEqual({ settled: true })
    expect(await statusOf(a.runId)).toBe('aborted')
  })
})
