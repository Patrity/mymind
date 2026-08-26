import { and, eq, isNull, or, sql, TransactionRollbackError, type SQL } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'
import { useDb } from '../db'
import { documents, folders } from '../db/schema'
import { resolveDocProjectFromPath } from './documents'
import { getLanguageFromPath } from '../../shared/utils/languages'
import type { FolderDTO } from '../../shared/types/folders'

type Db = ReturnType<typeof useDb>

/**
 * The folder path itself plus every ancestor, root-first.
 * '/projects/mymind/wiki' → ['/projects', '/projects/mymind', '/projects/mymind/wiki']
 * '/' or '' → [] — the root is never a folder row.
 *
 * Pure. `split('/').filter(Boolean)` collapses duplicate and trailing slashes before the
 * chain is built, so a malformed input (`//projects//mymind/`) still yields clean, valid
 * paths — which matters now that `folders_path_format_check` (Task 3) makes a bad path a
 * hard DB failure instead of bad data.
 */
export function folderChainPaths(folderPath: string): string[] {
  const parts = folderPath.split('/').filter(Boolean)
  const out: string[] = []
  for (let i = 0; i < parts.length; i++) {
    out.push('/' + parts.slice(0, i + 1).join('/'))
  }
  return out
}

/**
 * Every ancestor folder path of a DOCUMENT path, root-first, filename dropped.
 * '/projects/mymind/wiki/auth.md' → ['/projects', '/projects/mymind', '/projects/mymind/wiki']
 *
 * A document's ancestors are exactly the chain of its parent folder, so this drops the
 * filename and defers to folderChainPaths. Pure. The root is deliberately absent — it is not
 * a folder row.
 */
export function ancestorFolderPaths(docPath: string): string[] {
  const parts = docPath.split('/').filter(Boolean)
  parts.pop() // the filename
  return folderChainPaths('/' + parts.join('/'))
}

/**
 * Record every folder a document path implies.
 *
 * Called from createDoc/updateDoc — the SERVICE, not the HTTP route — because that is the
 * only choke point every writer shares: the documents UI, MCP (save_document, sync_document,
 * move_document, edit_document), capture triage's /input sweep, and ShareX transcriptions all
 * funnel through those two functions. Hooking a route would silently miss most of them.
 *
 * Idempotent: conflicts on the unique path index are ignored.
 */
export async function ensureFolders(docPath: string, tx: Db = useDb()): Promise<void> {
  const paths = ancestorFolderPaths(docPath)
  if (!paths.length) return
  await tx.insert(folders).values(paths.map(path => ({ path }))).onConflictDoNothing()
}

// ---------------------------------------------------------------------------
// Folder operations: create, rename/move, delete, impact
// ---------------------------------------------------------------------------

const toFolderDTO = (r: { id: string, path: string, color: string | null }): FolderDTO =>
  ({ id: r.id, path: r.path, color: r.color })

/**
 * Why a folder operation refused, in the vocabulary the HTTP boundary needs.
 *
 * `reason` maps straight onto a status code — 'not-found' → 404, 'invalid' → 400,
 * 'collision' → 409. Without it the three collapse into one free-text `conflict` string and a
 * route has to pattern-match sentinel prose, which is how an endpoint quietly starts answering
 * 409 to a request for a folder that does not exist.
 *
 * `conflict` carries the colliding PATH for 'collision' — the thing the user has to rename, and
 * the whole reason the pre-flight check exists instead of letting a unique index name a
 * constraint — and a human-readable explanation for the other two.
 */
export interface FolderOpFailure {
  ok: false
  reason: 'not-found' | 'invalid' | 'collision'
  conflict: string
}

const notFound = (id: string): FolderOpFailure =>
  ({ ok: false, reason: 'not-found', conflict: `no folder with id ${id}` })
const invalid = (why: string): FolderOpFailure =>
  ({ ok: false, reason: 'invalid', conflict: why })
const collides = (path: string): FolderOpFailure =>
  ({ ok: false, reason: 'collision', conflict: path })

