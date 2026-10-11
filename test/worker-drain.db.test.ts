// Cycle 81 Task 2 — the queue's drain seam the worker's SIGTERM path uses (apps/worker/src/worker.ts):
// stopClaiming() → no further claims (pumpOnce/kick), waitForInFlight() resolves only after the runs
// already executing have fully unwound. Fake runs; scoped to conversations this file creates (the dev
// DB is shared); claiming is resumed after each test so other files in this process are unaffected.
// Also: the web's remote execution mode (always, since Task 3) turns a kick into a worker command.
process.loadEnvFile('.env')
import { describe, it, expect, afterAll, afterEach, vi } from 'vitest'
vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { eq, inArray } from 'drizzle-orm'
import { useDb } from '@mymind/core/db'
import { agentInbox, agentRuns, conversationMessages, conversations, workerCommands, type AgentRun } from '@mymind/core/db/schema'
import { _resumeClaimingForTests, abortRunAndWait, claimingIsStopped, enqueue, inFlightRunIds, pumpOnce, setExecutionMode, stopClaiming, waitForInFlight } from '@mymind/core/lib/agent/runtime/queue'
import { setBusNs } from '@mymind/core/lib/bus/ns'
import { closeListener } from '@mymind/core/lib/bus/listen'
import type { RunOutcome } from '@mymind/core/lib/agent/runtime/types'

const convIds: string[] = []
const NS = `t2-drain-${process.pid}`
afterEach(() => { _resumeClaimingForTests(); setExecutionMode('local'); setBusNs(null) })
afterAll(async () => {
  const db = useDb()
  await db.delete(agentInbox).where(inArray(agentInbox.conversationId, convIds))
  await db.delete(agentRuns).where(inArray(agentRuns.conversationId, convIds))
  await db.delete(conversationMessages).where(inArray(conversationMessages.conversationId, convIds))
  await db.delete(conversations).where(inArray(conversations.id, convIds))
  await db.delete(workerCommands).where(eq(workerCommands.ns, NS))
  await closeListener()
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

  it('a pump that is mid-claim when the drain starts is awaited: its run finishes, never left running', async () => {
    const a = await queued('mid-claim')
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const fake = async (_run: AgentRun): Promise<RunOutcome> => { await gate; return { status: 'done' } }
    // Not awaited: the pump has passed its stop check and is inside claimNextRun right now.
    const pump = pumpOnce({ onlyConversations: [a.conversationId], run: fake, rekick: false })
    stopClaiming()
    expect(inFlightRunIds()).toEqual([]) // nothing registered yet — the claim hasn't returned
    const settled = waitForInFlight(5_000)
    let resolved = false
    void settled.then(() => { resolved = true })
    await new Promise(r => setTimeout(r, 300))
    expect(resolved).toBe(false) // waits for the claimed run, not just for `settles` being empty
    expect(inFlightRunIds()).toContain(a.runId)
    release()
    expect(await settled).toBe(true)
    expect(await pump).toBe(1)
    expect(await statusOf(a.runId)).toBe('done')
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

  it('remote execution mode (the web): enqueue\'s kick is a `kick` command, nothing is claimed here', async () => {
    setBusNs(NS)
    setExecutionMode('remote')
    const r = await enqueue({ sessionKey: 'thread:new', trigger: 'user', profile: 'interactive', input: { text: 'DRAIN-TEST remote', modality: 'text' } })
    convIds.push(r.conversationId)
    const deadline = Date.now() + 5_000
    let cmds: Array<typeof workerCommands.$inferSelect> = []
    while (Date.now() < deadline) {
      cmds = await useDb().select().from(workerCommands).where(eq(workerCommands.ns, NS))
      if (cmds.length) break
      await new Promise(res => setTimeout(res, 50))
    }
    expect(cmds.map(c => c.type)).toEqual(['kick'])
    await new Promise(res => setTimeout(res, 200))
    expect(await statusOf(r.runId)).toBe('queued') // the web never pumped it
  })
})
