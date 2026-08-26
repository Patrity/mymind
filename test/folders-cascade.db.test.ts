// test/folders-cascade.db.test.ts
//
// The cascading move is the one operation in this cycle that can do real damage: it rewrites
// N document paths, and because documents.path determines project membership (cycle 26), a
// move across a /projects/<slug>/ boundary re-associates everything inside it. deleteFolder is
// worse still — it soft-deletes by path prefix. These tests pin both against a real database.
//
// Fixtures are scoped to a per-RUN unique root. `documents_path_live_uidx` is unique on live
// paths, so a fixed prefix left behind by a crashed run surfaces on the next run as a
// duplicate-key 23505 instead of the real failure (this bit test/documents-cas.db.test.ts).
process.loadEnvFile('.env')
import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest'
import { sql } from 'drizzle-orm'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

const { useDb } = await import('../server/db')
const { createDoc, getDoc } = await import('../server/services/documents')
const { createFolder, moveFolder, deleteFolder, setFolderColor, folderImpact } =
  await import('../server/services/folders')

const TAG = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
const ROOT = `/zz-cascade-${TAG}`
// A real project row, so the project re-association below is exercised end to end rather than
// asserted against a slug that resolves to nothing.
const PROJECT_SLUG = `zz-cascade-${TAG}`
const PROJECT_ROOT = `/projects/${PROJECT_SLUG}`
// Well-formed but absent — `eq(folders.id, …)` would raise a pg type error on a non-uuid.
const MISSING_ID = '00000000-0000-0000-0000-000000000000'

// '/projects' is a shared folder row that almost certainly predates this file; only remove it
// if moving a fixture into a project is what brought it into existence.
let createdProjectsRoot = false

beforeAll(async () => {
  const rows = await useDb().execute<{ path: string }>(
    sql`select path from folders where path = '/projects'`
  )
  createdProjectsRoot = rows.rows.length === 0
})

afterEach(async () => {
  const db = useDb()
  for (const prefix of [ROOT, PROJECT_ROOT]) {
    await db.execute(sql`delete from chunks where source_id in (select id from documents where path like ${prefix + '%'})`)
    await db.execute(sql`delete from documents where path like ${prefix + '%'}`)
    await db.execute(sql`delete from folders where path like ${prefix + '%'}`)
  }
  await db.execute(sql`delete from projects where slug = ${PROJECT_SLUG}`)
})

afterAll(async () => {
  if (createdProjectsRoot) await useDb().execute(sql`delete from folders where path = '/projects'`)
})

// useDb().execute() hands back the raw pg QueryResult, not an iterable of rows — the rows live
// on `.rows` (same access as server/services/usage.ts).
async function folderId(path: string): Promise<string> {
  const rows = await useDb().execute<{ id: string }>(sql`select id from folders where path = ${path}`)
  const id = rows.rows[0]?.id
  if (!id) throw new Error(`expected a folder row at ${path}`)
  return id
}

async function folderPaths(prefix: string): Promise<string[]> {
  const rows = await useDb().execute<{ path: string }>(
    sql`select path from folders where path like ${prefix + '%'} order by path`
  )
  return rows.rows.map(r => r.path)
}

/** createFolder for fixtures: unwraps the result so a refusal fails loudly at the setup line. */
async function makeFolder(path: string) {
  const res = await createFolder(path)
  if (!res.ok) throw new Error(`createFolder(${path}) refused: ${res.reason} — ${res.conflict}`)
  return res.folder
}

async function makeProject(): Promise<void> {
  await useDb().execute(
    sql`insert into projects (slug, name) values (${PROJECT_SLUG}, ${PROJECT_SLUG})`
  )
}