/**
 * Is `path` strictly inside `folderPath`?
 *
 * The separator is part of the comparison on purpose: a bare startsWith() would treat
 * '/archive/x.md' as living under '/arch', and a folder rename would then rewrite every
 * sibling whose name merely begins with the same letters. Pure.
 */
export function isUnder(path: string, folderPath: string): boolean {
  return path.startsWith(folderPath + '/')
}

/** Replace a leading folder prefix. Returns `path` unchanged when it isn't under `from`. Pure. */
export function rewritePrefix(path: string, from: string, to: string): string {
  if (path === from) return to
  if (!isUnder(path, from)) return path
  return to + path.slice(from.length)
}

/**
 * Escape a string so SQL LIKE matches it literally.
 *
 * This is not defence against injection (parameters handle that) — it is defence against
 * WILDCARDS THAT OCCUR NATURALLY IN PATHS. `_` matches any single character in LIKE, and `_`
 * is ordinary in real document paths ('/projects/my_project', '/input/screen_shot.md'). An
 * unescaped prefix pattern therefore reaches rows OUTSIDE the folder being operated on:
 * `path LIKE '/a_b/%'` also matches '/axb/one.md'. For deleteFolder that is a soft delete of
 * documents that were never in the folder; for moveFolder it sweeps unrelated rows into the
 * batch it reports as moved. `%` and the escape character itself are escaped for the same reason.
 *
 * One pass over a single character class, so the backslash the replacement inserts is never
 * re-scanned and the order the three characters are handled in cannot matter. (A chain of three
 * separate `replace` calls WOULD have that hazard — do not refactor it into one.)
 * Pure; every prefix predicate in this service goes through it.
 */
export function escapeLikeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, ch => '\\' + ch)
}

/**
 * `column LIKE '<folderPath>/%'` — every row STRICTLY under `folderPath` and nothing else.
 *
 * The escape character is spelled `E'\\'` rather than `'\'` deliberately: the latter is a
 * one-character backslash only while `standard_conforming_strings` is on (the default), and an
 * UNTERMINATED string literal — a syntax error, not a wrong result — if it is ever off. The
 * `E''` form means exactly one backslash under either setting. It is stated explicitly rather
 * than left implicit because the pattern comes from escapeLikeLiteral and the two have to be
 * read together.
 */
function underPath(column: PgColumn, folderPath: string): SQL {
  return sql`${column} like ${escapeLikeLiteral(folderPath) + '/%'} escape E'\\\\'`
}

/**
 * The directory a path sits in — the cache key for project resolution below, which depends
 * only on a leading `/projects/<slug>/` prefix and so is constant within a directory.
 */
const parentDirOf = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/'

/**
 * Resolve destination projects for a batch of paths, reading `projects` once per directory.
 *
 * `resolveDocProjectFromPath` derives the project from the `/projects/<slug>/` prefix, so every
 * path sharing a parent directory resolves identically — and a folder move usually lands
 * everything under one or two directories. Not keyed on "the whole move has one project":
 * moving a folder to exactly `/projects` puts each child under a different slug.
 *
 * Reads through `useDb()`'s pool, so when called from inside a transaction it borrows a SECOND
 * connection for the duration. That is safe here (it only reads `projects`, which no folder
 * operation writes) and the alternative — threading `tx` through the documents service — would
 * fork `resolveDocProjectFromPath`, the one function that owns the path→project invariant.
 */
async function resolveProjectsByDir(paths: string[]) {
  const byDir = new Map<string, { projectId: string | null, project: string | null }>()
  for (const path of paths) {
    const dir = parentDirOf(path)
    if (!byDir.has(dir)) byDir.set(dir, await resolveDocProjectFromPath(path))
  }
  return byDir
}

async function getFolder(id: string) {
  const [row] = await useDb().select().from(folders).where(eq(folders.id, id)).limit(1)
  return row ?? null
}

