// test/triage-actuators.db.test.ts
//
// DB-backed test — see test/documents-cas.db.test.ts for the harness pattern this file
// follows (`.env` load + `useRuntimeConfig` stub so `useDb()` works outside Nuxt).
process.loadEnvFile('.env')
import { describe, it, expect, vi } from 'vitest'

// triageAppendSimilarityFloor mirrors nuxt.config.ts's default (0.75). Without it here,
// resolveAppendTarget's `best.sim >= floor` compares against `undefined`, which is always
// false — every one of its own tests below needs a real floor to exercise the pick vs.
// degrade branches, not just the "no candidate at all" case the original applyAppend
// tests happened to hit.
vi.stubGlobal('useRuntimeConfig', () => ({
  databaseUrl: process.env.DATABASE_URL,
  triageAppendSimilarityFloor: 0.75
}))

// applyMemory (below) is the first thing in this suite to reach createMemory ->
// embedOne -> withFailover, which call the Nitro-global `$fetch` (ofetch). That global
// only exists inside the Nuxt/Nitro runtime — this harness runs server/services/* as
// plain Node, so nothing provides it. Canned mock, not a real network call — matches the
// pattern in server/lib/imagegen/comfy.test.ts / edit.test.ts: a real HTTP call here would
// make `pnpm test:db` (a binding gate for this cycle) depend on a homelab embeddings rig
// being reachable and warmed for a task whose subject (the actuator + dedup routing) has
// nothing to do with embedding quality. TEI's raw response shape is number[][], one vector
// per input (server/lib/ai/embeddings.ts normalizeResponse); embedOne always requests a
// single text, so one fixed 2560-dim vector per call is enough. The one dedup scenario this
// suite asserts (the skip path) is decided by the exact-content-hash branch in
// dedupDecision (server/services/memory-dedup.ts) BEFORE any embedding comparison runs, so
// a fixed vector drives it deterministically; no test here exercises the semantic
// near-duplicate (cosine >= 0.85) branch.
vi.stubGlobal('$fetch', vi.fn().mockResolvedValue([Array(2560).fill(0.01)]))

import { applyTask, applyNote, applyMemory, applyAppend, resolveAppendTarget, revertTriageAction } from '../server/services/triage'
import { createDoc, getDoc, deleteDoc, restoreDoc, updateDoc } from '../server/services/documents'
import { getTask, deleteTask } from '../server/services/tasks'
import { useDb } from '../server/db'
import { tasks, triageActions, memories, chunks, documents } from '../server/db/schema'
import { eq } from 'drizzle-orm'
import { runUndo } from '../server/lib/agent/undo'

const jot = (content: string) =>
  createDoc({ path: `/input/t-${Math.random().toString(36).slice(2, 10)}.md`, content })

// `documents_path_live_uidx` is a unique index on live paths (see test/documents-cas.db.test.ts
// for the convention this follows). applyNote's destination path is a literal the test controls
// (unlike jot()'s already-random source path), so it needs the same per-run uniqueness or a
// second run collides with a prior run's leftover note at the same fixed path.
const uniqueNotePath = (tag: string) => `/notes/${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.md`
const uniqueProjectNotePath = (tag: string) =>
  `/projects/mymind/${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.md`