describe('createFolder', () => {
  it('materializes the folder and every ancestor, and is idempotent', async () => {
    const folder = await makeFolder(`${ROOT}/a/b`)
    expect(folder.path).toBe(`${ROOT}/a/b`)
    expect(await folderPaths(ROOT)).toEqual([ROOT, `${ROOT}/a`, `${ROOT}/a/b`])

    const again = await makeFolder(`${ROOT}/a/b`)
    expect(again.id).toBe(folder.id)
    expect(await folderPaths(ROOT)).toEqual([ROOT, `${ROOT}/a`, `${ROOT}/a/b`])
  })

  it('canonicalizes a path the folders CHECK constraint would reject', async () => {
    expect((await makeFolder(`${ROOT}//a/b/`)).path).toBe(`${ROOT}/a/b`)
  })

  // Bad input comes back as a result, not a throw, so a route handles one shape across all
  // three mutating folder operations.
  it('refuses the root as a failure result rather than throwing', async () => {
    expect(await createFolder('/'))
      .toEqual({ ok: false, reason: 'invalid', conflict: 'the root is not a folder' })
  })
})

describe('setFolderColor', () => {
  it('sets and clears the colour, and reports a missing folder as null', async () => {
    const folder = await makeFolder(`${ROOT}/tinted`)
    expect((await setFolderColor(folder.id, '#3b82f6'))?.color).toBe('#3b82f6')
    expect((await setFolderColor(folder.id, null))?.color).toBeNull()
    expect(await setFolderColor(MISSING_ID, '#3b82f6')).toBeNull()
  })
})

describe('moveFolder', () => {
  it('rewrites every descendant document path', async () => {
    const a = await createDoc({ path: `${ROOT}/src/one.md` })
    const b = await createDoc({ path: `${ROOT}/src/deep/two.md` })

    const result = await moveFolder(await folderId(`${ROOT}/src`), `${ROOT}/dest`)

    expect(result).toEqual({ ok: true, moved: 2 })
    expect((await getDoc(a.id))?.path).toBe(`${ROOT}/dest/one.md`)
    expect((await getDoc(b.id))?.path).toBe(`${ROOT}/dest/deep/two.md`)
  })

  it('moves descendant folder rows, including empty ones', async () => {
    await makeFolder(`${ROOT}/src/empty`)

    await moveFolder(await folderId(`${ROOT}/src`), `${ROOT}/dest`)

    expect(await folderPaths(ROOT)).toEqual([ROOT, `${ROOT}/dest`, `${ROOT}/dest/empty`])
  })

  it('materializes the destination ancestors so the moved folder is reachable', async () => {
    await makeFolder(`${ROOT}/src`)

    expect(await moveFolder(await folderId(`${ROOT}/src`), `${ROOT}/x/y/src`))
      .toEqual({ ok: true, moved: 0 })
    expect(await folderPaths(ROOT))
      .toEqual([ROOT, `${ROOT}/x`, `${ROOT}/x/y`, `${ROOT}/x/y/src`])
  })

  it('treats a move onto its own current path as a no-op', async () => {
    const doc = await createDoc({ path: `${ROOT}/src/one.md` })

    expect(await moveFolder(await folderId(`${ROOT}/src`), `${ROOT}/src`))
      .toEqual({ ok: true, moved: 0 })
    expect((await getDoc(doc.id))?.path).toBe(`${ROOT}/src/one.md`)
  })

  // The refusals below must be distinguishable by `reason` alone — a route maps it to
  // 404 / 400 / 409 without pattern-matching the prose in `conflict`.
  it('reports a missing folder as not-found, not as a collision', async () => {
    expect(await moveFolder(MISSING_ID, `${ROOT}/dest`))
      .toEqual({ ok: false, reason: 'not-found', conflict: `no folder with id ${MISSING_ID}` })
  })

  it('refuses to move a folder into itself as invalid input', async () => {
    const folder = await makeFolder(`${ROOT}/self`)

    expect(await moveFolder(folder.id, `${ROOT}/self/inner`))
      .toEqual({ ok: false, reason: 'invalid', conflict: 'cannot move a folder into itself' })
  })

  it('refuses the root destination as invalid input', async () => {
    const folder = await makeFolder(`${ROOT}/self`)

    expect(await moveFolder(folder.id, '/'))
      .toEqual({ ok: false, reason: 'invalid', conflict: 'the root is not a folder' })
  })

  it('refuses when a destination document path is already taken, naming the file', async () => {
    await createDoc({ path: `${ROOT}/src/dup.md` })
    await createDoc({ path: `${ROOT}/dest/dup.md` })

    expect(await moveFolder(await folderId(`${ROOT}/src`), `${ROOT}/dest`))
      .toEqual({ ok: false, reason: 'collision', conflict: `${ROOT}/dest/dup.md` })
  })

  it('leaves everything untouched when it refuses', async () => {
    const doc = await createDoc({ path: `${ROOT}/src/dup.md` })
    await createDoc({ path: `${ROOT}/dest/dup.md` })

    await moveFolder(await folderId(`${ROOT}/src`), `${ROOT}/dest`)

    expect((await getDoc(doc.id))?.path).toBe(`${ROOT}/src/dup.md`)
    expect(await folderPaths(ROOT)).toContain(`${ROOT}/src`)
  })

  it('refuses when the destination folder already exists, naming it', async () => {
    await makeFolder(`${ROOT}/src`)
    await makeFolder(`${ROOT}/dest`)

    expect(await moveFolder(await folderId(`${ROOT}/src`), `${ROOT}/dest`))
      .toEqual({ ok: false, reason: 'collision', conflict: `${ROOT}/dest` })
  })

  it('re-associates moved documents with the project they land in', async () => {
    await makeProject()
    const doc = await createDoc({ path: `${ROOT}/movers/note.md` })
    expect(doc.project).toBeNull()

    expect(await moveFolder(await folderId(`${ROOT}/movers`), `${PROJECT_ROOT}/movers`))
      .toEqual({ ok: true, moved: 1 })

    const moved = await getDoc(doc.id)
    expect(moved?.path).toBe(`${PROJECT_ROOT}/movers/note.md`)
    expect(moved?.project).toBe(PROJECT_SLUG)
    // project_id follows the slug — the DTO does not carry it, so read the column directly.
    const rows = await useDb().execute<{ project_id: string | null }>(
      sql`select project_id from documents where id = ${doc.id}`
    )
    expect(rows.rows[0]?.project_id).not.toBeNull()
  })
})

