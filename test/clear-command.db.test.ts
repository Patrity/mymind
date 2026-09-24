// DB-backed — harness pattern from test/prompt-commands.db.test.ts. These four tests exercise
// cycle 70's ALREADY-SHIPPED epoch mechanism (clearConversationContext, context_epoch_at,
// getAgentHistory's sinceEpoch read) — this task only adds the trigger (the WS message +
// composer dispatch + divider) on top of it. If any of these go red, that is cycle 70's epoch
// broken, not this task's wiring.
process.loadEnvFile('.env')

import { describe, it, expect, afterAll, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { eq, sql } from 'drizzle-orm'
import { useDb } from '../server/db'
import { conversations, conversationMessages } from '../server/db/schema'
import { clearConversationContext } from '../server/services/conversation-clear'
import { getAgentHistory, getConversation } from '../server/services/conversations'

const made: string[] = []

afterAll(async () => {
  for (const id of made) {
    await useDb().delete(conversationMessages).where(eq(conversationMessages.conversationId, id))
    await useDb().delete(conversations).where(eq(conversations.id, id))
  }
})

async function seed(content: string) {
  const db = useDb()
  const [c] = await db.insert(conversations).values({ title: 'CLEAR-TEST', messageCount: 1 }).returning()
  made.push(c!.id)
  const [m] = await db.insert(conversationMessages)
    .values({ conversationId: c!.id, role: 'user', content, modality: 'text' }).returning()
  await db.update(conversations).set({ activeLeafId: m!.id }).where(eq(conversations.id, c!.id))
  return c!.id
}

describe('/clear', () => {
  it('sets an epoch the model honours while the UI still sees the message', async () => {
    const id = await seed('before clear')
    await clearConversationContext(id)

    const model = await getAgentHistory(id)
    expect(JSON.stringify(model)).not.toContain('before clear')

    const ui = await getConversation(id)
    expect(JSON.stringify(ui!.messages)).toContain('before clear')
  })

  it('records an epoch timestamp the UI can anchor a divider to', async () => {
    const id = await seed('anchor me')
    await clearConversationContext(id)
    const [row] = await useDb().select().from(conversations).where(eq(conversations.id, id)).limit(1)
    expect(row!.contextEpochAt).not.toBeNull()
  })

  it('resets the rolling summary — a clear that leaves it is a lie', async () => {
    const id = await seed('summarised')
    await useDb().update(conversations).set({ summary: 'stale summary' }).where(eq(conversations.id, id))
    await clearConversationContext(id)
    const [row] = await useDb().select().from(conversations).where(eq(conversations.id, id)).limit(1)
    expect(row!.summary).toBeNull()
  })

  it('deletes no rows', async () => {
    const id = await seed('survivor')
    const before = await useDb().select({ n: sql<number>`count(*)` }).from(conversationMessages)
      .where(eq(conversationMessages.conversationId, id))
    await clearConversationContext(id)
    const after = await useDb().select({ n: sql<number>`count(*)` }).from(conversationMessages)
      .where(eq(conversationMessages.conversationId, id))
    expect(after[0]!.n).toBe(before[0]!.n)
  })
})
