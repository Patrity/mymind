// test/triage-retriage.db.test.ts
//
// DB-backed test — see test/documents-cas.db.test.ts for the harness pattern this file
// follows (`.env` load + `useRuntimeConfig` stub so `useDb()` works outside Nuxt).
process.loadEnvFile('.env')
import { describe, it, expect, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({
  databaseUrl: process.env.DATABASE_URL,
  triageAppendSimilarityFloor: 0.75
}))
// createMemory -> embedOne -> $fetch: canned, never a real call. See the long note in
// test/triage-actuators.db.test.ts for why this is a fixed vector rather than live.
vi.stubGlobal('$fetch', vi.fn().mockResolvedValue([Array(2560).fill(0.01)]))

const { applyTask, applyMemory, revertTriageAction, retriageDocument, sweepUntriaged }
  = await import('../server/services/triage')
const { createDoc, getDoc, deleteDoc } = await import('../server/services/documents')
const { getTask } = await import('../server/services/tasks')
const { useDb } = await import('../server/db')
const { documents, triageActions, memories } = await import('../server/db/schema')
const { eq } = await import('drizzle-orm')

const uniq = () => Math.random().toString(36).slice(2, 10)
const jot = (content = 'do a thing') => createDoc({ path: `/input/rt-${uniq()}.md`, content })

async function triagedAt(id: string) {
  const [r] = await useDb().select({ t: documents.triagedAt }).from(documents).where(eq(documents.id, id))
  return r?.t ?? null
}
async function stamp(id: string) {
  await useDb().update(documents).set({ triagedAt: new Date() }).where(eq(documents.id, id))
}

// A reverted or rejected proposal leaves triaged_at stamped ON PURPOSE — the user has
// already said this proposal was wrong, and the sweeper's candidate query is
// `triaged_at IS NULL`, so clearing it on revert would re-propose the same thing within
// ten minutes. Once a bar is below 1.0 that becomes an apply -> undo -> re-apply loop.
// Re-eligibility is therefore an EXPLICIT user action, never an automatic consequence.
describe('retriageDocument', () => {
  it('clears triaged_at so the sweeper can consider the document again', async () => {
    const doc = await jot()
    await stamp(doc.id)
    expect(await triagedAt(doc.id)).not.toBeNull()
    try {
      expect(await retriageDocument(doc.id)).toEqual({ ok: true })
      expect(await triagedAt(doc.id)).toBeNull()
    } finally {
      await deleteDoc(doc.id)
    }
  })

  it('makes a stranded document a sweeper candidate again', async () => {
    const doc = await jot()
    await stamp(doc.id)
    try {
      const before = await useDb().select({ id: documents.id }).from(documents)
        .where(eq(documents.id, doc.id))
      expect(before).toHaveLength(1)                       // sanity: row exists
      await retriageDocument(doc.id)
      // sweepUntriaged's candidate query is live + /input/ + triaged_at IS NULL.
      // Rather than run a real sweep (which would spend a model call), assert the
      // column the query keys on.
      expect(await triagedAt(doc.id)).toBeNull()
    } finally {
      await deleteDoc(doc.id)
    }
  })

  it('refuses a document that does not exist', async () => {
    const res = await retriageDocument('00000000-0000-0000-0000-000000000000')
    expect(res.ok).toBe(false)
    expect(res.reason).toBeTruthy()
  })

  it('refuses a soft-deleted document rather than silently resurrecting it', async () => {
    const doc = await jot()
    await stamp(doc.id)
    await deleteDoc(doc.id)
    const res = await retriageDocument(doc.id)
    expect(res.ok).toBe(false)
    expect(await triagedAt(doc.id)).not.toBeNull()          // untouched
  })
})

// Reverting one action of a multi-destination proposal must not hand the courier back
// while a sibling action still holds it — that leaves the user with BOTH a live task and
// the original note, from one jot.
describe('revertTriageAction with a sibling action still live', () => {
  it('does not restore the courier while another action still holds it', async () => {
    const doc = await jot('fix the loan link, and links break on resync')
    const t = await applyTask(doc.id, { kind: 'task', confidence: 0.9, title: 'Fix the loan link' })
    const m = await applyMemory(doc.id, {
      kind: 'memory', confidence: 0.9, content: `links break on resync ${uniq()}`
    })
    try {
      expect(await getDoc(doc.id)).toBeNull()               // consumed by the pair

      // Revert ONLY the task. The memory still exists, so the courier must stay consumed.
      expect((await revertTriageAction(t.actionRowId)).ok).toBe(true)
      expect(await getTask(t.entityId!)).toBeNull()         // task really went
      expect(await getDoc(doc.id)).toBeNull()               // courier NOT resurrected

      // Reverting the last remaining action releases it.
      expect((await revertTriageAction(m.actionRowId)).ok).toBe(true)
      expect(await getDoc(doc.id)).not.toBeNull()
    } finally {
      await useDb().delete(triageActions).where(eq(triageActions.docId, doc.id))
      if (m.entityId) await useDb().delete(memories).where(eq(memories.id, m.entityId))
      await deleteDoc(doc.id)
    }
  })

  it('still restores the courier for a lone action', async () => {
    const doc = await jot()
    const t = await applyTask(doc.id, { kind: 'task', confidence: 0.9, title: `Lone ${uniq()}` })
    try {
      expect(await getDoc(doc.id)).toBeNull()
      expect((await revertTriageAction(t.actionRowId)).ok).toBe(true)
      expect(await getDoc(doc.id)).not.toBeNull()
    } finally {
      await useDb().delete(triageActions).where(eq(triageActions.docId, doc.id))
      await deleteDoc(doc.id)
    }
  })
})
