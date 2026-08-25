// test/folders-materialize.db.test.ts
//
// The materialization hook lives in the document SERVICE, not in a route, specifically so
// that MCP writers (save_document/sync_document/move_document) and the triage sweep are
// covered without touching them. This test exercises the service directly — the same entry
// point those writers use — because a route-level test would prove nothing about them.
process.loadEnvFile('.env')
import { describe, it, expect, afterEach } from 'vitest'
import { sql } from 'drizzle-orm'
import { vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

const { useDb } = await import('../server/db')
const { createDoc, moveDoc, deleteDoc } = await import('../server/services/documents')

const ROOT = '/zz-folders-probe'

afterEach(async () => {
  const db = useDb()
  await db.execute(sql`delete from chunks where source_id in (select id from documents where path like ${ROOT + '%'})`)
  await db.execute(sql`delete from documents where path like ${ROOT + '%'}`)
  await db.execute(sql`delete from folders where path like ${ROOT + '%'}`)
})

async function folderPaths(prefix: string): Promise<string[]> {
  const rows = await useDb().execute<{ path: string }>(
    sql`select path from folders where path like ${prefix + '%'} order by path`
  )
  // execute() returns the raw pg QueryResult (not a directly-iterable array) — see
  // server/services/usage.ts's identical `.rows` access for the established pattern here.
  return rows.rows.map(r => r.path)
}

describe('folder materialization', () => {
  it('creates a row for every ancestor when a document is created', async () => {
    await createDoc({ path: `${ROOT}/a/b/note.md` })
    expect(await folderPaths(ROOT)).toEqual([ROOT, `${ROOT}/a`, `${ROOT}/a/b`])
  })

  it('creates rows for the destination when a document moves', async () => {
    const doc = await createDoc({ path: `${ROOT}/a/note.md` })
    await moveDoc(doc.id, `${ROOT}/c/d/note.md`)
    expect(await folderPaths(ROOT)).toEqual([ROOT, `${ROOT}/a`, `${ROOT}/c`, `${ROOT}/c/d`])
  })

  it('keeps the folder row after the last document in it is deleted', async () => {
    const doc = await createDoc({ path: `${ROOT}/lonely/only.md` })
    await deleteDoc(doc.id)
    expect(await folderPaths(ROOT)).toContain(`${ROOT}/lonely`)
  })

  it('is idempotent — re-creating under the same folder does not duplicate rows', async () => {
    await createDoc({ path: `${ROOT}/a/one.md` })
    await createDoc({ path: `${ROOT}/a/two.md` })
    expect(await folderPaths(ROOT)).toEqual([ROOT, `${ROOT}/a`])
  })
})