describe('applyTask', () => {
  // Unlike applyNote's fixed target paths, these don't hit a uniqueness constraint on rerun —
  // jot()'s source path is already random and tasks carry no unique key. The cleanup below is
  // purely hygiene: applyTask only auto-deletes the courier DOCUMENT, never the task it creates,
  // so without it every `pnpm test:db` run leaves another live "Fix the Yukon loan link"-style
  // task in the real dev board.
  it('creates a task carrying the raw jot as its description', async () => {
    const doc = await jot('remind me to fix the yukon loan link')
    const r = await applyTask(doc.id, {
      kind: 'task', confidence: 0.9, title: 'Fix the Yukon loan link',
      project: 'finances', priority: 'medium'
    })
    try {
      const [t] = await useDb().select().from(tasks).where(eq(tasks.id, r.entityId!))
      expect(t!.title).toBe('Fix the Yukon loan link')
      expect(t!.description).toContain('remind me to fix the yukon loan link')
      expect(t!.project).toBe('finances')
      expect(t!.priority).toBe('medium')
      expect(t!.status).toBe('todo')
    } finally {
      await deleteTask(r.entityId!)
    }
  })

  it('soft-deletes the courier document', async () => {
    const doc = await jot('do the thing')
    const r = await applyTask(doc.id, { kind: 'task', confidence: 0.9, title: 'Do the thing' })
    try {
      expect(await getDoc(doc.id)).toBeNull()          // getDoc filters deleted_at
    } finally {
      await deleteTask(r.entityId!)
    }
  })

  it('records a triage_actions row', async () => {
    const doc = await jot('another thing')
    const r = await applyTask(doc.id, { kind: 'task', confidence: 0.91, title: 'Another thing' })
    try {
      const [row] = await useDb().select().from(triageActions).where(eq(triageActions.id, r.actionRowId))
      expect(row!.kind).toBe('task')
      expect(row!.entityType).toBe('task')
      expect(row!.confidence).toBeCloseTo(0.91)
    } finally {
      await deleteTask(r.entityId!)
    }
  })

  it('undo removes the task and restores the document', async () => {
    const doc = await jot('undo me')
    const r = await applyTask(doc.id, { kind: 'task', confidence: 0.9, title: 'Undo me' })
    try {
      expect((await runUndo(r.undoToken)).ok).toBe(true)
      // deleteTask (server/services/tasks.ts:177) is a SOFT delete (sets deleted_at) — the row
      // still physically exists, matching documents' soft-delete convention. A raw table select
      // (as the brief's original draft used) still finds it, so this asserts through the same
      // live-filtered accessor real callers use (getTask / task lists), mirroring how the sibling
      // "soft-deletes the courier document" test above asserts through getDoc rather than a raw select.
      expect(await getTask(r.entityId!)).toBeNull()
      expect(await getDoc(doc.id)).not.toBeNull()
    } finally {
      // The undo above restored the doc live at its original /input/... path — without this it
      // leaks into the real dev DB's "unfiled captures" count on every `pnpm test:db` run.
      await deleteDoc(doc.id)
    }
  })
})

