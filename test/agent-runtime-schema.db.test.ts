process.loadEnvFile('.env')
import { describe, it, expect, afterAll, vi } from 'vitest'
vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { useDb } from '../server/db'
import { conversations, agentRuns } from '../server/db/schema'
import { eq, inArray } from 'drizzle-orm'

const violates = (name: string) => (e: unknown) => {
  const err = e as { message?: string; cause?: { message?: string } }
  return new RegExp(name).test(`${err?.message ?? ''} ${err?.cause?.message ?? ''}`)
}

const convIds: string[] = []
afterAll(async () => {
  const db = useDb()
  if (convIds.length) {
    await db.delete(agentRuns).where(inArray(agentRuns.conversationId, convIds))
    await db.delete(conversations).where(inArray(conversations.id, convIds))
  }
})

describe('agent runtime schema', () => {
  it('allows at most one main conversation', async () => {
    const db = useDb()
    const [existing] = await db.select().from(conversations).where(eq(conversations.kind, 'main')).limit(1)
    if (!existing) {
      const [m] = await db.insert(conversations).values({ title: 'RUNTIME-SCHEMA main', kind: 'main' }).returning()
      convIds.push(m!.id)
    }
    await expect(db.insert(conversations).values({ title: 'RUNTIME-SCHEMA second main', kind: 'main' }))
      .rejects.toSatisfy(violates('conversations_one_main'))
  })

  it('defaults kind to thread', async () => {
    const [c] = await useDb().insert(conversations).values({ title: 'RUNTIME-SCHEMA thread' }).returning()
    convIds.push(c!.id)
    expect(c!.kind).toBe('thread')
    expect(c!.summarizedThrough).toBeNull()
  })

  it('allows at most one running run per conversation', async () => {
    const db = useDb()
    const [c] = await db.insert(conversations).values({ title: 'RUNTIME-SCHEMA runs' }).returning()
    convIds.push(c!.id)
    const base = { conversationId: c!.id, sessionKey: `thread:${c!.id}`, trigger: 'user', profile: 'interactive', input: { text: 'x', modality: 'text' } }
    await db.insert(agentRuns).values({ ...base, status: 'running' })
    await db.insert(agentRuns).values({ ...base, status: 'queued' }) // queued alongside is fine
    await expect(db.insert(agentRuns).values({ ...base, status: 'running' }))
      .rejects.toSatisfy(violates('agent_runs_one_running'))
  })
})
