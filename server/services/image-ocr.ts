import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm'
import { useDb } from '../db'
import { images } from '../db/schema'
import { storage } from '../utils/storage'
import { describeImage } from '../lib/ai/vision'
import { capTags } from '../../shared/utils/cap-tags'
import { buildTagLibrary, splitTags } from './tag-library'

// Re-exported for back-compat: tests and other modules historically imported
// `splitTags` (and its result type) from this module.
export { splitTags } from './tag-library'
export type { SplitTagsResult } from './tag-library'

/** Max image size (bytes) to attempt OCR on — skip anything larger. */
const OCR_MAX_SIZE = 10 * 1024 * 1024 // 10 MB

// ---------------------------------------------------------------------------
// OCR runner
// ---------------------------------------------------------------------------

export interface OcrRunResult {
  ocred: number
  failed: number
  remaining: number
}

/** Read an image blob from storage and return a base64 data: URL for the vision model. */
async function readImageDataUrl(storageKey: string, mime: string): Promise<string> {
  const { stream } = await storage().get(storageKey)
  const chunks: Buffer[] = []
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk: Buffer) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    stream.on('end', resolve)
    stream.on('error', reject)
  })
  return `data:${mime};base64,${Buffer.concat(chunks).toString('base64')}`
}

/**
 * Process up to `limit` images that have no ocr_text yet.
 * Reads the blob, calls the vision model, writes ocr_text + recommended_tags.
 * Never sets `tags` — confirmation is manual.
 */
export async function runImageOcr({ limit = 20 }: { limit?: number } = {}): Promise<OcrRunResult> {
  const db = useDb()

  const [library, candidates] = await Promise.all([
    buildTagLibrary(),
    db
      .select({
        id: images.id,
        storageKey: images.storageKey,
        mime: images.mime,
        size: images.size
      })
      .from(images)
      .where(
        and(
          isNull(images.ocrText),
          isNull(images.deletedAt),
          // Only scan images and gifs — skip videos and unknown kinds
          inArray(images.kind, ['image', 'gif']),
          // Cap retries: stop selecting after 3 failed attempts
          lt(images.enrichAttempts, 3)
        )
      )
      .limit(limit)
  ])

  let ocred = 0
  let failed = 0

  for (const img of candidates) {
    // Skip oversized images — mark with empty sentinel so they aren't re-scanned every run
    if (img.size > OCR_MAX_SIZE) {
      console.log(`[image-ocr] skipping oversized image ${img.id} (${img.size} bytes)`)
      await db
        .update(images)
        .set({ ocrText: '' })
        .where(eq(images.id, img.id))
      continue
    }

    try {
      const dataUrl = await readImageDataUrl(img.storageKey, img.mime)

      const result = await describeImage(dataUrl)

      // Soft-failure: model returned nothing useful — increment attempts rather than marking done
      if (!result.ocrText && result.tags.length === 0) {
        console.warn(`[image-ocr] empty result for ${img.id}, incrementing attempts`)
        await db
          .update(images)
          .set({ enrichAttempts: sql`${images.enrichAttempts} + 1` })
          .where(eq(images.id, img.id))
        failed++
        continue
      }

      const { recommended } = splitTags(result.tags, library)
      const cappedRecommended = capTags(recommended, 10)

      await db
        .update(images)
        .set({
          // Empty string = "attempted, don't re-select" (ocrText IS NOT NULL)
          ocrText: result.ocrText || '',
          recommendedTags: cappedRecommended
        })
        .where(eq(images.id, img.id))

      console.log(`[image-ocr] processed ${img.id}: ocrText=${result.ocrText.slice(0, 60)}, recommended=${cappedRecommended.join(',')}`)
      ocred++
    } catch (err) {
      console.warn(`[image-ocr] failed to process image ${img.id}:`, err)
      await db
        .update(images)
        .set({ enrichAttempts: sql`${images.enrichAttempts} + 1` })
        .where(eq(images.id, img.id))
      failed++
    }
  }

  // Count remaining un-processed images (same filter as candidate query)
  const remainingRows = await db
    .select({ remaining: sql<number>`count(*)::int` })
    .from(images)
    .where(and(isNull(images.ocrText), isNull(images.deletedAt), inArray(images.kind, ['image', 'gif']), lt(images.enrichAttempts, 3)))

  const remaining = remainingRows[0]?.remaining ?? 0

  return { ocred, failed, remaining }
}

// ---------------------------------------------------------------------------
// Single-image rescan (eager, on-demand)
// ---------------------------------------------------------------------------

/**
 * Re-run AI tagging + OCR for a single image on demand. Enrich-FIRST: the vision
 * model runs against the current blob and we only clear+overwrite tags/OCR when
 * it returns a real result — so a failed/empty rescan never destroys the user's
 * curated tags (it just bumps ocrAttempts). On success it's a full redo: confirmed
 * `tags` are cleared and the fresh suggestions land in `recommendedTags` for
 * re-confirmation, matching the manual-confirmation model of runImageOcr.
 * Returns the updated row, or null if the image is missing/deleted. Never throws.
 */
export async function rescanImage(id: string): Promise<typeof images.$inferSelect | null> {
  const db = useDb()

  const [img] = await db
    .select()
    .from(images)
    .where(and(eq(images.id, id), isNull(images.deletedAt)))
    .limit(1)
  if (!img) return null

  // Only images/gifs are OCR-able (mirrors runImageOcr's kind filter). For
  // anything else, clear stale results and return without a model call.
  if (!['image', 'gif'].includes(img.kind)) {
    const [r] = await db.update(images)
      .set({ tags: [], recommendedTags: [], ocrText: '', enrichAttempts: 0 })
      .where(eq(images.id, id)).returning()
    return r ?? img
  }

  // Oversized: clear + empty sentinel (don't re-select), no model call.
  if (img.size > OCR_MAX_SIZE) {
    const [r] = await db.update(images)
      .set({ tags: [], recommendedTags: [], ocrText: '', enrichAttempts: 0 })
      .where(eq(images.id, id)).returning()
    return r ?? img
  }

  const library = await buildTagLibrary()

  try {
    const dataUrl = await readImageDataUrl(img.storageKey, img.mime)
    const result = await describeImage(dataUrl)

    // Empty result → keep existing tags/OCR intact, just record the attempt.
    if (!result.ocrText && result.tags.length === 0) {
      const [r] = await db.update(images)
        .set({ enrichAttempts: sql`${images.enrichAttempts} + 1` })
        .where(eq(images.id, id)).returning()
      return r ?? img
    }

    // Real result → full redo: clear confirmed tags, write fresh suggestions + OCR.
    const { recommended } = splitTags(result.tags, library)
    const cappedRecommended = capTags(recommended, 10)
    const [r] = await db.update(images)
      .set({ tags: [], recommendedTags: cappedRecommended, ocrText: result.ocrText || '', enrichAttempts: 0 })
      .where(eq(images.id, id)).returning()
    return r ?? img
  } catch (err) {
    console.warn(`[image-ocr] rescan failed for ${id}:`, err)
    const [r] = await db.update(images)
      .set({ enrichAttempts: sql`${images.enrichAttempts} + 1` })
      .where(eq(images.id, id)).returning()
    return r ?? img
  }
}
