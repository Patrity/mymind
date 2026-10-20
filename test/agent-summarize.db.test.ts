// test/agent-summarize.db.test.ts
//
// DB-backed test — see test/conversation-epoch.db.test.ts for the harness pattern this file
// follows (`.env` load + `useRuntimeConfig` stub so `useDb()` works outside Nuxt).
process.loadEnvFile('.env')
import { describe, it, expect, afterAll } from 'vitest'
import { vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { useDb } from '@mymind/core/db'
import { conversations, conversationMessages } from '@mymind/core/db/schema'
import { maybeSummarize, idleThreadCandidates, SUMMARY_KEEP_TURNS } from '@mymind/core/lib/agent/runtime/summarize'
import { appendEvent } from '@mymind/core/services/conversations'
import { appendMessages, getAgentHistory, getConversation, createConversation, setBranchLeaf, setActiveLeaf, captureTurnLeaf } from '@mymind/core/services/conversations'
import { loadSummary } from '@mymind/core/lib/agent/assemble'
import { messageText } from '@mymind/core/lib/agent/run'
import { eq, inArray, sql } from 'drizzle-orm'

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
    await expect(maybeSummarize(id, { summarizer: async () => { throw new Error('rig down') }, embed: async () => null })).resolves.toBe('failed')
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

  // Final review I5: a /clear landing while the summarizer call is in flight moves the epoch
  // and nulls the summary; the fold's write must not resurrect what was just forgotten.
  it('a fold whose epoch moved mid-flight writes nothing', async () => {
    const id = await threadWith(10, 2500)
    const clearing = async (_prev: string | null, t: string) => {
      await useDb().update(conversations).set({ contextEpochAt: sql`now()`, summary: null }).where(eq(conversations.id, id))
      return `stale summary of ${t.length}`
    }
    expect(await maybeSummarize(id, { summarizer: clearing, embed: async () => null })).toBe('skipped')
    const [c] = await useDb().select().from(conversations).where(eq(conversations.id, id))
    expect(c!.summary).toBeNull()
    expect(c!.summarizedThrough).toBeNull()
  })

  it('an UNCHANGED non-null epoch (microsecond precision) does not block the write', async () => {
    const c0 = await createConversation({ title: 'SUMMARIZE-TEST epoch' }); convIds.push(c0.id)
    await useDb().update(conversations).set({ contextEpochAt: sql`now() - interval '1 hour'` }).where(eq(conversations.id, c0.id))
    for (let i = 0; i < 10; i++) {
      await appendMessages(c0.id, [
        { role: 'user', content: `q${i} ` + 'w '.repeat(2500), modality: 'text' },
        { role: 'assistant', content: `a${i} ` + 'w '.repeat(2500), modality: 'text' }
      ])
    }
    expect(await maybeSummarize(c0.id, { summarizer: fakeSummarizer, embed: async () => null })).toBe('summarized')
  })

  // Final review I6: a fold sends at most ~24k tokens of transcript and the next one continues.
  it('folds a long thread in chunks, oldest first, each continuing where the last stopped', async () => {
    const id = await threadWith(20, 5700)   // ~3k tokens per message, ~6k per turn
    const seen: string[] = []
    const capture = async (prev: string | null, t: string) => { seen.push(t); return `${prev ?? ''}|${t.match(/q\d+/g)!.join(',')}` }
    expect(await maybeSummarize(id, { summarizer: capture, embed: async () => null })).toBe('summarized')
    const first = seen[0]!.match(/q\d+/g)!
    expect(first[0]).toBe('q0')
    expect(first.length).toBeLessThan(20 - SUMMARY_KEEP_TURNS)   // not the whole foldable span
    expect(await maybeSummarize(id, { summarizer: capture, embed: async () => null })).toBe('summarized')
    const second = seen[1]!.match(/q\d+/g)!
    expect(second[0]).toBe(`q${first.length}`)                  // continues, no overlap, no gap
  })

  // Final review m2: event rows reach the summarizer as notes, not as something Tony said.
  it('labels event rows by what they are, not as Tony', async () => {
    const id = await threadWith(1, 2500)
    await appendEvent(id, 'A turn was interrupted by a restart and did not finish.', 'runtime:restart')
    for (let i = 1; i < 10; i++) {
      await appendMessages(id, [
        { role: 'user', content: `q${i} ` + 'w '.repeat(2500), modality: 'text' },
        { role: 'assistant', content: `a${i} ` + 'w '.repeat(2500), modality: 'text' }
      ])
    }
    let transcript = ''
    await maybeSummarize(id, { force: true, summarizer: async (_p, t) => { transcript = t; return 'x' }, embed: async () => null })
    const lines = transcript.split('\n\n')
    expect(lines).toContain('Note (restart): A turn was interrupted by a restart and did not finish.')
  })

  describe('idle sweep candidates', () => {
    async function idleThread(turns: number, minutesAgo: number) {
      const id = await threadWith(turns)
      await useDb().update(conversations).set({ lastMessageAt: sql`now() - make_interval(mins => ${minutesAgo})` }).where(eq(conversations.id, id))
      return id
    }
    it('only threads with enough unsummarised messages, most recently active first', async () => {
      const older = await idleThread(10, 120)
      const newer = await idleThread(10, 60)
      const short = await idleThread(5, 60)                     // 10 messages — nothing to fold
      const caughtUp = await idleThread(10, 60)                 // folded up to its kept tail
      // Backdate its rows so summarized_through < last_message_at, as on a real idle thread —
      // the old sweep's only "anything new?" test, which a caught-up thread always passes.
      await useDb().update(conversationMessages).set({ createdAt: sql`${conversationMessages.createdAt} - interval '2 hours'` }).where(eq(conversationMessages.conversationId, caughtUp))
      const rows = await useDb().select().from(conversationMessages).where(eq(conversationMessages.conversationId, caughtUp)).orderBy(conversationMessages.createdAt)
      await useDb().update(conversations).set({ summarizedThrough: rows[rows.length - 13]!.createdAt }).where(eq(conversations.id, caughtUp))
      expect(await idleThreadCandidates({ onlyIds: [older, newer, short, caughtUp] })).toEqual([newer, older])
    })
  })

  // Cycle 88: one summary per thread, many branches. The summary (and its summarized_through cut)
  // applies only to the branch it was folded from — after a first-message edit or any branch
  // switch it describes ANOTHER conversation and must not reach the model.
  describe('branch-aware summary', () => {
    const marks = async (id: string) => (await getAgentHistory(id)).map(m => messageText(m.content).split(' ', 1)[0])
    async function rowOf(id: string, mark: string) {
      const rows = await useDb().select().from(conversationMessages).where(eq(conversationMessages.conversationId, id))
      return rows.find(r => r.content.startsWith(mark + ' '))!
    }

    it('records the last folded row as summary_leaf_id', async () => {
      const id = await threadWith(10, 2500)
      await maybeSummarize(id, { summarizer: fakeSummarizer, embed: async () => null })
      const [c] = await useDb().select().from(conversations).where(eq(conversations.id, id))
      expect(c!.summaryLeafId).toBe((await rowOf(id, 'a3')).id)
      expect(await loadSummary(id)).toBe('summary of q0,q1,q2,q3')
    })

    it('after a FIRST-message edit: no summary, and the new branch history is just the new first turn', async () => {
      const id = await threadWith(10, 2500)
      await maybeSummarize(id, { summarizer: fakeSummarizer, embed: async () => null })
      await setBranchLeaf(id, (await rowOf(id, 'q0')).id, 'edit')
      expect(await loadSummary(id)).toBeNull()                                  // pending: empty path
      await appendMessages(id, [{ role: 'user', content: 'fresh start', modality: 'text' }, { role: 'assistant', content: 'hi', modality: 'text' }], null)
      expect(await loadSummary(id)).toBeNull()
      expect(await marks(id)).toEqual(['fresh', 'hi'])
      // Paging back to the original branch: the summary is its own again, and so is the cut.
      await setActiveLeaf(id, (await rowOf(id, 'q0')).id)
      expect(await loadSummary(id)).toBe('summary of q0,q1,q2,q3')
      expect((await marks(id))[0]).toBe('q4')
    })

    it('after a branch switch BELOW the folded span: no summary, and the summarized_through cut is not applied', async () => {
      const id = await threadWith(10, 2500)
      await maybeSummarize(id, { summarizer: fakeSummarizer, embed: async () => null })
      // Edit q2 (inside the folded span): the new branch is q0 a0 q1 a1 + the edit.
      await setBranchLeaf(id, (await rowOf(id, 'q2')).id, 'edit')
      await appendMessages(id, [{ role: 'user', content: 'q2b other', modality: 'text' }, { role: 'assistant', content: 'a2b ok', modality: 'text' }])
      expect(await loadSummary(id)).toBeNull()
      // Without the fix, sinceSummary cut q0..a1 (folded) AND the summary was skipped/foreign.
      expect(await marks(id)).toEqual(['q0', 'a0', 'q1', 'a1', 'q2b', 'a2b'])
    })

    it('a fold on a branch the summary does not apply to starts fresh (prev = null) from the start of the path', async () => {
      const id = await threadWith(10, 2500)
      await maybeSummarize(id, { summarizer: fakeSummarizer, embed: async () => null })
      await setBranchLeaf(id, (await rowOf(id, 'q0')).id, 'edit')
      for (let i = 0; i < 10; i++) {
        await appendMessages(id, [
          { role: 'user', content: `n${i} ` + 'w '.repeat(2500), modality: 'text' },
          { role: 'assistant', content: `m${i} ` + 'w '.repeat(2500), modality: 'text' }
        // The first turn is the web turn the edit belongs to: the runner passes captureTurnLeaf's
        // null (a default-parent append extends the OLD branch — PENDING ROOT rule 1).
        ], i === 0 ? await captureTurnLeaf(id) : undefined)
      }
      let prevSeen: string | null = 'unset', transcript = ''
      await maybeSummarize(id, { summarizer: async (p, t) => { prevSeen = p; transcript = t; return 'new branch summary' }, embed: async () => null })
      expect(prevSeen).toBeNull()
      expect(transcript.startsWith('Tony: n0 ')).toBe(true)
      expect(transcript).not.toMatch(/\bq\d+ /)
      expect(await loadSummary(id)).toBe('new branch summary')
    })

    it('a pre-cycle-88 summary (summary_leaf_id null) is trusted as before', async () => {
      const id = await threadWith(10, 2500)
      await maybeSummarize(id, { summarizer: fakeSummarizer, embed: async () => null })
      await useDb().update(conversations).set({ summaryLeafId: null }).where(eq(conversations.id, id))
      expect(await loadSummary(id)).toBe('summary of q0,q1,q2,q3')
      expect((await marks(id))[0]).toBe('q4')
    })
  })
})