// The refusal tests above all bail BEFORE the first write, so none of them proves the
// transaction rolls anything back — delete the `db.transaction` wrapper and they stay green.
// This one forces a failure in the middle of the write batch instead: a trigger that raises on
// the folder rename, which moveFolder issues AFTER it has already rewritten every document
// path. Without the transaction those document writes would be committed and irrecoverable.
describe('moveFolder rollback', () => {
  const TRIGGER = `zz_boom_${TAG}`

  it('rolls the document rewrites back when a later write in the batch fails', async () => {
    const db = useDb()
    const doc = await createDoc({ path: `${ROOT}/src/one.md` })
    await db.execute(sql.raw(
      `create function ${TRIGGER}() returns trigger language plpgsql as $$
       begin
         if new.path like '%/boom' then raise exception 'zz forced failure'; end if;
         return new;
       end $$`
    ))
    await db.execute(sql.raw(
      `create trigger ${TRIGGER} before update on folders for each row execute function ${TRIGGER}()`
    ))

    try {
      // A real database error, not a refusal — the catch around tx.rollback() must let it past.
      const failure: unknown = await moveFolder(await folderId(`${ROOT}/src`), `${ROOT}/boom`)
        .then(() => null, (e: unknown) => e)
      expect(failure).toBeInstanceOf(Error)
      // Drizzle wraps the pg error in a query error; the trigger's own message is on the cause.
      expect(String((failure as Error).cause)).toMatch(/zz forced failure/)

      expect((await getDoc(doc.id))?.path).toBe(`${ROOT}/src/one.md`)
      expect(await folderPaths(ROOT)).toEqual([ROOT, `${ROOT}/src`])
    } finally {
      await db.execute(sql.raw(`drop trigger if exists ${TRIGGER} on folders`))
      await db.execute(sql.raw(`drop function if exists ${TRIGGER}()`))
    }
  })
})

