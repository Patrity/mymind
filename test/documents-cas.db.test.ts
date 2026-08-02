// test/documents-cas.db.test.ts
//
// DB-backed test — see test/documents-content-hash.db.test.ts for the harness pattern this
// file follows (`.env` load + `useRuntimeConfig` stub so `useDb()` works outside Nuxt).
//
// This runs against the developer's real local Postgres. `documents_path_live_uidx` is a
// unique index on live paths, so a fixture left behind by a failed assertion breaks every
// later run with a confusing duplicate-key 23505 instead of the real failure (this bit
// Task 1's DB test). Every fixture below therefore gets a unique path and is cleaned up in a
// try/finally so cleanup runs even when an assertion throws.
process.loadEnvFile('.env')
import { describe, it, expect, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { createDoc, casUpdateContent, findDocByPath, deleteDoc } from '../server/services/documents'
import { hashBody } from '../server/lib/agent/sync'

const uniquePath = (tag: string) => `/input/cas-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.md`

describe('casUpdateContent', () => {
  it('writes when the expected hash matches and refuses when it does not', async () => {
    const doc = await createDoc({ path: uniquePath('write'), content: 'v1' })
    try {
      expect(doc.contentHash).toBe(hashBody('v1'))

      const ok = await casUpdateContent(doc.id, 'v2', hashBody('v1'))
      expect(ok?.contentHash).toBe(hashBody('v2'))

      // Stale expectation — the row moved on, so this must lose.
      const stale = await casUpdateContent(doc.id, 'v3', hashBody('v1'))
      expect(stale).toBeNull()

      // The losing write must not have changed anything.
      const still = await findDocByPath(doc.path)
      expect(still?.contentHash).toBe(hashBody('v2'))

      // expected = null is the forced path and always wins.
      const forced = await casUpdateContent(doc.id, 'v4', null)
      expect(forced?.contentHash).toBe(hashBody('v4'))
    } finally {
      await deleteDoc(doc.id)
    }
  })

  it('will not resurrect a soft-deleted document', async () => {
    const doc = await createDoc({ path: uniquePath('del'), content: 'v1' })
    await deleteDoc(doc.id)
    try {
      expect(await casUpdateContent(doc.id, 'v2', hashBody('v1'))).toBeNull()
    } finally {
      // Already soft-deleted (deleteDoc is idempotent-safe: a second call is a harmless no-op).
      await deleteDoc(doc.id)
    }
  })
})

describe('findDocByPath', () => {
  it('finds a live document and ignores a deleted one', async () => {
    const path = uniquePath('find')
    const doc = await createDoc({ path, content: 'body' })
    try {
      expect((await findDocByPath(path))?.id).toBe(doc.id)
      await deleteDoc(doc.id)
      expect(await findDocByPath(path)).toBeNull()
    } finally {
      await deleteDoc(doc.id)
    }
  })
})
