import { and, arrayOverlaps, desc, eq, ilike, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'
import { Readable } from 'node:stream'
import { nanoid } from 'nanoid'
import { useDb } from '../db'
import { images, chunks } from '../db/schema'
import { storage } from '../utils/storage'
import { processUpload } from '../lib/images/convert'
import { embedOne } from '../lib/ai/embeddings'
import { rrfFuse } from '../lib/ai/rrf'
import { collapseChunksToSources } from '../lib/chunking/collapse'
import type { ImageDTO } from '../../shared/types/images'

export type Image = typeof images.$inferSelect

const live = () => isNull(images.deletedAt)

/** Public images are served via `/api/i/<slug>`; private via `/api/images/<id>/raw`. */
export function serveUrl(row: Image): string {
  if (row.isPublic && row.publicSlug) return `/api/i/${row.publicSlug}`
  return `/api/images/${row.id}/raw`
}

/**
 * Map a DB image row to the client-facing `ImageDTO`, OMITTING the server-only
 * `embedding` halfvec (it must never serialize to the client) and adding `url`.
 */
export function toImageDTO(row: Image): ImageDTO {
  const { embedding: _embedding, createdAt, deletedAt, ...rest } = row
  return {
    ...rest,
    createdAt: createdAt instanceof Date ? createdAt.toISOString() : createdAt,
    deletedAt: deletedAt instanceof Date ? deletedAt.toISOString() : deletedAt,
    url: serveUrl(row)
  }
}

export async function createImage(
  buffer: Buffer,
  mime: string,
  originalName?: string,
  opts?: { makeDocument?: boolean }
): Promise<Image> {
  const processed = await processUpload(buffer, mime, originalName)
  const stream = Readable.from(processed.buffer)
  const { key, size } = await storage().put(stream, { contentType: processed.mime })

  const [row] = await useDb().insert(images).values({
    storageKey: key,
    originalName: originalName ?? null,
    mime: processed.mime,
    ext: processed.ext,
    kind: processed.kind,
    width: processed.width ?? null,
    height: processed.height ?? null,
    size,
    isPublic: false,
    makeDocument: opts?.makeDocument ?? false
  }).returning()

  return row!
}

export interface ListImagesParams {
  q?: string
  tags?: string[]
}

export async function listImages(params: ListImagesParams = {}): Promise<ImageDTO[]> {
  const conditions = [live()]

  if (params.q?.trim()) {
    const term = `%${params.q.trim()}%`
    conditions.push(
      or(
        ilike(images.ocrText, term),
        sql`exists (select 1 from unnest(${images.tags}) as t where t ilike ${term})`,
        sql`exists (select 1 from unnest(${images.recommendedTags}) as t where t ilike ${term})`
      )!
    )
  }

  if (params.tags && params.tags.length > 0) {
    conditions.push(arrayOverlaps(images.tags, params.tags))
  }

  const rows = await useDb()
    .select()
    .from(images)
    .where(and(...conditions))
    .orderBy(desc(images.createdAt))
    .limit(500)

  return rows.map(toImageDTO)
}

export async function searchImages(q: string): Promise<(Image & { url: string })[]> {
  if (!q.trim()) return []

  const db = useDb()
  const pattern = `%${q}%`

  // Lane 1: lexical — ocr/summary ILIKE + tag overlap, similarity-ordered
  const lexRows = await db.select({ id: images.id }).from(images)
    .where(and(live(), or(
      ilike(images.ocrText, pattern),
      ilike(images.summary, pattern),
      sql`${images.tags} && ARRAY[${q}]::text[]`,
      sql`${images.recommendedTags} && ARRAY[${q}]::text[]`
    )))
    .orderBy(sql`similarity(coalesce(${images.summary},'') || ' ' || coalesce(${images.ocrText},''), ${q}) desc`)
    .limit(50)
  const lexIds = lexRows.map(r => r.id)

  // Lane 2: vector — cosine distance over the summary embedding, with fallback if rig is unavailable
  // Lane 3 (OCR chunks) reuses the same query embedding so we never embed twice.
  let vecIds: string[] = []
  let ocrIds: string[] = []
  try {
    const qv = await embedOne(q)
    const lit = `[${qv.join(',')}]`
    const vecRows = await db.select({ id: images.id }).from(images)
      .where(and(live(), isNotNull(images.embedding)))
      .orderBy(sql`${images.embedding} <=> ${lit}::halfvec`)
      .limit(50)
    vecIds = vecRows.map(r => r.id)

    // Lane 3: OCR chunks — distance over per-chunk embeddings, collapsed back to image ids
    const chunkRows = await db.select({ sourceId: chunks.sourceId })
      .from(chunks)
      .innerJoin(images, eq(chunks.sourceId, images.id))
      .where(and(eq(chunks.sourceType, 'image'), live()))
      .orderBy(sql`${chunks.embedding} <=> ${lit}::halfvec`)
      .limit(100)
    ocrIds = collapseChunksToSources(chunkRows).slice(0, 50)
  } catch (err) {
    console.warn('[searchImages] vector lane failed, falling back to lexical-only:', err)
  }

  // Fuse the ranked lanes with RRF (lexical + summary-vector + OCR-chunk)
  const fusedIds = rrfFuse([lexIds, vecIds, ocrIds]).slice(0, 50)

  if (fusedIds.length === 0) return []

  // Hydrate full rows and re-order by fused rank (inArray doesn't preserve order)
  const fetched = await db.select().from(images)
    .where(and(live(), inArray(images.id, fusedIds)))
  const byId = new Map(fetched.map(r => [r.id, r]))
  return fusedIds.flatMap(id => {
    const r = byId.get(id)
    return r ? [{ ...r, url: serveUrl(r) }] : []
  })
}

export async function getImage(id: string): Promise<Image | null> {
  const [r] = await useDb().select().from(images).where(and(eq(images.id, id), live())).limit(1)
  return r ?? null
}

export async function getByPublicSlug(slug: string): Promise<Image | null> {
  const [r] = await useDb().select().from(images)
    .where(and(eq(images.publicSlug, slug), eq(images.isPublic, true), live())).limit(1)
  return r ?? null
}

export async function setImagePublic(id: string, isPublic: boolean): Promise<Image | null> {
  const slug = isPublic ? nanoid(12) : null
  const [r] = await useDb().update(images)
    .set({
      isPublic,
      publicSlug: isPublic
        ? sql`coalesce(${images.publicSlug}, ${slug})`
        : null
    })
    .where(and(eq(images.id, id), live())).returning()
  return r ?? null
}

export interface ImagePatch {
  summary?: string | null
  ocrText?: string | null
  tags?: string[]
  recommendedTags?: string[]
}

/**
 * Update any provided subset of editable metadata columns. The public toggle is
 * handled separately by `setImagePublic` (it owns slug generation).
 */
export async function patchImage(id: string, patch: ImagePatch): Promise<Image | null> {
  const update: Partial<typeof images.$inferInsert> = {}
  if (patch.summary !== undefined) update.summary = patch.summary
  if (patch.ocrText !== undefined) update.ocrText = patch.ocrText
  if (patch.tags !== undefined) update.tags = patch.tags
  if (patch.recommendedTags !== undefined) update.recommendedTags = patch.recommendedTags
  if (Object.keys(update).length === 0) {
    return getImage(id)
  }
  const [r] = await useDb().update(images).set(update)
    .where(and(eq(images.id, id), live())).returning()
  return r ?? null
}

export async function deleteImage(id: string): Promise<boolean> {
  // Soft-delete only; leave blob in storage (dedup means others may share the key)
  const [r] = await useDb().update(images).set({ deletedAt: new Date() })
    .where(and(eq(images.id, id), live())).returning({ id: images.id })
  return !!r
}