describe('applyNote', () => {
  it('renames the file and moves it out of /input', async () => {
    const doc = await jot('# Postgres HNSW notes\nef_search matters.')
    const target = uniqueProjectNotePath('postgres-hnsw-notes')
    try {
      const r = await applyNote(doc.id, {
        kind: 'note', confidence: 0.9, title: 'Postgres HNSW notes',
        project: 'mymind', path: target
      })
      const moved = await getDoc(r.entityId!)
      expect(moved!.path).toBe(target)
      expect(moved!.title).toBe('Postgres HNSW notes')
      expect(moved!.path.startsWith('/input/')).toBe(false)
    } finally {
      await deleteDoc(doc.id)
    }
  })

  // The document IS the artifact for a note — it must survive, unlike the courier case.
  it('does NOT delete the document', async () => {
    const doc = await jot('keep me')
    const target = uniqueNotePath('keep-me')
    try {
      const r = await applyNote(doc.id, {
        kind: 'note', confidence: 0.9, title: 'Keep me', path: target
      })
      expect(await getDoc(r.entityId!)).not.toBeNull()
    } finally {
      await deleteDoc(doc.id)
    }
  })

  it('derives the project from the destination path', async () => {
    const doc = await jot('project note')
    const target = uniqueProjectNotePath('project-note')
    try {
      const r = await applyNote(doc.id, {
        kind: 'note', confidence: 0.9, title: 'Project note', path: target
      })
      expect((await getDoc(r.entityId!))!.project).toBe('mymind')
    } finally {
      await deleteDoc(doc.id)
    }
  })

  it('undo moves the document back to its original path', async () => {
    const doc = await jot('move me back')
    const original = doc.path
    const target = uniqueNotePath('move-me-back')
    try {
      const r = await applyNote(doc.id, {
        kind: 'note', confidence: 0.9, title: 'Move me back', path: target
      })
      expect((await runUndo(r.undoToken)).ok).toBe(true)
      expect((await getDoc(doc.id))!.path).toBe(original)
    } finally {
      await deleteDoc(doc.id)
    }
  })

  // Final-review Finding B: a degraded append action (no title, no path — the classifier's
  // append prompt never asks the model for either) used to reach this function unchanged and
  // hit BOTH no-op guards (no title -> skip updateDoc, no path -> skip moveDoc), yet still
  // wrote a triage_actions row and returned a successful AppliedAction. The document sat
  // unchanged under its random /input filename, terminal (triaged_at set), while every
  // caller — approveTriage's applied count, the toast, "recently applied" — reported success.
  it('refuses to record a no-op action (no title, no path change)', async () => {
    const doc = await jot('nothing to change')
    try {
      await expect(
        applyNote(doc.id, { kind: 'note', confidence: 0.9 })
      ).rejects.toThrow(/no mutation|no-op|no title|no path/i)

      // Nothing should have happened: no audit row, document untouched at its original path.
      const rows = await useDb().select().from(triageActions).where(eq(triageActions.docId, doc.id))
      expect(rows).toHaveLength(0)
      expect((await getDoc(doc.id))!.path).toBe(doc.path)
    } finally {
      await deleteDoc(doc.id)
    }
  })

  // Final-review Finding C: documents_path_live_uidx is unique on live paths, so moveDoc
  // throws 23505 when the model proposes a path that's already taken (plausible — it derives
  // filenames from content). Before the fix, updateDoc(title) ran FIRST, then moveDoc threw
  // straight out of this function before recordAction ever ran: the title was already
  // overwritten live, no triage_actions row was written, and originalTitle was never captured
  // anywhere — the pre-triage title became unrecoverable and re-approving the same proposal
  // would collide and throw forever. approveEnrichment (server/api/review/kinds.ts) already
  // handles the identical moveDoc collision with a try/catch; this mirrors that.
  it('leaves the document coherent on a destination path collision (no half-written state)', async () => {
    const doc = await jot('will collide on triage note apply')
    await updateDoc(doc.id, { title: 'Pre-Triage Title' })
    const target = uniqueNotePath('collide-on-apply')
    // Squat the destination BEFORE calling applyNote, forcing moveDoc's 23505.
    const squatter = await createDoc({ path: target, content: 'squatter' })
    try {
      const r = await applyNote(doc.id, { kind: 'note', confidence: 0.9, title: 'New Title', path: target })

      // Never silently moved into the squatted path.
      const after = await getDoc(doc.id)
      expect(after!.path).toBe(doc.path)

      // Coherent: an audit row exists either way, and whichever of the two acceptable
      // outcomes happened (title left alone, or title changed AND durably revertible), the
      // pre-triage title is never simply lost.
      const [row] = await useDb().select().from(triageActions).where(eq(triageActions.id, r.actionRowId))
      expect(row).toBeDefined()
      const payload = row!.payload as { originalTitle?: string | null }
      if (after!.title === 'New Title') {
        expect(payload.originalTitle).toBe('Pre-Triage Title')
      } else {
        expect(after!.title).toBe('Pre-Triage Title')
      }
    } finally {
      await deleteDoc(squatter.id)
      await deleteDoc(doc.id)
    }
  })
})

// The brief's applyMemory tests don't route through a deleteMemory helper (none exists —
// createMemory is the only sanctioned write path and there is no hard-delete accessor), so
// cleanup here is a direct `db.delete(memories)` in a finally block. That is fixture teardown
// in a test file, not a production write path, so it doesn't touch the createMemory-only
// constraint the actuator itself is held to. Mirrors Task 5's try/finally convention so
// `pnpm test:db` doesn't leave rows behind in Tony's real dev Postgres.
const purgeMemory = (id: string | null) =>
  id ? useDb().delete(memories).where(eq(memories.id, id)) : Promise.resolve()

