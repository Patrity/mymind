// test/agent-summarize.db.test.ts
//
// DB-backed test — see test/conversation-epoch.db.test.ts for the harness pattern this file
// follows (`.env` load + `useRuntimeConfig` stub so `useDb()` works outside Nuxt).
process.loadEnvFile('.env')
import { describe, it, expect, afterAll } from 'vitest'
import { vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { useDb } from '../server/db'
import { conversations, conversationMessages } from '../server/db/schema'
import { maybeSummarize, SUMMARY_KEEP_TURNS } from '../server/lib/agent/runtime/summarize'
import { appendMessages, getAgentHistory, getConversation, createConversation } from '../server/services/conversations'
import { eq, inArray } from 'drizzle-orm'

const convIds: string[] = []
afterAll(async () => {
  const db = useDb()
  await db.delete(conversationMessages).where(inArray(conversationMessages.conversationId, convIds))
  await db.delete(conversations).where(inArray(conversations.id, convIds))
})
async function threadWith(turns: number, size = 50) {
  const c = await createConversation({ title: 'SUMMARIZE-TEST' }); convIds.push(c.id)
  for (let i = 0; i < turns; i++) {
    await appendMessages(c.id, [
      { role: 'user', content: `q${i} ` + 'w '.repeat(size), modality: 'text' },
      { role: 'assistant', content: `a${i} ` + 'w '.repeat(size), modality: 'text' }
    ])
  }
  return c.id
}
const fakeSummarizer = async (prev: string | null, transcript: string) => `${prev ? prev + ' + ' : ''}summary of ${transcript.match(/q\d+/g)?.join(',')}`

describe('maybeSummarize', () => {
  it('skips a short thread', async () => {
    const id = await threadWith(3)
    expect(await maybeSummarize(id, { summarizer: fakeSummarizer, embed: async () => null })).toBe('skipped')
  })

  it('folds everything but the last 6 turns once over the trigger, and the model then reads tail + summary', async () => {
    const id = await threadWith(10, 2500)
    expect(await maybeSummarize(id, { summarizer: fakeSummarizer, embed: async () => null })).toBe('summarized')
    const [c] = await useDb().select().from(conversations).where(eq(conversations.id, id))
    expect(c!.summary).toBe('summary of q0,q1,q2,q3')
    expect(c!.summarizedThrough).toBeTruthy()
    const model = await getAgentHistory(id)
    expect(model.filter(m => m.role === 'user')).toHaveLength(SUMMARY_KEEP_TURNS)
    expect((await getConversation(id))!.messages).toHaveLength(20)   // the UI still has everything
  })

  it('is incremental: a second fold extends the previous summary', async () => {
    const id = await threadWith(10, 2500)
    await maybeSummarize(id, { summarizer: fakeSummarizer, embed: async () => null })
    await appendMessages(id, Array.from({ length: 8 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: `q${10 + i} ` + 'w '.repeat(2500), modality: 'text' as const })))
    await maybeSummarize(id, { summarizer: fakeSummarizer, embed: async () => null })
    const [c] = await useDb().select().from(conversations).where(eq(conversations.id, id))
    expect(c!.summary).toMatch(/^summary of q0,q1,q2,q3 \+ summary of q4,q5/)
  })

  it('force folds a short idle thread down to the kept tail', async () => {
    const id = await threadWith(8)
    expect(await maybeSummarize(id, { force: true, summarizer: fakeSummarizer, embed: async () => null })).toBe('summarized')
  })

  it('a thread at exactly SUMMARY_KEEP_TURNS has nothing to fold, even forced', async () => {
    const id = await threadWith(SUMMARY_KEEP_TURNS)
    expect(await maybeSummarize(id, { force: true, summarizer: fakeSummarizer, embed: async () => null })).toBe('skipped')
    const [c] = await useDb().select().from(conversations).where(eq(conversations.id, id))
    expect(c!.summarizedThrough).toBeNull()
  })

  it('a summarizer failure leaves the thread untouched', async () => {
    const id = await threadWith(10, 2500)
    await expect(maybeSummarize(id, { summarizer: async () => { throw new Error('rig down') }, embed: async () => null })).resolves.toBe('skipped')
    const [c] = await useDb().select().from(conversations).where(eq(conversations.id, id))
    expect(c!.summarizedThrough).toBeNull()
  })
})