/**
 * Create a folder, materializing its ancestors too — creating /a/b/c implies /a and /a/b exist.
 *
 * Idempotent: an existing folder is returned rather than being an error, so a racing second
 * caller gets the same row instead of a unique-index failure. The path is canonicalized by
 * `folderChainPaths` (duplicate and trailing slashes collapsed) so nothing malformed can reach
 * `folders_path_format_check`.
 *
 * Bad input is RETURNED, never thrown, so a route handles one failure shape across create,
 * move and delete instead of a throw here and a result there.
 */
export async function createFolder(
  path: string
): Promise<{ ok: true, folder: FolderDTO } | FolderOpFailure> {
  const db = useDb()
  const chain = folderChainPaths(path)
  const canonical = chain.at(-1)
  if (!canonical) return invalid('the root is not a folder')
  await db.insert(folders).values(chain.map(p => ({ path: p }))).onConflictDoNothing()
  const [row] = await db.select().from(folders).where(eq(folders.path, canonical)).limit(1)
  // Unreachable: the insert above either created this row or found it already present. Still a
  // throw rather than a failure result — it would mean the row vanished mid-call, which is a
  // bug in this service, not a caller error, and no status code is the right answer to it.
  if (!row) throw new Error(`folder ${canonical} was not found immediately after being created`)
  return { ok: true, folder: toFolderDTO(row) }
}

/** Set or clear (`null` = inherit from the parent / owning project) a folder's colour. */
export async function setFolderColor(id: string, color: string | null): Promise<FolderDTO | null> {
  const [row] = await useDb().update(folders)
    .set({ color, updatedAt: new Date() })
    .where(eq(folders.id, id)).returning()
  return row ? toFolderDTO(row) : null
}

/**
 * Rename or move a folder — the same operation; a rename is a move within the same parent.
 *
 * EVERY statement, read included, runs on `tx`. Selecting the rewrite set on the pool and then
 * writing in a transaction is not atomic end to end: a document created under `fromPath`
 * between the SELECT and the COMMIT is absent from the batch, so its folder row is renamed away
 * and the document is left stranded at the old prefix — exactly the "documents pointing at a
 * folder that no longer exists" the transaction is here to prevent. (A concurrent writer that
 * commits after our snapshot can still strand a row; closing that needs SERIALIZABLE, which
 * buys nothing while the other writers are READ COMMITTED. Documented, not claimed as closed.)
 *
 * Documents are re-associated to their new project as they move: `documents.path` is the source
 * of truth for project membership (cycle 26), so a folder crossing a /projects/<slug>/ boundary
 * genuinely changes who owns its contents. The UI warns about this first (that is what
 * `folderImpact` is for); the service performs it without further ceremony.
 *
 * Collisions are detected before the first write and reported as the conflicting PATH. Letting
 * `documents_path_live_uidx` (or `folders_path_uidx`) reject the write instead would abort with
 * an error naming a constraint, which tells the person deciding what to rename nothing at all.
 * The pre-check is an affordance, not a lock: a writer racing us between the check and the
 * commit still loses to the unique index, which stays the backstop.
 */
