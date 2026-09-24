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
import { getAgentHistory, getConversation } from '../server/services/conversations'
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

  // A single clear-then-insert only catches the app-clock-vs-Postgres-clock race about 10% of
  // the time (it presented as an intermittent flake, not a reliable failure) — the epoch and
  // the row it's raced against must come from the SAME clock (`now()` in Postgres), or a
  // message written immediately after `/clear` can land BEFORE the epoch and vanish from the
  // model's history. Looping the race 10x with no delay between clear and insert makes this
  // fail essentially always under the old (app-clock) code and pass every time under the fix.
  it('shows messages written AFTER the clear, repeatedly, with no delay', async () => {
    const id = await seed()
    for (let i = 0; i < 10; i++) {
      await clearConversationContext(id)
      await useDb().insert(conversationMessages)
        .values({ conversationId: id, role: 'user', content: `after clear ${i}`, modality: 'text' })
      const { rows } = await loadActivePath(id, { sinceEpoch: true })
      expect(rows.map(r => r.content)).toEqual([`after clear ${i}`])
    }
  })

  it('is a no-op on a conversation that was never cleared', async () => {
    const id = await seed()
    const { rows } = await loadActivePath(id, { sinceEpoch: true })
    expect(rows.map(r => r.content)).toContain('before clear')
  })

  // This is the assertion cycle 68's invariant actually hangs on: the two production read
  // paths (getAgentHistory for the model, getConversation for the UI) must diverge on a
  // cleared conversation DELIBERATELY, not by accident. Asserting both in one test is what
  // makes that divergence readable — a change that quietly makes them agree again fails here.
  it('getAgentHistory forgets pre-clear content that getConversation still shows', async () => {
    const id = await seed()
    await clearConversationContext(id)
    await useDb().insert(conversationMessages)
      .values({ conversationId: id, role: 'user', content: 'after clear', modality: 'text' })

    const modelMsgs = await getAgentHistory(id)
    const ui = await getConversation(id)

    expect(modelMsgs.map(m => m.content)).not.toContain('before clear')
    expect(ui!.messages.map(m => m.content)).toContain('before clear')
  })
})
