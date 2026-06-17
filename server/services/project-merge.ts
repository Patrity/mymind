import { eq, or, and, isNull } from 'drizzle-orm'
import { useDb } from '../db'
import { projects, sessions, memories, tasks, documents } from '../db/schema'
import { rewriteProjectPathPrefix } from '../lib/projects/doc-path'
import { getProject } from './projects'
import type { ProjectDTO } from '../../shared/types/tasks'

/**
 * uniquifyPath: If target not in taken, return unchanged; else insert -2/-3/… before extension.
 * Split on last `/` for dir+name; split name on last `.` for base+ext.
 * Try `${dir}/${base}-${n}${ext ? '.'+ext : ''}` for n=2,3,… until not in taken.
 */
export function uniquifyPath(target: string, taken: Set<string>): string {
  if (!taken.has(target)) {
    return target
  }

  // Split on last `/` to get dir and name
  const lastSlashIdx = target.lastIndexOf('/')
  const dir = lastSlashIdx === -1 ? '' : target.slice(0, lastSlashIdx)
  const name = lastSlashIdx === -1 ? target : target.slice(lastSlashIdx + 1)

  // Split name on last `.` to get base and ext
  const lastDotIdx = name.lastIndexOf('.')
  const base = lastDotIdx === -1 ? name : name.slice(0, lastDotIdx)
  const ext = lastDotIdx === -1 ? '' : name.slice(lastDotIdx)

  // Try base-2, base-3, ... until we find one not in taken
  for (let n = 2; n < 10000; n++) {
    const candidate = dir
      ? `${dir}/${base}-${n}${ext}`
      : `${base}-${n}${ext}`

    if (!taken.has(candidate)) {
      return candidate
    }
  }

  // Fallback (should never reach if logic is correct)
  return target
}

/**
 * mergeStringArrays: Concat + dedupe, preserving a's order first then new items from b.
 * Empty inputs → [].
 */
