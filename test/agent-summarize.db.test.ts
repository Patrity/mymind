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
import { messageText } from '../server/lib/agent/run'
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

  // Cycle 73 Task 7b: runner.ts persists a steered turn as [question, steer, reply] in ONE
  // append, so those rows share one created_at. If the fold boundary landed inside that append
  // (it did while groupTurns split turns at every user row), summarized_through = the question's
  // created_at and sinceSummary's `>` hid the steer + reply from the model although the summary
  // never saw them. The trailing plain turn breaks the parity that would otherwise have let the
  // old split land on an append boundary by luck.
  it('never hides an unsummarised row: a fold cannot split a steered append', async () => {
    const c = await createConversation({ title: 'SUMMARIZE-TEST steers' }); convIds.push(c.id)
    const pad = 'w '.repeat(2500)
    for (let i = 0; i < 9; i++) {
      await appendMessages(c.id, [
        { role: 'user', content: `q${i} ${pad}`, modality: 'text' },
        { role: 'user', content: `s${i} ${pad}`, modality: 'text' },
        { role: 'assistant', content: `a${i} ${pad}`, modality: 'text' }
      ])
    }
    await appendMessages(c.id, [
      { role: 'user', content: `q9 ${pad}`, modality: 'text' },
      { role: 'assistant', content: `a9 ${pad}`, modality: 'text' }
    ])
    let transcript = ''
    const capture = async (_prev: string | null, t: string) => {
      transcript = t
      return 'folded'
    }
    expect(await maybeSummarize(c.id, { summarizer: capture, embed: async () => null })).toBe('summarized')

    const marker = (text: string) => text.split(' ', 1)[0]!
    const all = await useDb().select().from(conversationMessages).where(eq(conversationMessages.conversationId, c.id))
    const visible = new Set((await getAgentHistory(c.id)).map(m => marker(messageText(m.content))))
    const hidden = all.map(r => marker(r.content)).filter(m => !visible.has(m))
    expect(hidden.length).toBeGreaterThan(0) // something was actually folded
    // Every row the model can no longer see is in the transcript the summary was written from.
    expect(hidden.filter(m => !transcript.includes(`${m} `))).toEqual([])
    // …and nothing is both summarised and still shown (the fold took whole appends).
    expect([...visible].filter(m => transcript.includes(`${m} `))).toEqual([])
  })
})
