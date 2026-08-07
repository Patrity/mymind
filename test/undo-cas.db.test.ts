// test/undo-cas.db.test.ts
//
// DB-backed test — see test/documents-cas.db.test.ts for the harness pattern this file
// follows (`.env` load + `useRuntimeConfig` stub so `useDb()` works outside Nuxt).
//
// Proves the bug this task fixes: today, undoing an agent document edit restores the OLD
// content unconditionally — even if a third party (web UI, another agent, a sync) wrote
// something new in between. That silently destroys the newer write. Each undo closure must
// CAS against the hash its own write produced, so a stale undo refuses instead of clobbering.
//
// `documents_path_live_uidx` is a unique index on live paths, so every fixture below gets a
// unique path and is cleaned up in a try/finally so cleanup runs even when an assertion throws.
process.loadEnvFile('.env')
import { describe, it, expect, vi } from 'vitest'
import type { ToolContext } from '../server/lib/agent/types'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { createDoc, getDoc, updateDoc, deleteDoc } from '../server/services/documents'
import { toolByName } from '../server/lib/agent/tools'

const tool = (n: string) => toolByName(n)!
const ctx: ToolContext = { signal: new AbortController().signal }
const uniquePath = (tag: string) => `/tmp-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.md`

describe('edit_document undo CAS guard', () => {
  it('refuses to undo when the document changed after the edit', async () => {
    const doc = await createDoc({ path: uniquePath('edit-doc-refuse'), content: 'original' })
    try {
      const exec = await tool('edit_document').handler(
        { id: doc.id, old_string: 'original', new_string: 'edited' }, ctx)

      await updateDoc(doc.id, { content: 'a third party wrote this' })

      const res = await exec.undo!()
      expect(res).toMatchObject({ ok: false })
      expect((await getDoc(doc.id))!.content).toBe('a third party wrote this')
    } finally {
      await deleteDoc(doc.id)
    }
  })

  it('undoes cleanly when nothing else touched the document', async () => {
    const doc = await createDoc({ path: uniquePath('edit-doc-clean'), content: 'original' })
    try {
      const exec = await tool('edit_document').handler(
        { id: doc.id, old_string: 'original', new_string: 'edited' }, ctx)

      expect(await exec.undo!()).toMatchObject({ ok: true })
      expect((await getDoc(doc.id))!.content).toBe('original')
    } finally {
      await deleteDoc(doc.id)
    }
  })
})

describe('edit_section undo CAS guard', () => {
  it('refuses to undo when the document changed after the edit', async () => {
    const doc = await createDoc({ path: uniquePath('edit-section-refuse'), content: '# T\n\noriginal' })
    try {
      const exec = await tool('edit_section').handler(
        { id: doc.id, mode: 'append', text: 'more' }, ctx)

      await updateDoc(doc.id, { content: 'a third party wrote this' })

      const res = await exec.undo!()
      expect(res).toMatchObject({ ok: false })
      expect((await getDoc(doc.id))!.content).toBe('a third party wrote this')
    } finally {
      await deleteDoc(doc.id)
    }
  })

  it('undoes cleanly when nothing else touched the document', async () => {
    const doc = await createDoc({ path: uniquePath('edit-section-clean'), content: '# T\n\noriginal' })
    try {
      const exec = await tool('edit_section').handler(
        { id: doc.id, mode: 'append', text: 'more' }, ctx)

      expect(await exec.undo!()).toMatchObject({ ok: true })
      expect((await getDoc(doc.id))!.content).toBe('# T\n\noriginal')
    } finally {
      await deleteDoc(doc.id)
    }
  })
})

describe('sync_document write-branch undo CAS guard', () => {
  it('refuses to undo when the document changed after the sync write', async () => {
    const doc = await createDoc({ path: uniquePath('sync-write-refuse'), content: 'original' })
    try {
      const exec = await tool('sync_document').handler(
        { id: doc.id, content: 'synced content', expected_hash: doc.contentHash }, ctx)
      expect((exec.result as { action?: string }).action).toBe('updated')

      await updateDoc(doc.id, { content: 'a third party wrote this' })

      const res = await exec.undo!()
      expect(res).toMatchObject({ ok: false })
      expect((await getDoc(doc.id))!.content).toBe('a third party wrote this')
    } finally {
      await deleteDoc(doc.id)
    }
  })

  it('undoes cleanly when nothing else touched the document', async () => {
    const doc = await createDoc({ path: uniquePath('sync-write-clean'), content: 'original' })
    try {
      const exec = await tool('sync_document').handler(
        { id: doc.id, content: 'synced content', expected_hash: doc.contentHash }, ctx)
      expect((exec.result as { action?: string }).action).toBe('updated')

      expect(await exec.undo!()).toMatchObject({ ok: true })
      expect((await getDoc(doc.id))!.content).toBe('original')
    } finally {
      await deleteDoc(doc.id)
    }
  })
})
