// test/agent-sessions.db.test.ts
//
// DB-backed test — see test/agent-runs.db.test.ts for the harness pattern this file follows
// (`.env` load + `useRuntimeConfig` stub so `useDb()` works outside Nuxt).
process.loadEnvFile('.env')
import { describe, it, expect, afterAll, vi } from 'vitest'
vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { useDb } from '../server/db'
import { conversations, conversationMessages } from '../server/db/schema'
import { resolveSession, getOrCreateMain } from '../server/lib/agent/runtime/sessions'
import { appendMessages, getAgentHistory, getConversation } from '../server/services/conversations'
import { eq, inArray, sql } from 'drizzle-orm'

const convIds: string[] = []
afterAll(async () => {
  const db = useDb()
  await db.delete(conversationMessages).where(inArray(conversationMessages.conversationId, convIds))
  await db.delete(conversations).where(inArray(conversations.id, convIds))
})

describe('sessions', () => {
  it('thread:new creates a titled thread', async () => {
    const r = await resolveSession('thread:new', { titleHint: 'SESS-TEST plan the week' })
    convIds.push(r.conversationId)
    expect(r.created).toBe(true)
    const [c] = await useDb().select().from(conversations).where(eq(conversations.id, r.conversationId))
    expect(c!.title).toBe('SESS-TEST plan the week')
    expect(c!.kind).toBe('thread')
  })

  it('thread:<id> resolves an existing thread and rejects an unknown one', async () => {
    const r = await resolveSession('thread:new', { titleHint: 'SESS-TEST existing' })
    convIds.push(r.conversationId)
    expect(await resolveSession(`thread:${r.conversationId}`)).toEqual({ conversationId: r.conversationId, created: false })
    await expect(resolveSession('thread:00000000-0000-0000-0000-000000000000')).rejects.toThrow(/not found/)
  })

  it('thread:<id> rejects a non-UUID id the same clean way, without hitting the DB driver', async () => {
    await expect(resolveSession('thread:not-a-uuid')).rejects.toThrow(/not found/)
  })

  it('main is created once and then reused (touches the real main row — read-only if it exists)', async () => {
    const a = await getOrCreateMain()
    const b = await getOrCreateMain()
    expect(a).toBe(b)
    const [c] = await useDb().select().from(conversations).where(eq(conversations.id, a))
    expect(c!.kind).toBe('main')
  })

  it('isolated:<slug> always creates a fresh thread', async () => {
    const a = await resolveSession('isolated:SESS-TEST'); convIds.push(a.conversationId)
    const b = await resolveSession('isolated:SESS-TEST'); convIds.push(b.conversationId)
    expect(a.conversationId).not.toBe(b.conversationId)
  })
})

describe('sinceSummary', () => {
  it('the model reads only messages after summarized_through; the UI reads everything', async () => {
    const r = await resolveSession('thread:new', { titleHint: 'SESS-TEST summary' })
    convIds.push(r.conversationId)
    await appendMessages(r.conversationId, [
      { role: 'user', content: 'old question', modality: 'text' },
      { role: 'assistant', content: 'old answer', modality: 'text' }
    ])
    await useDb().update(conversations).set({ summarizedThrough: sql`now()`, summary: 'they discussed the old question' })
      .where(eq(conversations.id, r.conversationId))
    await new Promise(res => setTimeout(res, 20))
    await appendMessages(r.conversationId, [{ role: 'user', content: 'new question', modality: 'text' }])
    const model = await getAgentHistory(r.conversationId)
    expect(model.map(m => m.content)).toEqual(['new question'])
    const ui = await getConversation(r.conversationId)
    expect(ui!.messages.map(m => m.content)).toEqual(['old question', 'old answer', 'new question'])
  })
})