describe('applyMemory', () => {
  it('creates a memory with the triage source and confidence', async () => {
    const doc = await jot('Pangolin drops websocket upgrades over 60s idle')
    const r = await applyMemory(doc.id, {
      kind: 'memory', confidence: 0.88, scope: 'agent', project: 'homelab',
      content: 'Pangolin drops websocket upgrades after 60s idle.'
    })
    try {
      const [m] = await useDb().select().from(memories).where(eq(memories.id, r.entityId!))
      expect(m!.content).toContain('Pangolin')
      expect(m!.project).toBe('homelab')
      expect(m!.source).toBe(`triage:${doc.id}`)
      expect(Number(m!.confidence)).toBeCloseTo(0.88)
    } finally {
      await purgeMemory(r.entityId)
    }
  })

  it('soft-deletes the courier document', async () => {
    const doc = await jot('a durable fact')
    const r = await applyMemory(doc.id, { kind: 'memory', confidence: 0.9, content: 'A durable fact.' })
    try {
      expect(await getDoc(doc.id)).toBeNull()
    } finally {
      await purgeMemory(r.entityId)
    }
  })

  // createMemory returns the EXISTING row when dedup decides skip/merge. The actuator
  // must not crash, must not double-insert, and must still record its action row.
  it('handles the dedup skip path without creating a second memory', async () => {
    const content = `dedup probe ${Math.random()}`
    const d1 = await jot('first')
    const r1 = await applyMemory(d1.id, { kind: 'memory', confidence: 0.9, content })
    try {
      const d2 = await jot('second')
      const r2 = await applyMemory(d2.id, { kind: 'memory', confidence: 0.9, content })
      expect(r2.entityId).toBe(r1.entityId)                        // same memory, deduped
      const rows = await useDb().select().from(memories).where(eq(memories.id, r1.entityId!))
      expect(rows).toHaveLength(1)
      expect(r2.actionRowId).not.toBe(r1.actionRowId)              // but both actions recorded
    } finally {
      await purgeMemory(r1.entityId)
    }
  })

  it('undo archives the memory and restores the document', async () => {
    const doc = await jot('undo the memory')
    const r = await applyMemory(doc.id, {
      kind: 'memory', confidence: 0.9, content: `undo probe ${Math.random()}`
    })
    try {
      expect((await runUndo(r.undoToken)).ok).toBe(true)
      const [m] = await useDb().select().from(memories).where(eq(memories.id, r.entityId!))
      expect(m!.archivedAt).not.toBeNull()
      expect(await getDoc(doc.id)).not.toBeNull()
    } finally {
      // Undo restored the doc live at its original /input/... path — without this it leaks
      // into the real dev DB's "unfiled captures" count on every `pnpm test:db` run (same
      // reasoning as applyTask's undo test above).
      await deleteDoc(doc.id)
      await purgeMemory(r.entityId)
    }
  })
})

// Task 11b regression: the spec's locked multi-intent decision ("one primary + up to two
// secondary actions in the same proposal") requires every courier-consuming actuator to
// still be able to read the document after an EARLIER action in the SAME proposal has
// already soft-deleted it. Before the fix, every actuator opened with the live-only
// getDoc(docId), so the second courier-consuming action on a shared docId always threw
// "document ... not found" — silently defeating multi-intent. See task-11b-brief.md.
describe('multi-destination proposals (same docId, two courier-consuming actions)', () => {
  it('applyTask then applyMemory on the same docId both succeed', async () => {
    const doc = await jot('finish the report; also the office wifi password is hunter2')
    const taskResult = await applyTask(doc.id, { kind: 'task', confidence: 0.9, title: 'Finish the report' })
    let memoryResult: Awaited<ReturnType<typeof applyMemory>> | undefined
    try {
      // Same docId as the task above — applyTask already soft-deleted the courier.
      memoryResult = await applyMemory(doc.id, {
        kind: 'memory', confidence: 0.9, content: 'The office wifi password is hunter2.'
      })

      const [t] = await useDb().select().from(tasks).where(eq(tasks.id, taskResult.entityId!))
      expect(t!.title).toBe('Finish the report')

      const [m] = await useDb().select().from(memories).where(eq(memories.id, memoryResult.entityId!))
      expect(m!.content).toContain('hunter2')

      const actionRows = await useDb().select().from(triageActions).where(eq(triageActions.docId, doc.id))
      expect(actionRows).toHaveLength(2)
      expect(actionRows.map(r => r.kind).sort()).toEqual(['memory', 'task'])
    } finally {
      await deleteTask(taskResult.entityId!)
      if (memoryResult) await purgeMemory(memoryResult.entityId)
    }
  })

  it('applyMemory after the courier is already deleted still stores the captured content', async () => {
    const doc = await jot('deleted-courier probe content')
    await deleteDoc(doc.id) // simulate an earlier action in the same proposal consuming it
    let memoryResult: Awaited<ReturnType<typeof applyMemory>> | undefined
    try {
      // No explicit action.content — applyMemory must fall back to doc.content, which
      // means it has to actually READ the already-deleted row, not merely tolerate its
      // absence with a null-content memory.
      memoryResult = await applyMemory(doc.id, { kind: 'memory', confidence: 0.9 })
      const [m] = await useDb().select().from(memories).where(eq(memories.id, memoryResult.entityId!))
      expect(m!.content).toContain('deleted-courier probe content')
    } finally {
      if (memoryResult) await purgeMemory(memoryResult.entityId)
    }
  })

  // Judgment call (see task-11b-report.md): a note's document IS its artifact — unlike
  // task/memory/append, applyNote never deletes the courier, so it must never resurrect
  // one that a sibling action in the same proposal already consumed. It stays on the
  // live-only getDoc, and — to distinguish "already consumed by a sibling action" from
  // "genuinely does not exist" in logs/diagnostics — takes one extra deleted-inclusive
  // read ONLY on the failure path, purely to phrase the error; it never uses that row's
  // content to proceed.
  it('applyNote refuses (does not resurrect) an already-soft-deleted courier', async () => {
    const doc = await jot('will be consumed by a task first')
    const taskResult = await applyTask(doc.id, { kind: 'task', confidence: 0.9, title: 'Consume me' })
    try {
      await expect(
        applyNote(doc.id, { kind: 'note', confidence: 0.9, title: 'Should not resurrect' })
      ).rejects.toThrow(/already consumed/i)

      // Still soft-deleted — applyNote must not have restored, retitled, or moved it.
      expect(await getDoc(doc.id)).toBeNull()
      const [raw] = await useDb().select().from(documents).where(eq(documents.id, doc.id))
      expect(raw!.deletedAt).not.toBeNull()
      expect(raw!.title).not.toBe('Should not resurrect')
    } finally {
      await deleteTask(taskResult.entityId!)
    }
  })
})

