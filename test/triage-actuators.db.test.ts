// test/triage-actuators.db.test.ts
//
// DB-backed test — see test/documents-cas.db.test.ts for the harness pattern this file
// follows (`.env` load + `useRuntimeConfig` stub so `useDb()` works outside Nuxt).
process.loadEnvFile('.env')
import { describe, it, expect, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

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

import { applyTask, applyNote, applyMemory, applyAppend } from '../server/services/triage'
import { createDoc, getDoc, deleteDoc } from '../server/services/documents'
import { getTask, deleteTask } from '../server/services/tasks'
import { useDb } from '../server/db'
import { tasks, triageActions, memories } from '../server/db/schema'
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
      // applyNote (the degrade target) does not move or delete the doc when no path is
      // given, so it stays live at its original /input/... path unless we clean it up here.
      await deleteDoc(doc.id)
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