export async function moveFolder(
  id: string,
  toPath: string
): Promise<{ ok: true, moved: number } | FolderOpFailure> {
  const db = useDb()

  // Canonicalize the destination before anything touches the database — the CHECK constraint
  // rejects a trailing or doubled slash and a raw caller path is not guaranteed to be clean.
  const destChain = folderChainPaths(toPath)
  const dest = destChain.at(-1)
  if (!dest) return invalid('the root is not a folder')

  // The outcome is carried out in a variable rather than returned from the callback because
  // every early exit leaves via tx.rollback(), which throws instead of returning.
  let outcome: { ok: true, moved: number } | FolderOpFailure = notFound(id)
  try {
    await db.transaction(async (tx) => {
      const [folder] = await tx.select().from(folders).where(eq(folders.id, id)).limit(1)
      if (!folder) {
        outcome = notFound(id)
        return tx.rollback()
      }
      const fromPath = folder.path
      if (dest === fromPath) {
        outcome = { ok: true, moved: 0 }
        return tx.rollback()
      }
      // Moving /a to /a/b would make the folder its own ancestor: the descendant rewrite would
      // include the destination it is being rewritten into, and the tree would stop being a tree.
      if (isUnder(dest, fromPath)) {
        outcome = invalid('cannot move a folder into itself')
        return tx.rollback()
      }

      const docs = await tx.select({ id: documents.id, path: documents.path })
        .from(documents)
        .where(and(isNull(documents.deletedAt), underPath(documents.path, fromPath)))
      const docMoves = docs.map(d => ({ id: d.id, newPath: rewritePrefix(d.path, fromPath, dest) }))

      const takenDocs = await tx.select({ path: documents.path }).from(documents)
        .where(and(isNull(documents.deletedAt), underPath(documents.path, dest)))
      const takenDocPaths = new Set(takenDocs.map(r => r.path))
      const docCollision = docMoves.find(m => takenDocPaths.has(m.newPath))
      if (docCollision) {
        outcome = collides(docCollision.newPath)
        return tx.rollback()
      }

      // The folder rows that move with it. `folders_path_uidx` is unique too, so a destination
      // folder that already exists is a conflict rather than a silent merge — merging two
      // folders would quietly combine their colours behind the user's back.
      const subFolders = await tx.select({ id: folders.id, path: folders.path }).from(folders)
        .where(underPath(folders.path, fromPath))
      const folderDests = [dest, ...subFolders.map(f => rewritePrefix(f.path, fromPath, dest))]
      const takenFolders = await tx.select({ path: folders.path }).from(folders)
        .where(or(eq(folders.path, dest), underPath(folders.path, dest)))
      const takenFolderPaths = new Set(takenFolders.map(r => r.path))
      const folderCollision = folderDests.find(p => takenFolderPaths.has(p))
      if (folderCollision) {
        outcome = collides(folderCollision)
        return tx.rollback()
      }

      const projectByDir = await resolveProjectsByDir(docMoves.map(m => m.newPath))

      // ---- nothing above this line writes; nothing below it may refuse ----

      // The destination's ancestors, so the moved folder is reachable in the tree. The chain's
      // last entry is `dest` itself and is dropped: the row being renamed below IS `dest`, and
      // inserting it here would collide with folders_path_uidx.
      const ancestors = destChain.slice(0, -1)
      if (ancestors.length) {
        await tx.insert(folders).values(ancestors.map(p => ({ path: p }))).onConflictDoNothing()
      }

      for (const m of docMoves) {
        const assoc = projectByDir.get(parentDirOf(m.newPath))!
        await tx.update(documents).set({
          path: m.newPath,
          project: assoc.project,
          projectId: assoc.projectId,
          // A prefix rewrite never touches the basename, so today this re-derives the same
          // value. Written anyway so `language` stays a function of `path` here exactly as it
          // is in createDoc/updateDoc — the one place a future path-sensitive rule would need it.
          language: getLanguageFromPath(m.newPath),
          updatedAt: new Date()
        }).where(eq(documents.id, m.id))
      }

      // Descendant folder rows are rewritten with the SAME pure function as the documents rather
      // than with SQL string surgery — one rewrite implementation, unit-tested, and immune to
      // the JS-code-unit vs Postgres-character mismatch a substring() offset would have.
      for (const sub of subFolders) {
        await tx.update(folders)
          .set({ path: rewritePrefix(sub.path, fromPath, dest), updatedAt: new Date() })
          .where(eq(folders.id, sub.id))
      }
      await tx.update(folders).set({ path: dest, updatedAt: new Date() }).where(eq(folders.id, id))

      outcome = { ok: true, moved: docMoves.length }
    })
  } catch (err) {
    // tx.rollback() signals a refusal by throwing, and `outcome` already holds it. ANY other
    // error is a real database failure — a unique-index violation from a writer that raced the
    // pre-check, a constraint, a dropped connection — and must not be swallowed: the whole
    // batch has been rolled back and the caller has to hear about it.
    if (!(err instanceof TransactionRollbackError)) throw err
  }
  return outcome
}

