// test/enrich-conversations.db.test.ts
//
// DB-backed test — see test/conversation-epoch.db.test.ts for the harness pattern this file
// follows (`.env` load + `useRuntimeConfig` stub so `useDb()` works outside Nuxt).
process.loadEnvFile('.env')
import { describe, it, expect, vi, afterAll } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))
// createMemory -> embedOne -> withFailover reaches the Nitro-global $fetch, which only
// exists inside the Nuxt/Nitro runtime (see test/memory-applicability.db.test.ts for the
// same note). Stub it to a fixed vector so this suite never depends on a homelab embeddings rig.
vi.stubGlobal('$fetch', vi.fn().mockResolvedValue([Array(2560).fill(0.01)]))

import { useDb } from '../server/db'
import { conversations, conversationMessages, memEnrichmentState, memories } from '../server/db/schema'
import { enrichConversations } from '../server/services/memory-enrich'
import { and, eq, inArray } from 'drizzle-orm'

const seededConversationIds: string[] = []
const seededSessionIds: string[] = []

// enrichConversations now gates on an idle guard (lastMessageAt older than 1 hour, mirroring
// runMemoryEnrichment's session gate — see that file for the FIX 4 rationale), so every seeded
// conversation needs a lastMessageAt safely in the past or it is never a candidate at all.
const OLD_ENOUGH = new Date(Date.now() - 2 * 60 * 60 * 1000)

async function seedConversation(content: string) {
  const db = useDb()
  const [c] = await db.insert(conversations).values({ title: 'ENRICH-TEST', messageCount: 2, lastMessageAt: OLD_ENOUGH }).returning()
  await db.insert(conversationMessages).values([
    { conversationId: c!.id, role: 'user', content, modality: 'text' },
    { conversationId: c!.id, role: 'assistant', content: 'noted', modality: 'text' }
  ])
  seededConversationIds.push(c!.id)
  return c!.id
}

// beforeEach/it-local seeding alone doesn't stop this file's rows leaking into the next file —
// this suite shares one dev Postgres across worktrees/sessions with no per-file isolation. This
// test creates conversations, messages AND memories — all three are cleaned up here.
//
// Every call below passes `only: [id]` (enrichConversations' test-only scoping seam) so the
// candidate query can never reach real Bridget conversation history in this shared dev DB —
// there is nothing else to shield or restore, and nothing here can mark a real conversation
// "checked" under a mocked result.
afterAll(async () => {
  const db = useDb()
  if (seededConversationIds.length > 0) {
    await db.delete(conversationMessages).where(inArray(conversationMessages.conversationId, seededConversationIds))
    await db.delete(memEnrichmentState).where(and(
      eq(memEnrichmentState.sourceKind, 'conversation'),
      inArray(memEnrichmentState.sourceId, seededConversationIds)
    ))
    await db.delete(memories).where(inArray(memories.source, seededConversationIds.map(id => `conversation:${id}`)))
    await db.delete(conversations).where(inArray(conversations.id, seededConversationIds))
  }
  if (seededSessionIds.length > 0) {
    await db.delete(memEnrichmentState).where(and(
      eq(memEnrichmentState.sourceKind, 'session'),
      inArray(memEnrichmentState.sourceId, seededSessionIds)
    ))
  }
})

describe('enrichConversations', () => {
  it('extracts a memory from a conversation', async () => {
    const id = await seedConversation('Remember I always deploy on Fridays')
    const extract = vi.fn(async () => [{ scope: 'user' as const, content: 'Tony deploys on Fridays', confidence: 0.9 }])
    const res = await enrichConversations({ limit: 5, only: [id], deps: { extract } })
    expect(res.conversationsProcessed).toBe(1)
    expect(res.memoriesCreated).toBe(1)
    expect(extract).toHaveBeenCalledTimes(1)
  })

  it('records state under source_kind=conversation', async () => {
    const id = await seedConversation('another thing worth remembering')
    await enrichConversations({ limit: 5, only: [id], deps: { extract: async () => [] } })
    const [row] = await useDb().select().from(memEnrichmentState)
      .where(and(eq(memEnrichmentState.sourceKind, 'conversation'), eq(memEnrichmentState.sourceId, id))).limit(1)
    expect(row).toBeTruthy()
  })

  it('does not reprocess a conversation with no new messages', async () => {
    const id = await seedConversation('processed once')
    const extract = vi.fn(async () => [])
    await enrichConversations({ limit: 5, only: [id], deps: { extract } })
    expect(extract.mock.calls.length).toBe(1)
    await enrichConversations({ limit: 5, only: [id], deps: { extract } })
    expect(extract.mock.calls.length).toBe(1)
  })

  it('leaves session enrichment state untouched', async () => {
    const db = useDb()
    const sessionId = crypto.randomUUID()
    seededSessionIds.push(sessionId)
    await db.insert(memEnrichmentState)
      .values({ sourceKind: 'session', sourceId: sessionId, lastEnrichedMessageCount: 7 })
    const id = await seedConversation('unrelated')
    await enrichConversations({ limit: 5, only: [id], deps: { extract: async () => [] } })
    const [row] = await db.select().from(memEnrichmentState)
      .where(and(eq(memEnrichmentState.sourceKind, 'session'), eq(memEnrichmentState.sourceId, sessionId))).limit(1)
    expect(row!.lastEnrichedMessageCount).toBe(7)
  })

  // FIX 4a: a conversation must accumulate >= 5 new messages since its last successful
  // enrichment before it is reconsidered — otherwise a single new message re-fires the
  // extraction prompt on every 15-minute cron tick forever.
  it('does not pick up a conversation with only 1 new message', async () => {
    const id = await seedConversation('needs one more message before this re-enriches')
    // Simulate a prior successful enrichment one message short of the current count
    // (seedConversation's conversation has messageCount: 2) — a delta of exactly 1, below
    // the >= 5 threshold.
    await useDb().insert(memEnrichmentState).values({
      sourceKind: 'conversation', sourceId: id, lastEnrichedMessageCount: 1, lastRun: new Date(), status: 'ok'
    })
    const extract = vi.fn(async () => [])
    const res = await enrichConversations({ limit: 5, only: [id], deps: { extract } })
    expect(res.conversationsProcessed).toBe(0)
    expect(extract).not.toHaveBeenCalled()
  })
})
