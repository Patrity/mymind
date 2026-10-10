// test/agent-replay.db.test.ts
//
// DB-backed test — see test/memory-applicability.db.test.ts for the harness pattern this file
// follows (`.env` load + `useRuntimeConfig` stub so `useDb()` works outside Nuxt).
process.loadEnvFile('.env')
import { describe, it, expect, afterAll } from 'vitest'
import { vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { z } from 'zod'
import { useDb } from '@mymind/core/db'
import { conversations, conversationMessages, reviewQueue } from '@mymind/core/db/schema'
import { approveAgentAction, rejectAgentAction, replayAgentAction } from '@mymind/core/lib/agent/runtime/replay'
import { createConversation } from '@mymind/core/services/conversations'
import { hasUndo } from '@mymind/core/lib/agent/undo'
import { eq, inArray } from 'drizzle-orm'
import type { AgentTool } from '@mymind/core/lib/agent/types'

const convIds: string[] = []
const reviewIds: string[] = []
afterAll(async () => {
  const db = useDb()
  if (reviewIds.length) await db.delete(reviewQueue).where(inArray(reviewQueue.id, reviewIds))
  await db.delete(conversationMessages).where(inArray(conversationMessages.conversationId, convIds))
  await db.delete(conversations).where(inArray(conversations.id, convIds))
})

let calls = 0
const tools: AgentTool[] = [{
  name: 'edit_task',
  description: '',
  kind: 'destructive',
  schema: { id: z.string(), status: z.string() },
  handler: async (a) => { calls++; return { result: { ok: true }, summary: `moved ${a.id} to ${a.status}` } }
}]

async function item(args: Record<string, unknown>) {
  const c = await createConversation({ title: 'REPLAY-TEST' }); convIds.push(c.id)
  const [row] = await useDb().insert(reviewQueue).values({
    targetKind: 'agent_run', targetId: c.id, kind: 'agent-action',
    proposed: { tool: 'edit_task', args, conversationId: c.id }
  }).returning()
  reviewIds.push(row!.id)
  return { row: row!, conversationId: c.id }
}

describe('agent-action review', () => {
  it('approve runs the stored call exactly once, marks approved, and notes it in the thread', async () => {
    calls = 0
    const { row, conversationId } = await item({ id: 't1', status: 'done' })
    await approveAgentAction(row, { tools })
    expect(calls).toBe(1)
    const [after] = await useDb().select().from(reviewQueue).where(eq(reviewQueue.id, row.id))
    expect(after!.status).toBe('approved')
    const msgs = await useDb().select().from(conversationMessages).where(eq(conversationMessages.conversationId, conversationId))
    expect(msgs.map(m => [m.role, m.origin, m.content])).toEqual([['event', 'review:approved', 'Approved: edit_task — moved t1 to done']])
  })

  it('reject runs nothing', async () => {
    calls = 0
    const { row } = await item({ id: 't2', status: 'done' })
    await rejectAgentAction(row)
    expect(calls).toBe(0)
    const [after] = await useDb().select().from(reviewQueue).where(eq(reviewQueue.id, row.id))
    expect(after!.status).toBe('rejected')
  })

  it('args that no longer fit the tool schema fail visibly and never run', async () => {
    calls = 0
    const { row, conversationId } = await item({ id: 't3' }) // status missing → schema drift
    await approveAgentAction(row, { tools })
    expect(calls).toBe(0)
    const [after] = await useDb().select().from(reviewQueue).where(eq(reviewQueue.id, row.id))
    expect(after!.status).toBe('failed')
    const msgs = await useDb().select().from(conversationMessages).where(eq(conversationMessages.conversationId, conversationId))
    expect(msgs[0]!.content).toMatch(/^Could not apply edit_task:/)
  })

  it('refuses to replay a dangerous tool even if one was somehow stored', async () => {
    const r = await replayAgentAction({ tool: 'exec', args: { command: 'ls' } }, {
      tools: [{ name: 'exec', description: '', kind: 'destructive', dangerous: true, schema: {}, handler: async () => ({ result: 1, summary: '' }) }]
    })
    expect(r).toEqual({ ok: false, error: 'exec is not replayable' })
  })

  it('two concurrent approvals on the same row run the tool exactly once', async () => {
    calls = 0
    const { row } = await item({ id: 't4', status: 'done' })
    // A double-click, two open /review tabs, or a retried request — whatever races it, the
    // stored call (not idempotent for tools like create_skill/edit_image) must run at most once.
    const [a, b] = await Promise.all([
      approveAgentAction(row, { tools }),
      approveAgentAction(row, { tools })
    ])
    expect(calls).toBe(1)
    // Exactly one of the two callers actually won the claim and got the real result back; the
    // other lost the race and got the empty no-op result.
    expect([a, b].filter(r => r.summary !== undefined)).toHaveLength(1)
    const [after] = await useDb().select().from(reviewQueue).where(eq(reviewQueue.id, row.id))
    expect(after!.status).toBe('approved')
  })

  it('registers an undo token when the replayed tool returns one', async () => {
    const undoTools: AgentTool[] = [{
      name: 'edit_task',
      description: '',
      kind: 'destructive',
      schema: { id: z.string(), status: z.string() },
      handler: async (a) => ({ result: { ok: true }, summary: `moved ${a.id}`, undo: async () => {} })
    }]
    const { row } = await item({ id: 't5', status: 'done' })
    const res = await approveAgentAction(row, { tools: undoTools })
    expect(res.undoToken).toBeTruthy()
    expect(hasUndo(res.undoToken!)).toBe(true)
  })
})
