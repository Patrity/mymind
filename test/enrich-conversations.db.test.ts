// test/enrich-conversations.db.test.ts
//
// DB-backed test — see test/conversation-epoch.db.test.ts for the harness pattern this file
// follows (`.env` load + `useRuntimeConfig` stub so `useDb()` works outside Nuxt).
process.loadEnvFile('.env')
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))
// createMemory -> embedOne -> withFailover reaches the Nitro-global $fetch, which only
// exists inside the Nuxt/Nitro runtime (see test/memory-applicability.db.test.ts for the
// same note). Stub it to a fixed vector so this suite never depends on a homelab embeddings rig.
vi.stubGlobal('$fetch', vi.fn().mockResolvedValue([Array(2560).fill(0.01)]))

import { useDb } from '../server/db'
import { conversations, conversationMessages, memEnrichmentState, memories } from '../server/db/schema'
import { enrichConversations } from '../server/services/memory-enrich'
import { and, eq, inArray, sql } from 'drizzle-orm'

const seededConversationIds: string[] = []
const seededSessionIds: string[] = []

async function seedConversation(content: string) {
  const db = useDb()
  const [c] = await db.insert(conversations).values({ title: 'ENRICH-TEST', messageCount: 2 }).returning()
  await db.insert(conversationMessages).values([
    { conversationId: c!.id, role: 'user', content, modality: 'text' },
    { conversationId: c!.id, role: 'assistant', content: 'noted', modality: 'text' }
  ])
  seededConversationIds.push(c!.id)
  return c!.id
}

// enrichConversations' candidate query is the real production query — it has no test-scoping
// hook, and this dev DB carries real Bridget conversation history (Tony's own agent-chat
// sessions). Left unshielded, this suite's MOCKED extractor (which usually returns []) would
// get called against those real conversations too and permanently mark them "checked, zero
// memories" under a fake result — corrupting real enrichment state, not just leaking test rows.
// Snapshot every real conversation that currently qualifies as a candidate, mark it enriched
// for the duration of this suite, and restore its exact prior state in afterAll.
interface ShieldedRow {
  id: string
  hadRow: boolean
  priorCount: number
  priorStatus: string | null
  priorError: string | null
  priorLastRun: Date | null
}
const shielded: ShieldedRow[] = []

beforeAll(async () => {
  const db = useDb()
  const real = await db.select({
    id: conversations.id,
    messageCount: conversations.messageCount,
    existingSourceId: memEnrichmentState.sourceId,
    priorCount: memEnrichmentState.lastEnrichedMessageCount,
    priorStatus: memEnrichmentState.status,
    priorError: memEnrichmentState.error,
    priorLastRun: memEnrichmentState.lastRun
  })
    .from(conversations)
    .leftJoin(memEnrichmentState, and(
      eq(memEnrichmentState.sourceKind, 'conversation'),
      eq(memEnrichmentState.sourceId, conversations.id)
    ))
    .where(sql`${conversations.title} is distinct from 'ENRICH-TEST'`)

  for (const r of real) {
    const priorCount = r.priorCount ?? 0
    if (r.messageCount <= priorCount) continue // not a candidate — nothing to shield
    shielded.push({
      id: r.id,
      hadRow: r.existingSourceId != null,
      priorCount,
      priorStatus: r.priorStatus,
      priorError: r.priorError,
      priorLastRun: r.priorLastRun
    })
    await db.insert(memEnrichmentState)
      .values({ sourceKind: 'conversation', sourceId: r.id, lastEnrichedMessageCount: r.messageCount, status: 'ok', lastRun: new Date() })
      .onConflictDoUpdate({
        target: [memEnrichmentState.sourceKind, memEnrichmentState.sourceId],
        set: { lastEnrichedMessageCount: r.messageCount, status: 'ok', lastRun: new Date() }
      })
  }
})

// beforeEach/it-local seeding alone doesn't stop this file's rows leaking into the next file —
// this suite shares one dev Postgres across worktrees/sessions with no per-file isolation. This
// test creates conversations, messages AND memories — all three are cleaned up here, plus the
// real conversations shielded in beforeAll are restored to their exact prior enrichment state.
afterAll(async () => {
  const db = useDb()
  for (const s of shielded) {
    if (s.hadRow) {
      await db.update(memEnrichmentState)
        .set({ lastEnrichedMessageCount: s.priorCount, status: s.priorStatus, error: s.priorError, lastRun: s.priorLastRun })
        .where(and(eq(memEnrichmentState.sourceKind, 'conversation'), eq(memEnrichmentState.sourceId, s.id)))
    } else {
      await db.delete(memEnrichmentState)
        .where(and(eq(memEnrichmentState.sourceKind, 'conversation'), eq(memEnrichmentState.sourceId, s.id)))
    }
  }
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
    const res = await enrichConversations({ limit: 5, deps: { extract } })
    expect(res.conversationsProcessed).toBeGreaterThan(0)
    expect(res.memoriesCreated).toBeGreaterThan(0)
    expect(extract).toHaveBeenCalled()
    void id
  })

  it('records state under source_kind=conversation', async () => {
    const id = await seedConversation('another thing worth remembering')
    await enrichConversations({ limit: 5, deps: { extract: async () => [] } })
    const [row] = await useDb().select().from(memEnrichmentState)
      .where(and(eq(memEnrichmentState.sourceKind, 'conversation'), eq(memEnrichmentState.sourceId, id))).limit(1)
    expect(row).toBeTruthy()
  })

  it('does not reprocess a conversation with no new messages', async () => {
    await seedConversation('processed once')
    const extract = vi.fn(async () => [])
    await enrichConversations({ limit: 5, deps: { extract } })
    const firstCalls = extract.mock.calls.length
    await enrichConversations({ limit: 5, deps: { extract } })
    expect(extract.mock.calls.length).toBe(firstCalls)
  })

  it('leaves session enrichment state untouched', async () => {
    const db = useDb()
    const sessionId = crypto.randomUUID()
    seededSessionIds.push(sessionId)
    await db.insert(memEnrichmentState)
      .values({ sourceKind: 'session', sourceId: sessionId, lastEnrichedMessageCount: 7 })
    await seedConversation('unrelated')
    await enrichConversations({ limit: 5, deps: { extract: async () => [] } })
    const [row] = await db.select().from(memEnrichmentState)
      .where(and(eq(memEnrichmentState.sourceKind, 'session'), eq(memEnrichmentState.sourceId, sessionId))).limit(1)
    expect(row!.lastEnrichedMessageCount).toBe(7)
  })
})