// Unlike applyNote's fixed target paths, append targets don't hit a uniqueness
// constraint on rerun (the path already carries Math.random()), so the try/finally
// cleanup below is purely hygiene — same reasoning as applyTask's leftover-task
// cleanup above: without it, every `pnpm test:db` run leaves another live
// "append-target-*"/"append-undo-*" document behind in the real dev DB.
describe('applyAppend', () => {
  it('appends a delimited block without touching existing content', async () => {
    const target = await createDoc({
      path: `/projects/mymind/append-target-${Math.random().toString(36).slice(2, 8)}.md`,
      content: '# Existing\n\nOriginal body that must survive.'
    })
    try {
      const doc = await jot('also: the reranker needs ef_search raised')
      const r = await applyAppend(doc.id, {
        kind: 'append', confidence: 0.9, content: 'The reranker needs ef_search raised.',
        targetDocId: target.id
      })
      const after = await getDoc(target.id)
      expect(after!.content).toContain('Original body that must survive.')   // untouched
      expect(after!.content).toContain('The reranker needs ef_search raised.')
      expect(after!.content.indexOf('Original body')).toBeLessThan(after!.content.indexOf('ef_search raised'))
      expect(r.entityId).toBe(target.id)
    } finally {
      await deleteDoc(target.id)
    }
  })

  it('stamps the appended block with the source doc id', async () => {
    const target = await createDoc({
      path: `/projects/mymind/append-src-${Math.random().toString(36).slice(2, 8)}.md`, content: '# T'
    })
    try {
      const doc = await jot('a fact')
      await applyAppend(doc.id, { kind: 'append', confidence: 0.9, content: 'A fact.', targetDocId: target.id })
      expect((await getDoc(target.id))!.content).toContain(doc.id)
    } finally {
      await deleteDoc(target.id)
    }
  })

  it('soft-deletes the courier document', async () => {
    const target = await createDoc({
      path: `/projects/mymind/append-del-${Math.random().toString(36).slice(2, 8)}.md`, content: '# T'
    })
    try {
      const doc = await jot('courier')
      await applyAppend(doc.id, { kind: 'append', confidence: 0.9, content: 'x', targetDocId: target.id })
      expect(await getDoc(doc.id)).toBeNull()
    } finally {
      await deleteDoc(target.id)
    }
  })

  // The degrade path: no target means file it as a note rather than guess.
  it('degrades to a note when no target document is resolved', async () => {
    const doc = await jot('orphan thought with no home')
    try {
      const r = await applyAppend(doc.id, {
        kind: 'append', confidence: 0.9, content: 'Orphan thought.', title: 'Orphan thought'
      })
      expect(r.entityType).toBe('document')
      expect(r.entityId).toBe(doc.id)                       // the doc survived as the artifact
      expect(await getDoc(doc.id)).not.toBeNull()
    } finally {
      await deleteDoc(doc.id)
    }
  })

  // Final-review Finding B: the classifier's append system prompt (server/lib/ai/triage.ts)
  // only ever asks the model for "content" on an append action — never title or path. Before
  // the fix, a degraded append with neither reached applyNote unchanged, which is a no-op:
  // no title to set, no path to move to, yet it still recorded a "successful" applied action
  // while the document sat untouched under its random /input filename with triaged_at set —
  // terminal, never re-swept. Because triageAppendSimilarityFloor is 0.75 cosine, this
  // degrade path is the COMMON outcome for short jots, not an edge case.
  it('degrading with NO title and NO resolvable target moves the document out of /input rather than reporting a silent no-op success', async () => {
    const doc = await jot('a wandering thought that matches nothing in the corpus')
    try {
      const r = await applyAppend(doc.id, { kind: 'append', confidence: 0.9, content: 'A wandering thought.' })
      const after = await getDoc(r.entityId!)
      // Assert the document actually moved — not merely that applyAppend returned something.
      expect(after).not.toBeNull()
      expect(after!.path.startsWith('/input/')).toBe(false)
      expect(after!.title).toBeTruthy()
    } finally {
      const leftover = await getDoc(doc.id)
      if (leftover) await deleteDoc(leftover.id)
    }
  })

  it('undo removes the appended block and leaves the original content intact', async () => {
    const original = '# Existing\n\nUntouched.'
    const target = await createDoc({
      path: `/projects/mymind/append-undo-${Math.random().toString(36).slice(2, 8)}.md`, content: original
    })
    try {
      const doc = await jot('revert me')
      const r = await applyAppend(doc.id, {
        kind: 'append', confidence: 0.9, content: 'Revert me.', targetDocId: target.id
      })
      expect((await runUndo(r.undoToken)).ok).toBe(true)
      expect((await getDoc(target.id))!.content).toBe(original)
      // The undo above restored the doc live at its original /input/... path — clean it up
      // too, mirroring applyTask/applyMemory's undo-test cleanup above.
      await deleteDoc(doc.id)
    } finally {
      await deleteDoc(target.id)
    }
  })
})