export function mergeStringArrays(a: string[], b: string[]): string[] {
  const seen = new Set<string>(a)
  const result: string[] = [...a]

  for (const item of b) {
    if (!seen.has(item)) {
      seen.add(item)
      result.push(item)
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Pure helper — exposed for unit tests; no DB, no side effects.
// ---------------------------------------------------------------------------

export interface DocRepoint {
  id: string
  path: string
}

/**
 * computeDocTargetPaths: Given loser docs, the full set of already-taken live
 * paths (across ALL projects, not just winner), the loser slug, and winner slug,
 * returns a map of doc id → new path. Paths not under /projects/<loserSlug>/
 * are moved to winner ownership but their path is unchanged (unless collision).
 *
 * The caller is responsible for:
 *   - seeding `taken` with ALL live doc paths before calling.
 *   - mutating `taken` (delete old, add new) if iterating incrementally —
 *     this function does NOT mutate taken (pure).
 */
export function computeDocTargetPaths(
  loserDocs: DocRepoint[],
  taken: ReadonlySet<string>,
  loserSlug: string,
  winnerSlug: string
): Map<string, string> {
  const result = new Map<string, string>()
  const mutableTaken = new Set(taken)

  for (const doc of loserDocs) {
    const rewritten = rewriteProjectPathPrefix(doc.path, loserSlug, winnerSlug)
    // Free the old path so a doc doesn't collide with its own former path.
    mutableTaken.delete(doc.path)
    const newPath = uniquifyPath(rewritten, mutableTaken)
    mutableTaken.add(newPath)
    result.set(doc.id, newPath)
  }

  return result
}

// ---------------------------------------------------------------------------
// mergeProjects — transactional core
// ---------------------------------------------------------------------------

/**
 * Merge `loserSlug` into `winnerSlug`:
 *  - Repoints sessions, memories, tasks, documents from loser → winner.
 *  - Absorbs loser's slug, aliases, localPaths, gitRemoteKey into winner.
 *  - Hard-deletes the loser project row.
 *
 * Sentinel errors (mapped to HTTP codes by the endpoint):
 *  - MERGE_NOT_FOUND  — either slug doesn't exist.
 *  - MERGE_SELF       — loser and winner are the same project.
 *  - MERGE_UNCATEGORIZED — either slug is 'uncategorized'.
 *
 * Emits are NOT done here — the Task-4 endpoint is responsible for
 * publishChange calls after this function returns, to keep emits in one place.
 */
export async function mergeProjects(
  loserSlug: string,
  winnerSlug: string
): Promise<{ winner: ProjectDTO; repointedMemoryIds: string[] }> {
  const db = useDb()

  const repointedMemoryIds = await db.transaction(async (tx) => {
    // -----------------------------------------------------------------------
    // 1. Load L + W rows; guard sentinels
    // -----------------------------------------------------------------------
    const [L] = await tx.select().from(projects).where(eq(projects.slug, loserSlug)).limit(1)
    const [W] = await tx.select().from(projects).where(eq(projects.slug, winnerSlug)).limit(1)

    if (!L || !W) throw new Error('MERGE_NOT_FOUND')
    if (L.id === W.id) throw new Error('MERGE_SELF')
    if (loserSlug === 'uncategorized' || winnerSlug === 'uncategorized') {
      throw new Error('MERGE_UNCATEGORIZED')
    }

    // -----------------------------------------------------------------------
    // 2. Capture repointedMemoryIds (non-archived memories that will move)
    // -----------------------------------------------------------------------
    const memRows = await tx
      .select({ id: memories.id })
      .from(memories)
      .where(
        and(
          or(eq(memories.projectId, L.id), eq(memories.project, L.slug)),
          isNull(memories.archivedAt)
        )
      )
    const ids = memRows.map((r) => r.id)

    // -----------------------------------------------------------------------
    // 3. Bulk repoints
    // -----------------------------------------------------------------------
    await tx
      .update(sessions)
      .set({ projectId: W.id, project: W.slug })
      .where(or(eq(sessions.projectId, L.id), eq(sessions.project, L.slug)))

    await tx
      .update(memories)
      .set({ projectId: W.id, project: W.slug })
      .where(or(eq(memories.projectId, L.id), eq(memories.project, L.slug)))

    // tasks has NO projectId column — slug-only match
    await tx
      .update(tasks)
      .set({ project: W.slug })
      .where(eq(tasks.project, L.slug))

    // -----------------------------------------------------------------------
    // 4. Documents — row-by-row (path collisions possible)
    // -----------------------------------------------------------------------
    const loserDocs = await tx
      .select()
      .from(documents)
      .where(
        and(
          or(eq(documents.projectId, L.id), eq(documents.project, L.slug)),
          isNull(documents.deletedAt)
        )
      )

    // Pre-load ALL live paths so we can detect cross-project collisions.
    const allLivePaths = await tx
      .select({ path: documents.path })
      .from(documents)
      .where(isNull(documents.deletedAt))

    const taken = new Set(allLivePaths.map((r) => r.path))

    for (const doc of loserDocs) {
      const rewritten = rewriteProjectPathPrefix(doc.path, L.slug, W.slug)
      // Free the old path before uniquifying so the doc can't collide with itself.
      taken.delete(doc.path)
      const newPath = uniquifyPath(rewritten, taken)
      taken.add(newPath)

      await tx
        .update(documents)
        .set({ projectId: W.id, project: W.slug, path: newPath, updatedAt: new Date() })
        .where(eq(documents.id, doc.id))
    }

    // -----------------------------------------------------------------------
    // 5. Absorb identity into W
    // -----------------------------------------------------------------------
    const absorbedAliases = mergeStringArrays(W.aliases ?? [], [
      L.slug,
      ...(L.aliases ?? []),
      ...(L.gitRemoteKey && !W.gitRemoteKey ? [L.gitRemoteKey] : [])
    ])
    const absorbedLocalPaths = mergeStringArrays(W.localPaths ?? [], L.localPaths ?? [])

    // lastActivityAt: take the later of W/L (handle nulls)
    let lastActivityAt: Date | null
    if (W.lastActivityAt && L.lastActivityAt) {
      lastActivityAt = W.lastActivityAt > L.lastActivityAt ? W.lastActivityAt : L.lastActivityAt
    } else {
      lastActivityAt = W.lastActivityAt ?? L.lastActivityAt ?? null
    }

    await tx
      .update(projects)
      .set({
        aliases: absorbedAliases,
        localPaths: absorbedLocalPaths,
        lastActivityAt,
        updatedAt: new Date()
      })
      .where(eq(projects.id, W.id))

    // -----------------------------------------------------------------------
    // 6. Hard-delete L
    // -----------------------------------------------------------------------
    await tx.delete(projects).where(eq(projects.id, L.id))

    return ids
  })

  // After the transaction commits, re-fetch winner via getProject for full DTO + counts.
  const winner = await getProject(winnerSlug)

  return { winner: winner!, repointedMemoryIds }
}
