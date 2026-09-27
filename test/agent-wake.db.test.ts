// test/agent-wake.db.test.ts
//
// DB-backed test — harness copied from test/agent-runs.db.test.ts (`.env` load +
// `useRuntimeConfig` stub BEFORE importing server/db). The dev DB is shared: only rows in
// conversations this file created are deleted.
process.loadEnvFile('.env')
import { describe, it, expect, afterAll, vi } from 'vitest'
vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { useDb } from '../server/db'
import { conversations, conversationMessages, agentRuns } from '../server/db/schema'
import { wake } from '../server/lib/agent/runtime/wake'
import { eq, inArray } from 'drizzle-orm'

const convIds: string[] = []
afterAll(async () => {
  const db = useDb()
  await db.delete(agentRuns).where(inArray(agentRuns.conversationId, convIds))
  await db.delete(conversationMessages).where(inArray(conversationMessages.conversationId, convIds))
  await db.delete(conversations).where(inArray(conversations.id, convIds))
})

describe('wake', () => {
  it('queues a headless wake run on an isolated session', async () => {
    const r = await wake({ reason: 'test', prompt: 'WAKE-TEST anything new?', sessionKey: 'isolated:WAKE-TEST' }, { kick: false })
    convIds.push(r.conversationId)
    const [run] = await useDb().select().from(agentRuns).where(eq(agentRuns.id, r.runId))
    expect(run).toMatchObject({ trigger: 'wake', profile: 'headless', wakeReason: 'test', status: 'queued' })
    expect((run!.input as { text: string }).text).toBe('WAKE-TEST anything new?')
  })
  it('rejects an empty prompt or reason', async () => {
    await expect(wake({ reason: '', prompt: 'x' }, { kick: false })).rejects.toThrow(/reason/)
    await expect(wake({ reason: 'x', prompt: '  ' }, { kick: false })).rejects.toThrow(/prompt/)
  })
})
