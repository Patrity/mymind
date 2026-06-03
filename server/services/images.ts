import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { Readable } from 'node:stream'
import { nanoid } from 'nanoid'
import { useDb } from '../db'
import { images } from '../db/schema'
import { storage } from '../utils/storage'
import { processUpload } from '../lib/images/convert'

export type Image = typeof images.$inferSelect

const live = () => isNull(images.deletedAt)

/** Public images are served via `/api/i/<slug>`; private via `/api/images/<id>/raw`. */
export function serveUrl(row: Image): string {
  if (row.isPublic && row.publicSlug) return `/api/i/${row.publicSlug}`
  return `/api/images/${row.id}/raw`
}

export async function createImage(buffer: Buffer, mime: string, originalName?: string): Promise<Image> {
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
    isPublic: false
  }).returning()

  return row!
}

export async function listImages(): Promise<(Image & { url: string })[]> {
  const rows = await useDb().select().from(images).where(live()).orderBy(desc(images.createdAt))
  return rows.map(r => ({ ...r, url: serveUrl(r) }))
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

export async function patchTags(
  id: string,
  patch: { tags?: string[], recommendedTags?: string[] }
): Promise<Image | null> {
  const update: Partial<typeof images.$inferInsert> = {}
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
