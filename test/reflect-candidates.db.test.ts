// test/reflect-candidates.db.test.ts
//
// DB-backed — harness as in test/agent-summarize.db.test.ts. The dev DB is shared with real
// data: every query goes through the `onlyConversationIds` seam and every row is a scratch
// conversation this file creates and deletes. No real conversation's watermark is touched.
process.loadEnvFile('.env')
import { describe, it, expect, afterAll } from 'vitest'
import { vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { eq, inArray } from 'drizzle-orm'
import { useDb } from '../server/db'
import { conversations, conversationMessages } from '../server/db/schema'
import { createConversation } from '../server/services/conversations'
import { threadCandidates, markReflected } from '../server/lib/agent/reflect/candidates'

const convIds: string[] = []
afterAll(async () => {
  const db = useDb()
  await db.delete(conversationMessages).where(inArray(conversationMessages.conversationId, convIds))
  await db.delete(conversations).where(inArray(conversations.id, convIds))
})

const NOW = new Date()
const minAgo = (m: number) => new Date(NOW.getTime() - m * 60_000)

/** A scratch thread whose messages were created `ageMin[i]` minutes ago. */
async function scratch(ageMin: number[], reflectedThrough: Date | null = null) {
  const c = await createConversation({ title: 'REFLECT-CANDIDATES-TEST' }); convIds.push(c.id)
  const db = useDb()
  await db.insert(conversationMessages).values(ageMin.map((m, i) => ({
    conversationId: c.id, role: i % 2 ? 'assistant' : 'user', content: `m${i}`, modality: 'text', createdAt: minAgo(m)
  })))
  await db.update(conversations).set({
    messageCount: ageMin.length, lastMessageAt: minAgo(Math.min(...ageMin)), reflectedThrough
  }).where(eq(conversations.id, c.id))
  return c.id
}
const ids = async (only: string[]) => (await threadCandidates({ now: NOW, onlyConversationIds: only })).map(r => r.conversationId)

describe('threadCandidates', () => {
  it('skips a thread with only 3 new messages', async () => {
    const id = await scratch([70, 60, 50])
    expect(await ids([id])).toEqual([])
  })

  it('skips a thread whose last message is 10 min old', async () => {
    const id = await scratch([70, 60, 50, 10])
    expect(await ids([id])).toEqual([])
  })

  it('includes a thread with 4 new messages idle 40 min, with since = null', async () => {
    const id = await scratch([70, 60, 50, 40])
    expect(await threadCandidates({ now: NOW, onlyConversationIds: [id] })).toEqual([{ conversationId: id, since: null }])
  })

  it('counts only messages newer than reflected_through', async () => {
    const through = minAgo(200)
    const old = await scratch([300, 290, 280, 270, 190, 180, 170], through)          // 3 new
    const fresh = await scratch([300, 290, 190, 180, 170, 160], through)             // 4 new
    const got = await threadCandidates({ now: NOW, onlyConversationIds: [old, fresh] })
    expect(got.map(r => r.conversationId)).toEqual([fresh])
    expect(got[0]!.since!.getTime()).toBe(through.getTime())
  })

  it('excludes a thread reflected 1 h ago', async () => {
    const id = await scratch([100, 90, 80, 70, 50, 45, 42, 40], minAgo(60))
    expect(await ids([id])).toEqual([])
  })

  it('orders by last message, most recent first, and honours limit', async () => {
    const a = await scratch([200, 190, 180, 170])
    const b = await scratch([100, 90, 80, 45])
    const c = await scratch([150, 140, 130, 120])
    expect(await ids([a, b, c])).toEqual([b, c, a])
    expect((await threadCandidates({ now: NOW, limit: 2, onlyConversationIds: [a, b, c] })).map(r => r.conversationId)).toEqual([b, c])
  })
})

describe('markReflected', () => {
  it('advances the watermark so the covered messages no longer count', async () => {
    const id = await scratch([70, 60, 50, 40])
    expect(await ids([id])).toEqual([id])
    await markReflected(id, minAgo(40))
    const [row] = await useDb().select({ r: conversations.reflectedThrough }).from(conversations).where(eq(conversations.id, id))
    expect(row!.r!.getTime()).toBe(minAgo(40).getTime())
    // Even judged 3 h later (past the 2 h cool-down) nothing new has arrived.
    expect((await threadCandidates({ now: new Date(NOW.getTime() + 3 * 3600_000), onlyConversationIds: [id] }))).toEqual([])
  })
})
