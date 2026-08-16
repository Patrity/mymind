// test/triage-actuators.db.test.ts
//
// DB-backed test — see test/documents-cas.db.test.ts for the harness pattern this file
// follows (`.env` load + `useRuntimeConfig` stub so `useDb()` works outside Nuxt).
process.loadEnvFile('.env')
import { describe, it, expect, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { applyTask, applyNote } from '../server/services/triage'
import { createDoc, getDoc, deleteDoc } from '../server/services/documents'
import { getTask, deleteTask } from '../server/services/tasks'
import { useDb } from '../server/db'
import { tasks, triageActions } from '../server/db/schema'
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
