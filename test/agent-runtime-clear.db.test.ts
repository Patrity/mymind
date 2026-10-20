// test/agent-runtime-clear.db.test.ts
//
// `/clear` on a thread with a running turn must wait for that turn to unwind before writing
// the epoch: the runner's `finally` rescue appends the user's question + partial reply, and
// if those land AFTER context_epoch_at they stay in model history (legacy got this ordering
// from s.lock). Harness per test/agent-queue.db.test.ts; only this file's rows are deleted.
process.loadEnvFile('.env')
import { describe, it, expect, afterAll, vi } from 'vitest'
vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { conversations, conversationMessages, agentRuns, agentInbox, type AgentRun } from '@mymind/core/db/schema'
import { enqueue, pumpOnce, abortActiveAndWait, abortForCommand, _executeClaimedForTests } from '@mymind/core/lib/agent/runtime/queue'
import { activeRunFor, BOOT_ID } from '@mymind/core/lib/agent/runtime/runs'
import { registerAbort, releaseAbort } from '@mymind/core/lib/agent/runtime/aborts'
import { resolveSession } from '@mymind/core/lib/agent/runtime/sessions'
import { clearConversationContext } from '../server/services/conversation-clear'
import { eq, inArray, sql } from 'drizzle-orm'
import { useDb } from '@mymind/core/db'
import type { RunOutcome } from '@mymind/core/lib/agent/runtime/types'

const convIds: string[] = []
afterAll(async () => {
  const db = useDb()
  await db.delete(agentInbox).where(inArray(agentInbox.conversationId, convIds))
  await db.delete(agentRuns).where(inArray(agentRuns.conversationId, convIds))
  await db.delete(conversationMessages).where(inArray(conversationMessages.conversationId, convIds))
  await db.delete(conversations).where(inArray(conversations.id, convIds))
})

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// Stands in for runTurn: waits for Stop, then — like the real runner's `finally` rescue —
// appends the question + partial reply a beat later, after the abort has already been sent.
function rescuingRun(conversationId: string) {
  return async (run: AgentRun): Promise<RunOutcome> => {
    const ac = registerAbort(run.id)
    try {
      await new Promise<void>((resolve) => {
        ac.signal.addEventListener('abort', () => resolve(), { once: true })
        setTimeout(resolve, 5_000) // never hang the suite
      })
      await sleep(400)
      await useDb().insert(conversationMessages).values([
        { conversationId, role: 'user', content: 'CLEAR-TEST rescued question', modality: 'text' },
        { conversationId, role: 'assistant', content: 'CLEAR-TEST partial reply', modality: 'text' }
      ])
      return { status: 'aborted' }
    } finally {
      releaseAbort(run.id)
    }
  }
}

describe('abortActiveAndWait', () => {
  it('clear after abortActiveAndWait puts every rescued row BEFORE the epoch', async () => {
    const r = await enqueue({ sessionKey: 'thread:new', trigger: 'user', profile: 'interactive', input: { text: 'CLEAR-TEST go', modality: 'text' } }, { kick: false })
    convIds.push(r.conversationId)
    await pumpOnce({ onlyConversations: [r.conversationId], run: rescuingRun(r.conversationId), rekick: false })
    expect((await activeRunFor(r.conversationId))?.id).toBe(r.runId)

    expect(await abortActiveAndWait(r.conversationId)).toBe(true)
    await clearConversationContext(r.conversationId)
    // Let a run that was NOT waited for finish its rescue too, so a broken wait fails on the
    // ordering assertion below rather than on a missing row.
    for (let i = 0; i < 30 && (await activeRunFor(r.conversationId)); i++) await sleep(100)
    await sleep(100)

    const [conv] = await useDb().select().from(conversations).where(eq(conversations.id, r.conversationId))
    const rows = await useDb().select().from(conversationMessages).where(eq(conversationMessages.conversationId, r.conversationId))
    expect(rows).toHaveLength(2)
    for (const m of rows) expect(m.createdAt.getTime()).toBeLessThan(conv!.contextEpochAt!.getTime())
    const [run] = await useDb().select().from(agentRuns).where(eq(agentRuns.id, r.runId))
    expect(run!.status).toBe('aborted')
  })

  it('returns false (and does not wait) when nothing is running', async () => {
    const r = await enqueue({ sessionKey: 'thread:new', trigger: 'user', profile: 'interactive', input: { text: 'CLEAR-TEST idle', modality: 'text' } }, { kick: false })
    convIds.push(r.conversationId)
    expect(await abortActiveAndWait(r.conversationId)).toBe(false)
  })
})

