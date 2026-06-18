import { and, desc, eq, isNull, ilike, or, sql, inArray } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { nanoid } from 'nanoid'
import { useDb } from '../db'
import { documents, chunks } from '../db/schema'
import { getLanguageFromPath } from '../../shared/utils/languages'
import { buildTree, type TreeNode } from './tree'
import type { DocumentDTO, DocumentUpsert, ChunkHit } from '../../shared/types/documents'
import { collapseChunksToSources } from '../lib/chunking/collapse'
import { embedOne } from '../lib/ai/embeddings'
import { rrfFuse } from '../lib/ai/rrf'
import { projectFromPath, PROJECTS_ROOT } from '../lib/projects/doc-path'
import { matchProjectByLabel } from './projects'

// ---------------------------------------------------------------------------
// Path↔project association helpers
// ---------------------------------------------------------------------------

/**
 * Returns the canonical target path for filing a doc under a given project.
 * e.g. targetPathForAssign('/input/foo.md', 'mymind') → '/projects/mymind/foo.md'
 * Pure — no DB, always safe to call.
 */
export function targetPathForAssign(currentPath: string, slug: string): string {
  const basename = currentPath.split('/').filter(Boolean).pop() ?? currentPath
  return `${PROJECTS_ROOT}/${slug}/${basename}`
}

/**
 * Given an input path and an optional project slug from the caller, compute the
 * FINAL path that should be stored. Precedence rules:
 *   1. If project slug is given (non-null) AND the path is NOT already under
 *      /projects/<slug>/, relocate the doc: finalPath = targetPathForAssign(path, slug).
 *   2. Otherwise keep path as-is (path wins; project=null never moves anything).
 * Pure — no DB.
 */
export function computeFinalPath(path: string, project: string | null | undefined): string {
  if (!project) return path
  // Check if already under /projects/<slug>/
  const alreadyFiled = path.startsWith(`${PROJECTS_ROOT}/${project}/`)
  if (alreadyFiled) return path
  return targetPathForAssign(path, project)
}

/**
 * Derives the project_id + project slug from a path. The path is the single
 * source of truth — if the path is under /projects/<seg>/ and a matching
 * project row exists, both fields are set. Otherwise both are null.
 */
export async function resolveDocProjectFromPath(
  path: string
): Promise<{ projectId: string | null; project: string | null }> {
  const seg = projectFromPath(path)
  if (!seg) return { projectId: null, project: null }
  const row = await matchProjectByLabel(seg)
  if (!row) return { projectId: null, project: null }
  return { projectId: row.id, project: row.slug }
}

const live = () => isNull(documents.deletedAt)
const toDTO = (r: typeof documents.$inferSelect): DocumentDTO => ({
  id: r.id, path: r.path, title: r.title, content: r.content, language: r.language,
  frontmatter: r.frontmatter as Record<string, unknown>, project: r.project, domain: r.domain,
  type: r.type, tags: r.tags, topic: r.topic, isPublic: r.isPublic, publicSlug: r.publicSlug,
  ocrId: r.ocrId,
  updatedAt: r.updatedAt.toISOString()
})

export async function listDocs(opts: { project?: string } = {}): Promise<DocumentDTO[]> {
  const rows = await useDb()
    .select()
    .from(documents)
    .where(and(live(), opts.project ? eq(documents.project, opts.project) : undefined))
    .orderBy(desc(documents.updatedAt))
    .limit(200)
  return rows.map(toDTO)
}

export async function listTree(): Promise<TreeNode[]> {
  const rows = await useDb().select({ id: documents.id, path: documents.path, title: documents.title })
    .from(documents).where(live())
  return buildTree(rows)
}

export async function getDoc(id: string): Promise<DocumentDTO | null> {
  const [r] = await useDb().select().from(documents).where(and(eq(documents.id, id), live())).limit(1)
  return r ? toDTO(r) : null
}

export async function createDoc(input: DocumentUpsert): Promise<DocumentDTO> {
  // Compute the final path applying assign-project relocate logic, then derive
  // project_id + project slug from that path. The path always wins.
  const finalPath = computeFinalPath(input.path, input.project)
  const { projectId, project } = await resolveDocProjectFromPath(finalPath)
  const rows = await useDb().insert(documents).values({
    path: finalPath,
    title: input.title ?? finalPath.split('/').filter(Boolean).pop() ?? null,
    content: input.content ?? '', language: getLanguageFromPath(finalPath),
    frontmatter: (input.frontmatter ?? {}) as unknown as string,
    project, projectId, domain: input.domain,
    type: input.type, tags: input.tags ?? [], topic: input.topic,
    contentHash: createHash('sha256').update(input.content ?? '').digest('hex')
  }).returning()
  return toDTO(rows[0]!)
}