// applyAppend's own tests above all pass targetDocId explicitly (or exercise only the
// null/no-candidate path), so none of them reach resolveAppendTarget's actual ranking
// logic — the part that decides which of Tony's real documents gets edited. These tests
// insert real chunk rows with CONTROLLED embeddings and call the resolver directly.
//
// embedOne is the same $fetch stub used everywhere in this file (line 24 above): every
// call — regardless of input text — resolves to the identical fixed 2560-dim vector.
// That makes the "query vector" constant across every test here, so determinism comes
// from the CANDIDATE vectors we insert, not from crafting realistic content.
describe('resolveAppendTarget', () => {
  // Exact match to what embedOne always returns (see the $fetch stub above) — cosine
  // distance 0, similarity 1.0, the mathematical maximum. No ambient corpus chunk can
  // outscore it (only tie, and only by coincidentally storing this exact synthetic
  // vector, which nothing in a real corpus does), so a fixture using this vector is
  // guaranteed to be the global best match regardless of what else is in the dev DB.
  const EXACT_MATCH_VECTOR = Array(2560).fill(0.01)
  // The true minimum possible cosine similarity (-1, i.e. the opposite direction) — no
  // real corpus chunk can score lower, so a fixture using this vector is guaranteed to
  // clear no reasonable floor.
  const OPPOSITE_VECTOR = Array(2560).fill(-0.01)

  const insertChunk = (sourceId: string, embedding: number[]) =>
    useDb().insert(chunks).values({ sourceType: 'document', sourceId, ord: 0, content: 'probe', embedding })

  // Chunk rows have no soft-delete of their own — deleteDoc only marks the owning
  // document deleted_at, which resolveAppendTarget's join already filters on, but a
  // stray chunk row pointing at nothing is still a row left behind in the real DB.
  const cleanup = (id: string) => Promise.all([deleteDoc(id), useDb().delete(chunks).where(eq(chunks.sourceId, id))])

  it('picks the intended document when a chunk clears the floor', async () => {
    const target = await createDoc({
      path: `/projects/mymind/resolve-hit-${Math.random().toString(36).slice(2, 8)}.md`,
      content: '# candidate'
    })
    try {
      await insertChunk(target.id, EXACT_MATCH_VECTOR)
      expect(await resolveAppendTarget('content is irrelevant — embedOne ignores it in the stub')).toBe(target.id)
    } finally {
      await cleanup(target.id)
    }
  })

  it('returns null when the best match is below the similarity floor', async () => {
    const target = await createDoc({
      path: `/projects/mymind/resolve-miss-${Math.random().toString(36).slice(2, 8)}.md`,
      content: '# candidate'
    })
    try {
      await insertChunk(target.id, OPPOSITE_VECTOR)
      expect(await resolveAppendTarget('content is irrelevant')).toBeNull()
    } finally {
      await cleanup(target.id)
    }
  })

  it('never returns a document under /input/', async () => {
    const target = await createDoc({
      path: `/input/resolve-inbox-${Math.random().toString(36).slice(2, 8)}.md`,
      content: '# inbox candidate'
    })
    try {
      // Maximum possible similarity — if the /input/ exclusion were not applied, this
      // fixture would win over anything else in the corpus (see EXACT_MATCH_VECTOR).
      await insertChunk(target.id, EXACT_MATCH_VECTOR)
      expect(await resolveAppendTarget('content is irrelevant')).toBeNull()
    } finally {
      await cleanup(target.id)
    }
  })

  // Regression guard for the missing notSkill() predicate (code review finding): this
  // test FAILS if resolveAppendTarget's WHERE clause omits notSkill() — the skill doc's
  // unbeatable EXACT_MATCH_VECTOR chunk wins and gets returned — and PASSES once it's
  // present.
  it('never returns a type=skill document', async () => {
    const target = await createDoc({
      path: `/projects/mymind/resolve-skill-${Math.random().toString(36).slice(2, 8)}.md`,
      content: '# skill candidate', type: 'skill'
    })
    try {
      await insertChunk(target.id, EXACT_MATCH_VECTOR)
      expect(await resolveAppendTarget('content is irrelevant')).toBeNull()
    } finally {
      await cleanup(target.id)
    }
  })
})