// Cycle 81 Task 4: the worker's `abort` command answers `settled` HONESTLY — `/clear` writes its
// epoch only on true. Runs are inserted already 'running' (never 'queued': no dev worker can claim
// them) and executed through the queue's own path (_executeClaimedForTests).
async function runningRun(owner = BOOT_ID) {
  const s = await resolveSession('thread:new', { titleHint: 'CLEAR-TEST' })
  convIds.push(s.conversationId)
  const [run] = await useDb().insert(agentRuns).values({
    conversationId: s.conversationId, sessionKey: `thread:${s.conversationId}`, trigger: 'user', profile: 'interactive',
    input: { text: 'CLEAR-TEST go', modality: 'text' }, status: 'running', owner, claimedAt: sql`now()`, aliveAt: sql`now()`
  }).returning()
  return run!
}
/** Waits for Stop, then takes `unwindMs` to unwind. */
function slowUnwind(unwindMs: number) {
  return async (run: AgentRun): Promise<RunOutcome> => {
    const ac = registerAbort(run.id)
    try {
      await new Promise<void>((resolve) => { ac.signal.addEventListener('abort', () => resolve(), { once: true }); setTimeout(resolve, 5_000) })
      await sleep(unwindMs)
      return { status: 'aborted' }
    } finally { releaseAbort(run.id) }
  }
}

describe('abortForCommand (the worker\'s abort command)', () => {
  it('settled:true once the conversation\'s run has unwound and finished', async () => {
    const run = await runningRun()
    const exec = _executeClaimedForTests(run, slowUnwind(200))
    expect(await abortForCommand({ conversationId: run.conversationId })).toEqual({ settled: true })
    const [row] = await useDb().select().from(agentRuns).where(eq(agentRuns.id, run.id))
    expect(row!.status).toBe('aborted')
    await exec
  })

  it('settled:false — never a false "settled" — when the run has not unwound within the wait', async () => {
    const run = await runningRun()
    const exec = _executeClaimedForTests(run, slowUnwind(1_000))
    const t0 = Date.now()
    expect(await abortForCommand({ conversationId: run.conversationId }, 200)).toEqual({ settled: false })
    expect(Date.now() - t0).toBeLessThan(900)
    await exec
  })

  it('settled:false for a running row this process is not executing (another boot\'s orphan)', async () => {
    const run = await runningRun(crypto.randomUUID())
    try {
      expect(await abortForCommand({ conversationId: run.conversationId }, 200)).toEqual({ settled: false })
    } finally {
      releaseAbort(run.id)
      await useDb().update(agentRuns).set({ status: 'interrupted' }).where(eq(agentRuns.id, run.id))
    }
  })

  it('M4: an expired Stop (claimed after a worker outage) aborts nothing', async () => {
    const run = await runningRun()
    let aborted = false
    const exec = _executeClaimedForTests(run, async (r) => {
      const ac = registerAbort(r.id)
      try {
        await new Promise<void>((resolve) => { ac.signal.addEventListener('abort', () => { aborted = true; resolve() }, { once: true }); setTimeout(resolve, 600) })
        return { status: 'done', suppressed: false, usage: null }
      } finally { releaseAbort(r.id) }
    })
    expect(await abortForCommand({ conversationId: run.conversationId, runId: run.id, expiresAt: Date.now() - 1 })).toEqual({ settled: true, expired: true })
    await exec
    expect(aborted).toBe(false)
    const [row] = await useDb().select().from(agentRuns).where(eq(agentRuns.id, run.id))
    expect(row!.status).toBe('done')
  })

  it('a runId that already finished is left alone (settled, and not parked as pre-aborted)', async () => {
    const run = await runningRun()
    await useDb().update(agentRuns).set({ status: 'done' }).where(eq(agentRuns.id, run.id))
    expect(await abortForCommand({ runId: run.id })).toEqual({ settled: true })
    // Not parked: a controller registered for that id now is NOT born aborted.
    const ac = registerAbort(run.id)
    expect(ac.signal.aborted).toBe(false)
    releaseAbort(run.id)
  })
})