export async function updateDoc(id: string, input: Partial<DocumentUpsert>): Promise<DocumentDTO | null> {
  const patch: Record<string, unknown> = { updatedAt: new Date() }

  // Apply association logic only when path or project is part of the input.
  const pathOrProjectChanged = input.path !== undefined || input.project !== undefined
  if (pathOrProjectChanged) {
    // We need the current path to compute the final path when only project changes.
    // Fetch the existing row (lightweight — id + path only).
    const [existing] = await useDb()
      .select({ path: documents.path })
      .from(documents)
      .where(and(eq(documents.id, id), live()))
      .limit(1)
    if (!existing) return null // doc not found / soft-deleted

    const basePath = input.path ?? existing.path
    const finalPath = computeFinalPath(basePath, input.project)
    const { projectId, project } = await resolveDocProjectFromPath(finalPath)

    patch.path = finalPath
    patch.project = project
    patch.projectId = projectId
    patch.language = getLanguageFromPath(finalPath)
    // Sync title to basename on path change unless caller explicitly set one
    if (input.title === undefined) patch.title = finalPath.split('/').filter(Boolean).pop() ?? null
  }

  // Copy remaining scalar fields (title override honoured when explicitly set)
  for (const k of ['title', 'content', 'frontmatter', 'domain', 'type', 'tags', 'topic'] as const) {
    if (input[k] !== undefined) patch[k] = input[k]
  }
  if (input.content !== undefined) patch.contentHash = createHash('sha256').update(input.content).digest('hex')

  const [r] = await useDb().update(documents).set(patch as Partial<typeof documents.$inferInsert>).where(and(eq(documents.id, id), live())).returning()
  return r ? toDTO(r) : null
}

export async function moveDoc(id: string, newPath: string) { return updateDoc(id, { path: newPath }) }

export async function deleteDoc(id: string): Promise<boolean> {
  const [r] = await useDb().update(documents).set({ deletedAt: new Date() })
    .where(and(eq(documents.id, id), live())).returning({ id: documents.id })
  return !!r
}

export async function searchDocs(q: string, opts: { project?: string } = {}): Promise<DocumentDTO[]> {
  if (!q.trim()) return []

  const db = useDb()
  // Optional project scoping — filters both lanes by the denormalized project slug.
  const projectFilter = opts.project ? eq(documents.project, opts.project) : undefined

  // Lane 1: trigram — ILIKE filter + similarity ordering
  const trigramRows = await db.select({ id: documents.id }).from(documents)
    .where(and(live(), projectFilter, or(ilike(documents.title, `%${q}%`), ilike(documents.content, `%${q}%`))))
    .orderBy(sql`similarity(coalesce(${documents.title},'') || ' ' || ${documents.content}, ${q}) desc`)
    .limit(50)
  const trigramIds = trigramRows.map(r => r.id)

  // Lane 2: vector — cosine distance via HNSW index, with fallback if rig is unavailable
  let vectorIds: string[] = []
  try {
    const qv = await embedOne(q)
    const lit = `[${qv.join(',')}]`
    const chunkRows = await db.select({ sourceId: chunks.sourceId })
      .from(chunks)
      .innerJoin(documents, eq(chunks.sourceId, documents.id))
      .where(and(eq(chunks.sourceType, 'document'), live(), projectFilter))
      .orderBy(sql`${chunks.embedding} <=> ${lit}::halfvec`)
      .limit(100)
    vectorIds = collapseChunksToSources(chunkRows).slice(0, 50)
  } catch (err) {
    console.warn('[searchDocs] vector lane failed, falling back to trigram-only:', err)
  }

  // Fuse the two ranked lanes with RRF
  const fusedIds = rrfFuse([trigramIds, vectorIds]).slice(0, 50)

  if (fusedIds.length === 0) return []

  // Hydrate full rows and re-order by fused rank (inArray doesn't preserve order)
  const fetched = await db.select().from(documents)
    .where(and(live(), inArray(documents.id, fusedIds)))
  const byId = new Map(fetched.map(r => [r.id, r]))
  return fusedIds.flatMap(id => {
    const r = byId.get(id)
    return r ? [toDTO(r)] : []
  })
}

export async function setPublic(id: string, isPublic: boolean): Promise<DocumentDTO | null> {
  const slug = isPublic ? nanoid(12) : null
  const [r] = await useDb().update(documents)
    .set({ isPublic, publicSlug: isPublic ? sql`coalesce(${documents.publicSlug}, ${slug})` : null, updatedAt: new Date() })
    .where(and(eq(documents.id, id), live())).returning()
  return r ? toDTO(r) : null
}

export async function getByPublicSlug(slug: string): Promise<DocumentDTO | null> {
  const [r] = await useDb().select().from(documents)
    .where(and(eq(documents.publicSlug, slug), eq(documents.isPublic, true), live())).limit(1)
  return r ? toDTO(r) : null
}

export async function searchPassages(q: string, opts: { project?: string, limit?: number } = {}): Promise<ChunkHit[]> {
  if (!q.trim()) return []
  const db = useDb()
  const projectFilter = opts.project ? eq(documents.project, opts.project) : undefined
  const qv = await embedOne(q)
  const lit = `[${qv.join(',')}]`
  const rows = await db.select({
    sourceType: chunks.sourceType, sourceId: chunks.sourceId, ord: chunks.ord,
    content: chunks.content, headingPath: chunks.headingPath, context: chunks.context,
    docTitle: documents.title, docPath: documents.path,
    distance: sql<number>`${chunks.embedding} <=> ${lit}::halfvec`
  })
    .from(chunks)
    .innerJoin(documents, eq(chunks.sourceId, documents.id))
    .where(and(eq(chunks.sourceType, 'document'), live(), projectFilter))
    .orderBy(sql`${chunks.embedding} <=> ${lit}::halfvec`)
    .limit(opts.limit ?? 10)
  return rows as ChunkHit[]
}