// Task 12: the undo TOKEN (registerUndo) dies with the process and expires after 10
// minutes — with auto-apply as the norm, the user needs to be able to reverse something
// they noticed the next day. revertTriageAction reverses from the persisted triage_actions
// row instead, so it works with no live token at all.
describe('revertTriageAction (durable, post-TTL)', () => {
  it('reverses an applied task without a live undo token', async () => {
    const doc = await jot('durable revert')
    const r = await applyTask(doc.id, { kind: 'task', confidence: 0.9, title: 'Durable revert' })
    // Consume the token so only the durable path can possibly work.
    await runUndo(r.undoToken)
    await restoreDoc(doc.id)                       // undo the undo, back to applied-ish state
    const again = await applyTask(doc.id, { kind: 'task', confidence: 0.9, title: 'Durable revert 2' })

    try {
      expect((await revertTriageAction(again.actionRowId)).ok).toBe(true)
      // deleteTask (server/services/tasks.ts:177) is a SOFT delete — a raw, unfiltered
      // `select().from(tasks)` would still find the row and pass even if reversal did
      // nothing. Assert through getTask, which filters deleted rows, same as the
      // applyTask "undo removes the task" test above.
      expect(await getTask(again.entityId!)).toBeNull()
      expect(await getDoc(doc.id)).not.toBeNull()
      const [row] = await useDb().select().from(triageActions).where(eq(triageActions.id, again.actionRowId))
      expect(row!.revertedAt).not.toBeNull()
    } finally {
      // Both deleteTask calls are no-ops if the task is already soft-deleted (live()
      // filters it out of the UPDATE), so these are safe regardless of which assertion
      // above failed.
      await deleteTask(r.entityId!)
      await deleteTask(again.entityId!)
      await deleteDoc(doc.id)
    }
  })

  it('is idempotent — a second revert is a no-op, not a crash', async () => {
    const doc = await jot('twice')
    const r = await applyTask(doc.id, { kind: 'task', confidence: 0.9, title: 'Twice' })
    try {
      expect((await revertTriageAction(r.actionRowId)).ok).toBe(true)
      const second = await revertTriageAction(r.actionRowId)
      expect(second.ok).toBe(false)
      expect(second.reason).toContain('already')
    } finally {
      await deleteTask(r.entityId!)
      await deleteDoc(doc.id)
    }
  })

  // Mirrors test/agent-undo.test.ts's leak guard for runUndo: a caught error's message
  // must never reach the user-facing `reason`. Forces the note-revert branch's moveDoc
  // to throw a real unique-constraint violation (documents_path_live_uidx) by occupying
  // the original path with another live document before reverting, then asserts the
  // fixed sentence comes back — not the raw Postgres/Drizzle error text.
  it('does not leak a caught error message into the user-facing reason', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const doc = await jot('will collide on revert')
    const originalPath = doc.path
    const target = uniqueNotePath('collide-target')
    const r = await applyNote(doc.id, { kind: 'note', confidence: 0.9, title: 'Collide', path: target })
    // Occupy the note's original path so the durable revert's moveDoc-back fails.
    const blocker = await createDoc({ path: originalPath, content: 'BLOCKER-CONTENT-a1b2c3' })
    try {
      const res = await revertTriageAction(r.actionRowId)
      expect(res.ok).toBe(false)
      // originalPath IS a bound param of the failing UPDATE (moveDoc writes it back into
      // the `path` column, and it's the exact value the unique-constraint violation is
      // about) — Postgres's DETAIL clause and/or Drizzle's bound-params list would surface
      // it verbatim if the leak bug reappeared. Code review (Task 12, Minor finding)
      // caught that the equivalent check against the blocker's `content` could never fail:
      // that column is never among this query's bound params (it touches path / project /
      // project_id / language / title / updated_at), so it asserted coverage it didn't
      // have. originalPath is the real "would this actually catch a regression" value.
      expect(res.reason).not.toContain(originalPath)
      expect(res.reason).not.toContain('duplicate key')
      expect(res.reason).not.toContain('documents_path_live_uidx')
      expect(res.reason).toBe('the reversal failed — check the item and undo it manually')
      expect(err).toHaveBeenCalledWith('[triage] revert failed:', expect.any(Error))
    } finally {
      err.mockRestore()
      await deleteDoc(blocker.id)
      await deleteDoc(r.entityId!)
    }
  })

  // Code review (Task 12, Important finding): the durable path only restored the PATH,
  // not the title — applyNote's own live-token undo closure does both
  // (moveDoc + updateDoc({ title: doc.title })), but the payload only ever carried
  // originalPath, so revertTriageAction had no data to restore the title from. It
  // returned { ok: true } while leaving the AI-assigned title in place — a success
  // reported that wasn't fully delivered, the same failure class Task 11b fixed for
  // multi-intent proposals.
  it('durably restores both the path and the pre-triage title', async () => {
    const doc = await jot('has a real pre-triage title')
    await updateDoc(doc.id, { title: 'Original Courier Title' })
    const originalPath = doc.path
    const target = uniqueNotePath('title-restore')
    const r = await applyNote(doc.id, { kind: 'note', confidence: 0.9, title: 'AI Assigned Title', path: target })
    try {
      // Sanity: the AI's title really did take effect, so the assertion below is
      // proving a REVERT, not just that the title was never touched.
      expect((await getDoc(r.entityId!))!.title).toBe('AI Assigned Title')

      expect((await revertTriageAction(r.actionRowId)).ok).toBe(true)
      const reverted = await getDoc(doc.id)
      expect(reverted!.path).toBe(originalPath)
      expect(reverted!.title).toBe('Original Courier Title')
    } finally {
      await deleteDoc(doc.id)
    }
  })

  // originalTitle: null is a real, distinct state ("this document had no title before
  // triage") from originalTitle being entirely absent (pre-fix rows) — must round-trip
  // faithfully rather than being coerced to '' or skipped.
  it('durably restores a null pre-triage title', async () => {
    const doc = await jot('no title before triage')
    await updateDoc(doc.id, { title: null })
    const target = uniqueNotePath('null-title-restore')
    const r = await applyNote(doc.id, { kind: 'note', confidence: 0.9, title: 'AI Assigned Title', path: target })
    try {
      expect((await getDoc(r.entityId!))!.title).toBe('AI Assigned Title') // sanity
      expect((await revertTriageAction(r.actionRowId)).ok).toBe(true)
      expect((await getDoc(doc.id))!.title).toBeNull()
    } finally {
      await deleteDoc(doc.id)
    }
  })
})
