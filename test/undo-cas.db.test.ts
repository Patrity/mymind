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
import * as documentsService from '../server/services/documents'
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

// Fix round 1, Finding 1: `updated?.contentHash ?? null` was itself a defect — casUpdateContent
// treats expectedHash: null as FORCE, so when `updated` is null (the write never landed because
// the row vanished between getDoc and updateDoc) the fallback disabled the guard entirely and
// force-wrote `prior` over whatever now lives at that id. A true getDoc/updateDoc race is
// non-deterministic to reproduce over a real network round-trip, so this simulates it
// deterministically: `documentsService.updateDoc`/`moveDoc` are spied to return null ONCE (the
// exact symptom of a vanish-mid-write race), for the single call each handler makes for its own
// write — every other operation in these tests (createDoc, getDoc, deleteDoc, the "third party"
// write, casUpdateContent under the hood) hits the real database.
describe('undo refuses instead of force-writing when the row vanished mid-write (Finding 1 regression)', () => {
  it('edit_document: does not force-write prior content over a third party\'s write', async () => {
    const doc = await createDoc({ path: uniquePath('vanish-edit-doc'), content: 'original' })
    try {
      const spy = vi.spyOn(documentsService, 'updateDoc').mockResolvedValueOnce(null)
      const exec = await tool('edit_document').handler(
        { id: doc.id, old_string: 'original', new_string: 'edited' }, ctx)
      spy.mockRestore()

      // The edit itself reports not_found — its own write never landed.
      expect((exec.result as { ok?: boolean, error?: string }).error).toBe('not_found')

      // A third party subsequently writes real content at the same id.
      await updateDoc(doc.id, { content: 'a third party wrote this' })

      const res = await exec.undo!()
      expect(res).toMatchObject({ ok: false })
      expect((await getDoc(doc.id))!.content).toBe('a third party wrote this')
    } finally {
      await deleteDoc(doc.id)
    }
  })

  it('edit_section: does not force-write prior content over a third party\'s write', async () => {
    const doc = await createDoc({ path: uniquePath('vanish-edit-section'), content: '# T\n\noriginal' })
    try {
      const spy = vi.spyOn(documentsService, 'updateDoc').mockResolvedValueOnce(null)
      const exec = await tool('edit_section').handler(
        { id: doc.id, mode: 'append', text: 'more' }, ctx)
      spy.mockRestore()

      expect((exec.result as { ok?: boolean, error?: string }).error).toBe('not_found')

      await updateDoc(doc.id, { content: 'a third party wrote this' })

      const res = await exec.undo!()
      expect(res).toMatchObject({ ok: false })
      expect((await getDoc(doc.id))!.content).toBe('a third party wrote this')
    } finally {
      await deleteDoc(doc.id)
    }
  })

  it('update_document: does not force-write prior content over a third party\'s write', async () => {
    const doc = await createDoc({ path: uniquePath('vanish-update-doc'), content: 'original' })
    try {
      const spy = vi.spyOn(documentsService, 'updateDoc').mockResolvedValueOnce(null)
      const exec = await tool('update_document').handler({ id: doc.id, content: 'edited' }, ctx)
      spy.mockRestore()

      expect((exec.result as { ok?: boolean, error?: string }).error).toBe('not_found')

      await updateDoc(doc.id, { content: 'a third party wrote this' })

      const res = await exec.undo!()
      expect(res).toMatchObject({ ok: false })
      expect((await getDoc(doc.id))!.content).toBe('a third party wrote this')
    } finally {
      await deleteDoc(doc.id)
    }
  })

  it('move_document: does not force-move back over a document someone else already moved again', async () => {
    const doc = await createDoc({ path: uniquePath('vanish-move-doc'), content: 'x' })
    const target = uniquePath('vanish-move-target')
    try {
      const spy = vi.spyOn(documentsService, 'moveDoc').mockResolvedValueOnce(null)
      const exec = await tool('move_document').handler({ id: doc.id, path: target }, ctx)
      spy.mockRestore()

      expect((exec.result as { ok?: boolean, error?: string }).error).toBe('not_found')

      const thirdPartyPath = uniquePath('vanish-move-third-party')
      await updateDoc(doc.id, { path: thirdPartyPath })

      const res = await exec.undo!()
      expect(res).toMatchObject({ ok: false })
      expect((await getDoc(doc.id))!.path).toBe(thirdPartyPath)
    } finally {
      await deleteDoc(doc.id)
    }
  })
})

describe('update_document undo CAS guard', () => {
  it('refuses to undo when the document changed after the update, and does not touch metadata either', async () => {
    const doc = await createDoc({ path: uniquePath('update-doc-refuse'), content: 'original', title: 'Original Title' })
    try {
      const exec = await tool('update_document').handler(
        { id: doc.id, content: 'edited', title: 'Edited Title' }, ctx)

      await updateDoc(doc.id, { content: 'a third party wrote this' })

      const res = await exec.undo!()
      expect(res).toMatchObject({ ok: false })
      const after = await getDoc(doc.id)
      expect(after!.content).toBe('a third party wrote this')
      // The whole undo refused — metadata must not have been partially reverted either.
      expect(after!.title).toBe('Edited Title')
    } finally {
      await deleteDoc(doc.id)
    }
  })

  it('undoes cleanly (content + metadata) when nothing else touched the document', async () => {
    const doc = await createDoc({ path: uniquePath('update-doc-clean'), content: 'original', title: 'Original Title' })
    try {
      const exec = await tool('update_document').handler(
        { id: doc.id, content: 'edited', title: 'Edited Title' }, ctx)

      expect(await exec.undo!()).toMatchObject({ ok: true })
      const after = await getDoc(doc.id)
      expect(after!.content).toBe('original')
      expect(after!.title).toBe('Original Title')
    } finally {
      await deleteDoc(doc.id)
    }
  })
})

describe('move_document undo guard (read-then-compare)', () => {
  it('refuses to undo when the document was moved again since', async () => {
    const doc = await createDoc({ path: uniquePath('move-doc-refuse'), content: 'x' })
    try {
      const target = uniquePath('move-doc-target')
      const exec = await tool('move_document').handler({ id: doc.id, path: target }, ctx)

      const movedAgain = uniquePath('move-doc-moved-again')
      await updateDoc(doc.id, { path: movedAgain })

      const res = await exec.undo!()
      expect(res).toMatchObject({ ok: false })
      expect((await getDoc(doc.id))!.path).toBe(movedAgain)
    } finally {
      await deleteDoc(doc.id)
    }
  })

  it('undoes cleanly when nothing else moved the document', async () => {
    const original = uniquePath('move-doc-clean-original')
    const doc = await createDoc({ path: original, content: 'x' })
    try {
      const target = uniquePath('move-doc-clean-target')
      const exec = await tool('move_document').handler({ id: doc.id, path: target }, ctx)

      expect(await exec.undo!()).toMatchObject({ ok: true })
      expect((await getDoc(doc.id))!.path).toBe(original)
    } finally {
      await deleteDoc(doc.id)
    }
  })
})
