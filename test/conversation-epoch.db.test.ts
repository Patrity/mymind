// test/conversation-epoch.db.test.ts
//
// DB-backed test — see test/memory-applicability.db.test.ts for the harness pattern this file
// follows (`.env` load + `useRuntimeConfig` stub so `useDb()` works outside Nuxt).
process.loadEnvFile('.env')
import { describe, it, expect, afterAll } from 'vitest'
import { vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { useDb } from '../server/db'
import { conversations, conversationMessages } from '../server/db/schema'
import { loadActivePath } from '../server/services/conversation-path'
import { clearConversationContext } from '../server/services/conversation-clear'
import { eq } from 'drizzle-orm'

const seededConversationIds: string[] = []

async function seed() {
  const db = useDb()
  const [c] = await db.insert(conversations)
    .values({ title: 'EPOCH-TEST', summary: 'a summary that must not survive /clear' })
    .returning()
  const [a] = await db.insert(conversationMessages)
    .values({ conversationId: c!.id, role: 'user', content: 'before clear', modality: 'text' }).returning()
  await db.update(conversations).set({ activeLeafId: a!.id }).where(eq(conversations.id, c!.id))
  seededConversationIds.push(c!.id)
  return c!.id
}

// beforeEach/it-local seeding alone doesn't stop this file's rows leaking into the next file —
// this suite shares one dev Postgres across worktrees/sessions with no per-file isolation.
afterAll(async () => {
  const db = useDb()
  for (const id of seededConversationIds) {
    await db.delete(conversationMessages).where(eq(conversationMessages.conversationId, id))
    await db.delete(conversations).where(eq(conversations.id, id))
  }
})

describe('conversation epoch', () => {
  it('hides pre-epoch messages from the model path', async () => {
    const id = await seed()
    await clearConversationContext(id)
    const { rows } = await loadActivePath(id, { sinceEpoch: true })
    expect(rows).toHaveLength(0)
  })

  it('KEEPS pre-epoch messages on the default (UI) path', async () => {
    const id = await seed()
    await clearConversationContext(id)
    const { rows } = await loadActivePath(id)
    expect(rows.map(r => r.content)).toContain('before clear')
  })

  it('resets the rolling summary — a clear that leaves it is a lie', async () => {
    const id = await seed()
    await clearConversationContext(id)
    const [c] = await useDb().select().from(conversations).where(eq(conversations.id, id)).limit(1)
    expect(c!.summary).toBeNull()
    expect(c!.summaryEmbedding).toBeNull()
  })

  it('shows messages written AFTER the clear', async () => {
    const id = await seed()
    await clearConversationContext(id)
    await useDb().insert(conversationMessages)
      .values({ conversationId: id, role: 'user', content: 'after clear', modality: 'text' })
    const { rows } = await loadActivePath(id, { sinceEpoch: true })
    expect(rows.map(r => r.content)).toEqual(['after clear'])
  })

  it('is a no-op on a conversation that was never cleared', async () => {
    const id = await seed()
    const { rows } = await loadActivePath(id, { sinceEpoch: true })
    expect(rows.map(r => r.content)).toContain('before clear')
  })
})
