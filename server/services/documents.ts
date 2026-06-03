import { and, eq, isNull, ilike, or, sql } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { nanoid } from 'nanoid'
import { useDb } from '../db'
import { documents } from '../db/schema'
import { getLanguageFromPath } from '../../shared/utils/languages'
import { buildTree, type TreeNode } from './tree'
import type { DocumentDTO, DocumentUpsert } from '../../shared/types/documents'

const live = () => isNull(documents.deletedAt)
const toDTO = (r: typeof documents.$inferSelect): DocumentDTO => ({
  id: r.id, path: r.path, title: r.title, content: r.content, language: r.language,
  frontmatter: r.frontmatter as Record<string, unknown>, project: r.project, domain: r.domain,
  type: r.type, tags: r.tags, topic: r.topic, isPublic: r.isPublic, publicSlug: r.publicSlug,
  updatedAt: r.updatedAt.toISOString()
})

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
  const rows = await useDb().insert(documents).values({
    path: input.path, title: input.title ?? input.path.split('/').pop() ?? null,
    content: input.content ?? '', language: getLanguageFromPath(input.path),
    frontmatter: (input.frontmatter ?? {}) as unknown as string,
    project: input.project, domain: input.domain,
    type: input.type, tags: input.tags ?? [], topic: input.topic,
    contentHash: createHash('sha256').update(input.content ?? '').digest('hex')
  }).returning()
  return toDTO(rows[0]!)
}

export async function updateDoc(id: string, input: Partial<DocumentUpsert>): Promise<DocumentDTO | null> {
  const patch: Record<string, unknown> = { updatedAt: new Date() }
  for (const k of ['title', 'content', 'frontmatter', 'project', 'domain', 'type', 'tags', 'topic', 'path'] as const) {
    if (input[k] !== undefined) patch[k] = input[k]
  }
  if (input.path !== undefined) patch.language = getLanguageFromPath(input.path)
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

export async function searchDocs(q: string): Promise<DocumentDTO[]> {
  const rows = await useDb().select().from(documents)
    .where(and(live(), or(ilike(documents.title, `%${q}%`), ilike(documents.content, `%${q}%`))))
    .orderBy(sql`similarity(coalesce(${documents.title},'') || ' ' || ${documents.content}, ${q}) desc`)
    .limit(50)
  return rows.map(toDTO)
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