describe('deleteFolder', () => {
  it('soft-deletes descendants and reports the counts', async () => {
    const doc = await createDoc({ path: `${ROOT}/gone/one.md` })
    await makeFolder(`${ROOT}/gone/sub`)

    // `foldersDeleted: 2` is the folder itself plus its one sub-folder — rows actually removed.
    expect(await deleteFolder(await folderId(`${ROOT}/gone`)))
      .toEqual({ documents: 1, foldersDeleted: 2 })
    expect(await getDoc(doc.id)).toBeNull()
    expect(await folderPaths(`${ROOT}/gone`)).toEqual([])
  })

  it('reports a missing folder as zero rows deleted', async () => {
    expect(await deleteFolder(MISSING_ID)).toEqual({ documents: 0, foldersDeleted: 0 })
  })

  it('leaves a sibling folder and its documents alone', async () => {
    const keeper = await createDoc({ path: `${ROOT}/keep/one.md` })
    await createDoc({ path: `${ROOT}/gone/one.md` })

    await deleteFolder(await folderId(`${ROOT}/gone`))

    expect((await getDoc(keeper.id))?.path).toBe(`${ROOT}/keep/one.md`)
  })
})

describe('folderImpact', () => {
  it('counts documents and sub-folders for a delete', async () => {
    await createDoc({ path: `${ROOT}/count/one.md` })
    await createDoc({ path: `${ROOT}/count/sub/two.md` })

    // `foldersInside: 1` is what the folder CONTAINS — deleteFolder's `foldersDeleted` for the
    // same folder would be 2, which is why the two fields are not both called `folders`.
    expect(await folderImpact(await folderId(`${ROOT}/count`)))
      .toMatchObject({ documents: 2, foldersInside: 1, projectChanges: [] })
  })

  it('reports the project re-association a move would cause', async () => {
    await makeProject()
    await createDoc({ path: `${ROOT}/impact/one.md` })
    await createDoc({ path: `${ROOT}/impact/two.md` })

    expect(await folderImpact(await folderId(`${ROOT}/impact`), `${PROJECT_ROOT}/impact`))
      .toEqual({
        documents: 2,
        foldersInside: 0,
        projectChanges: [{ from: null, to: PROJECT_SLUG, count: 2 }]
      })
  })
})

// R2. `_` is a single-character wildcard in SQL LIKE and is ordinary in real paths. Without
// escapeLikeLiteral + `ESCAPE E'\'`, the prefix predicate '<root>/a_b/%' also matches
// '<root>/axb/...' — so these three operations reach documents that were never in the folder.
// Remove the escaping and every assertion below goes red.
describe('a folder name containing a LIKE wildcard', () => {
  const withUnderscore = () => `${ROOT}/a_b`
  const sibling = () => `${ROOT}/axb`

  it('does not let a delete soft-delete the sibling it would match unescaped', async () => {
    await createDoc({ path: `${withUnderscore()}/inside.md` })
    const outsider = await createDoc({ path: `${sibling()}/outside.md` })

    expect(await deleteFolder(await folderId(withUnderscore())))
      .toEqual({ documents: 1, foldersDeleted: 1 })

    expect((await getDoc(outsider.id))?.path).toBe(`${sibling()}/outside.md`)
    expect(await folderPaths(sibling())).toEqual([sibling()])
  })

  it('does not let a move rewrite the sibling it would match unescaped', async () => {
    await createDoc({ path: `${withUnderscore()}/inside.md` })
    const outsider = await createDoc({ path: `${sibling()}/deep/outside.md` })

    expect(await moveFolder(await folderId(withUnderscore()), `${ROOT}/dest`))
      .toEqual({ ok: true, moved: 1 })

    expect((await getDoc(outsider.id))?.path).toBe(`${sibling()}/deep/outside.md`)
    expect(await folderPaths(sibling())).toEqual([sibling(), `${sibling()}/deep`])
  })

  it('does not let an impact count the sibling it would match unescaped', async () => {
    await createDoc({ path: `${withUnderscore()}/inside.md` })
    await createDoc({ path: `${sibling()}/deep/outside.md` })

    expect(await folderImpact(await folderId(withUnderscore())))
      .toMatchObject({ documents: 1, foldersInside: 0 })
  })
})