/**
 * Recursive delete: descendant documents are soft-deleted (`deleted_at`, so they are
 * restorable), folder rows are removed outright — they are metadata, not content.
 *
 * The lookup runs on `tx` alongside the mutations for the same reason moveFolder's does: a
 * document created under the folder between the read and the commit would otherwise survive a
 * delete that reported it gone.
 *
 * `foldersDeleted` counts the rows actually REMOVED, which includes the folder itself — it is
 * deliberately NOT the same number as `folderImpact().foldersInside`, and the names differ so
 * the two cannot be wired to one label by accident. `foldersDeleted === 0` is the unambiguous
 * "no such folder" signal: an existing but empty folder still deletes its own row and reports 1.
 */
export async function deleteFolder(
  id: string
): Promise<{ documents: number, foldersDeleted: number }> {
  return useDb().transaction(async (tx) => {
    const [folder] = await tx.select().from(folders).where(eq(folders.id, id)).limit(1)
    // A plain return, not tx.rollback(): no statement has written anything, so committing this
    // read-only transaction and rolling it back are the same thing — and unlike moveFolder
    // there is no failure payload that would have to be smuggled past a throw.
    if (!folder) return { documents: 0, foldersDeleted: 0 }

    const docs = await tx.update(documents)
      .set({ deletedAt: new Date() })
      .where(and(isNull(documents.deletedAt), underPath(documents.path, folder.path)))
      .returning({ id: documents.id })
    const subs = await tx.delete(folders)
      .where(underPath(folders.path, folder.path))
      .returning({ id: folders.id })
    // Counted from RETURNING rather than assumed to be one, so a folder deleted out from
    // under us between the lookup and here is reported as the zero rows it actually removed.
    const self = await tx.delete(folders).where(eq(folders.id, id)).returning({ id: folders.id })
    return { documents: docs.length, foldersDeleted: subs.length + self.length }
  })
}

/**
 * What a delete would destroy, or what a move would re-associate. Powers both confirm dialogs —
 * the numbers a user is asked to approve come from the same predicates the operations
 * themselves use, so they cannot drift apart.
 *
 * `foldersInside` is what the folder CONTAINS. deleteFolder reports `foldersDeleted`, which also
 * counts the folder itself; the names differ because the two numbers differ by one and this one
 * is displayed to a user immediately before an irreversible bulk soft-delete.
 *
 * `projectChanges` is empty unless `toPath` is given, and lists only the documents whose owning
 * project actually changes. Read-only — this never mutates.
 */
export async function folderImpact(id: string, toPath?: string): Promise<{
  documents: number
  foldersInside: number
  projectChanges: { from: string | null, to: string | null, count: number }[]
}> {
  const db = useDb()
  const folder = await getFolder(id)
  if (!folder) return { documents: 0, foldersInside: 0, projectChanges: [] }

  const docs = await db.select({ path: documents.path, project: documents.project })
    .from(documents)
    .where(and(isNull(documents.deletedAt), underPath(documents.path, folder.path)))
  const subs = await db.select({ id: folders.id }).from(folders)
    .where(underPath(folders.path, folder.path))

  const projectChanges: { from: string | null, to: string | null, count: number }[] = []
  const dest = toPath ? folderChainPaths(toPath).at(-1) : undefined
  if (dest) {
    const destinations = docs.map(d => rewritePrefix(d.path, folder.path, dest))
    const projectByDir = await resolveProjectsByDir(destinations)
    const counts = new Map<string, { from: string | null, to: string | null, count: number }>()
    docs.forEach((doc, i) => {
      const to = projectByDir.get(parentDirOf(destinations[i]!))!.project
      if (to === doc.project) return
      // JSON, not interpolation: a null project and a project literally slugged 'null'
      // must not collapse into the same bucket.
      const key = JSON.stringify([doc.project, to])
      const entry = counts.get(key) ?? { from: doc.project, to, count: 0 }
      entry.count++
      counts.set(key, entry)
    })
    projectChanges.push(...counts.values())
  }

  return { documents: docs.length, foldersInside: subs.length, projectChanges }
}
