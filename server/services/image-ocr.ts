import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm'
import { useDb } from '../db'
import { documents, images } from '../db/schema'
import { storage } from '../utils/storage'
import { describeImage } from '../lib/ai/vision'
import { capTags } from '../../shared/utils/cap-tags'

/** Max image size (bytes) to attempt OCR on — skip anything larger. */
const OCR_MAX_SIZE = 10 * 1024 * 1024 // 10 MB

// ---------------------------------------------------------------------------
// Tag splitting utility
// ---------------------------------------------------------------------------

export interface SplitTagsResult {
  confirmed: string[]
  recommended: string[]
}

/**
 * Split AI-suggested tags into confirmed (already in library) and recommended (new).
 * Normalises case and whitespace; deduplicates within the output.
 */
export function splitTags(suggested: string[], library: Set<string>): SplitTagsResult {
  const norm = (t: string) => t.trim().toLowerCase()
  const seen = new Set<string>()
  const confirmed: string[] = []
  const recommended: string[] = []

  for (const raw of suggested) {
    const t = norm(raw)
    if (!t || seen.has(t)) continue
    seen.add(t)
    ;(library.has(t) ? confirmed : recommended).push(t)
  }

  return { confirmed, recommended }
}

// ---------------------------------------------------------------------------
// Tag library builder
// ---------------------------------------------------------------------------

async function buildTagLibrary(): Promise<Set<string>> {
  const db = useDb()

  // Fetch all distinct tags from live documents
  const docTags = await db
    .selectDistinct({ tag: sql<string>`unnest(${documents.tags})` })
    .from(documents)
    .where(isNull(documents.deletedAt))

  // Fetch all distinct tags from images (no deleted_at filter needed — images use soft delete too)
  const imgTags = await db
    .selectDistinct({ tag: sql<string>`unnest(${images.tags})` })
    .from(images)
    .where(isNull(images.deletedAt))

  const library = new Set<string>()
  for (const { tag } of [...docTags, ...imgTags]) {
    if (tag && tag.trim()) library.add(tag.trim().toLowerCase())
  }
  return library
}

// ---------------------------------------------------------------------------
// OCR runner
// ---------------------------------------------------------------------------

export interface OcrRunResult {
  ocred: number
  failed: number
  remaining: number
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
          lt(images.ocrAttempts, 3)
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
      const { stream } = await storage().get(img.storageKey)

      // Collect stream into a Buffer
      const chunks: Buffer[] = []
      await new Promise<void>((resolve, reject) => {
        stream.on('data', (chunk: Buffer) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
        stream.on('end', resolve)
        stream.on('error', reject)
      })
      const buffer = Buffer.concat(chunks)
      const b64 = buffer.toString('base64')
      const dataUrl = `data:${img.mime};base64,${b64}`

      const result = await describeImage(dataUrl)

      // Soft-failure: model returned nothing useful — increment attempts rather than marking done
      if (!result.ocrText && result.tags.length === 0) {
        console.warn(`[image-ocr] empty result for ${img.id}, incrementing attempts`)
        await db
          .update(images)
          .set({ ocrAttempts: sql`${images.ocrAttempts} + 1` })
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
        .set({ ocrAttempts: sql`${images.ocrAttempts} + 1` })
        .where(eq(images.id, img.id))
      failed++
    }
  }

  // Count remaining un-processed images (same filter as candidate query)
  const remainingRows = await db
    .select({ remaining: sql<number>`count(*)::int` })
    .from(images)
    .where(and(isNull(images.ocrText), isNull(images.deletedAt), lt(images.ocrAttempts, 3)))

  const remaining = remainingRows[0]?.remaining ?? 0

  return { ocred, failed, remaining }
}
