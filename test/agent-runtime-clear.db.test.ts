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
import { enqueue, pumpOnce, abortActiveAndWait } from '@mymind/core/lib/agent/runtime/queue'
import { activeRunFor } from '@mymind/core/lib/agent/runtime/runs'
import { registerAbort, releaseAbort } from '@mymind/core/lib/agent/runtime/aborts'
import { clearConversationContext } from '../server/services/conversation-clear'
import { eq, inArray } from 'drizzle-orm'
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
