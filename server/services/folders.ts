import { and, eq, isNull, or, sql, type SQL } from 'drizzle-orm'
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
 * The backslash must be escaped FIRST or the replacement's own backslashes get re-escaped.
 * Pure; every prefix predicate in this service goes through it.
 */
export function escapeLikeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, ch => '\\' + ch)
}

/**
 * `column LIKE '<folderPath>/%'` — every row STRICTLY under `folderPath` and nothing else.
 *
 * The ESCAPE clause is explicit rather than relying on the default so the pattern built by
 * escapeLikeLiteral is interpreted the way it was written, whatever the session's settings.
 */
function underPath(column: PgColumn, folderPath: string): SQL {
  return sql`${column} like ${escapeLikeLiteral(folderPath) + '/%'} escape '\\'`
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
 * everything under one or two directories.
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
 */
export async function createFolder(path: string): Promise<FolderDTO> {
  const db = useDb()
  const chain = folderChainPaths(path)
  const canonical = chain.at(-1)
  if (!canonical) throw new Error('the root is not a folder and cannot be created')
  await db.insert(folders).values(chain.map(p => ({ path: p }))).onConflictDoNothing()
  const [row] = await db.select().from(folders).where(eq(folders.path, canonical)).limit(1)
  if (!row) throw new Error(`folder ${canonical} was not found immediately after being created`)
  return toFolderDTO(row)
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
 * Everything happens in ONE transaction because a partial rewrite leaves documents pointing at
 * a folder that no longer exists. Documents are re-associated to their new project as they
 * move: `documents.path` is the source of truth for project membership (cycle 26), so a folder
 * crossing a /projects/<slug>/ boundary genuinely changes who owns its contents. The UI warns
 * about this before calling (that is what `folderImpact` is for); the service performs it
 * without further ceremony.
 *
 * Collisions are detected BEFORE the write and reported as the conflicting path. Letting
 * `documents_path_live_uidx` (or `folders_path_uidx`) reject the write instead would abort the
 * transaction with an error naming a constraint, which tells the person deciding what to
 * rename nothing at all. The pre-check is an affordance, not a lock: a writer racing us
 * between the check and the commit still loses to the unique index, which stays the backstop.
 */
export async function moveFolder(
  id: string,
  toPath: string
): Promise<{ ok: true, moved: number } | { ok: false, conflict: string }> {
  const db = useDb()
  const folder = await getFolder(id)
  if (!folder) return { ok: false, conflict: 'folder not found' }
  const fromPath = folder.path

  // Canonicalize the destination exactly as createFolder does — the CHECK constraint rejects a
  // trailing or doubled slash, and a raw caller path is not guaranteed to be clean.
  const destChain = folderChainPaths(toPath)
  const dest = destChain.at(-1)
  if (!dest) return { ok: false, conflict: 'the root is not a folder' }
  if (dest === fromPath) return { ok: true, moved: 0 }
  // Moving /a to /a/b would make the folder its own ancestor: the descendant rewrite would
  // include the destination it is being rewritten into, and the tree would no longer be a tree.
  if (isUnder(dest, fromPath)) return { ok: false, conflict: 'cannot move a folder into itself' }

  const docs = await db.select({ id: documents.id, path: documents.path })
    .from(documents)
    .where(and(isNull(documents.deletedAt), underPath(documents.path, fromPath)))
  const docMoves = docs.map(d => ({ id: d.id, newPath: rewritePrefix(d.path, fromPath, dest) }))

  const takenDocs = await db.select({ path: documents.path }).from(documents)
    .where(and(isNull(documents.deletedAt), underPath(documents.path, dest)))
  const takenDocPaths = new Set(takenDocs.map(r => r.path))
  const docCollision = docMoves.find(m => takenDocPaths.has(m.newPath))
  if (docCollision) return { ok: false, conflict: docCollision.newPath }

  // The folder rows that move with it. `folders_path_uidx` is unique too, so a destination
  // folder that already exists is a conflict rather than a silent merge — merging two folders
  // would quietly combine their colours and is not something to do behind the user's back.
  const subFolders = await db.select({ id: folders.id, path: folders.path }).from(folders)
    .where(underPath(folders.path, fromPath))
  const folderDests = [dest, ...subFolders.map(f => rewritePrefix(f.path, fromPath, dest))]
  const takenFolders = await db.select({ path: folders.path }).from(folders)
    .where(or(eq(folders.path, dest), underPath(folders.path, dest)))
  const takenFolderPaths = new Set(takenFolders.map(r => r.path))
  const folderCollision = folderDests.find(p => takenFolderPaths.has(p))
  if (folderCollision) return { ok: false, conflict: folderCollision }

  // Resolved before the transaction opens: resolveDocProjectFromPath reads through its own
  // pooled connection, so calling it inside `tx` would read outside the transaction anyway —
  // and it keeps the write transaction to writes alone.
  const projectByDir = await resolveProjectsByDir(docMoves.map(m => m.newPath))

  await db.transaction(async (tx) => {
    // The destination's ancestors, so the moved folder is reachable in the tree. The chain's
    // last entry is `dest` itself and is dropped: the row being renamed below IS `dest`, and
    // inserting it here would collide with folders_path_uidx.
    const ancestors = destChain.slice(0, -1)
    if (ancestors.length) {
      await tx.insert(folders).values(ancestors.map(path => ({ path }))).onConflictDoNothing()
    }

    for (const m of docMoves) {
      const assoc = projectByDir.get(parentDirOf(m.newPath))!
      await tx.update(documents).set({
        path: m.newPath,
        project: assoc.project,
        projectId: assoc.projectId,
        // A prefix rewrite never touches the basename, so today this re-derives the same
        // value. Written anyway so `language` stays a function of `path` here exactly as it is
        // in createDoc/updateDoc — the one place a future path-sensitive rule would need it.
        language: getLanguageFromPath(m.newPath),
        updatedAt: new Date()
      }).where(eq(documents.id, m.id))
    }

    // Descendant folder rows are rewritten with the SAME pure function as the documents rather
    // than with SQL string surgery — one rewrite implementation, unit-tested, and immune to the
    // JS-code-unit vs Postgres-character mismatch a substring() offset would have.
    for (const sub of subFolders) {
      await tx.update(folders)
        .set({ path: rewritePrefix(sub.path, fromPath, dest), updatedAt: new Date() })
        .where(eq(folders.id, sub.id))
    }
    await tx.update(folders).set({ path: dest, updatedAt: new Date() }).where(eq(folders.id, id))
  })

  return { ok: true, moved: docMoves.length }
}

/**
 * Recursive delete: descendant documents are soft-deleted (`deleted_at`, so they are
 * restorable), folder rows are removed outright — they are metadata, not content.
 *
 * `folders` in the result counts the rows actually REMOVED, which includes the folder itself;
 * `folderImpact().folders` counts only what is inside it. The two differ by one on purpose.
 */
export async function deleteFolder(id: string): Promise<{ documents: number, folders: number }> {
  const db = useDb()
  const folder = await getFolder(id)
  if (!folder) return { documents: 0, folders: 0 }

  return db.transaction(async (tx) => {
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
    return { documents: docs.length, folders: subs.length + self.length }
  })
}

/**
 * What a delete would destroy, or what a move would re-associate. Powers both confirm dialogs —
 * the numbers a user is asked to approve come from the same predicates the operations
 * themselves use, so they cannot drift apart.
 *
 * `folders` is the count of folders INSIDE this one (see deleteFolder, whose count includes the
 * folder itself). `projectChanges` is empty unless `toPath` is given, and lists only the
 * documents whose owning project actually changes.
 */
export async function folderImpact(id: string, toPath?: string): Promise<{
  documents: number
  folders: number
  projectChanges: { from: string | null, to: string | null, count: number }[]
}> {
  const db = useDb()
  const folder = await getFolder(id)
  if (!folder) return { documents: 0, folders: 0, projectChanges: [] }

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

  return { documents: docs.length, folders: subs.length, projectChanges }
}
