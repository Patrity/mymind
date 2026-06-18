import { and, eq, isNull, lt, or, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { useDb } from '../db'
import { documents, images, chunks } from '../db/schema'
import { storage } from '../utils/storage'
import { describeImageFull } from '../lib/ai/vision'
import { embed } from '../lib/ai/embeddings'
import { splitTags, buildTagLibrary } from './tag-library'
import { capTags } from '../../shared/utils/cap-tags'
import { cleanToMarkdown } from '../lib/ai/transcribe'
import { createDoc } from './documents'
import { slugify } from '../../shared/utils/slugify'
import { publishChange } from '../utils/live-bus'
import { chunkAndEmbedSource } from '../lib/chunking/embed-source'
import { estimateTokens } from '../lib/chunking/chunk-markdown'

const OCR_MAX_SIZE = 10 * 1024 * 1024 // 10 MB
const ENRICHABLE_KINDS = ['image', 'gif']

/** Cap retries: stop selecting a failed image after this many attempts. */
export const MAX_ATTEMPTS = 3

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

async function markFailed(id: string, error: string): Promise<typeof images.$inferSelect | null> {
  const [r] = await useDb().update(images)
    .set({ enrichStatus: 'failed', enrichError: error.slice(0, 500), enrichAttempts: sql`${images.enrichAttempts} + 1` })
    .where(eq(images.id, id)).returning()
  return r ?? null
}

/**
 * Full enrichment pipeline for one image. Never throws. Enrich-first: existing
 * tags/summary are only overwritten on a real vision result.
 */
export async function enrichImage(id: string): Promise<typeof images.$inferSelect | null> {
  const db = useDb()
  const [img] = await db.select().from(images).where(and(eq(images.id, id), isNull(images.deletedAt))).limit(1)
  if (!img) return null

  // Non-enrichable kinds (video): mark done, no model call.
  if (!ENRICHABLE_KINDS.includes(img.kind)) {
    const [r] = await db.update(images).set({ enrichStatus: 'done', enrichError: null }).where(eq(images.id, id)).returning()
    return r ?? img
  }

  await db.update(images).set({ enrichStatus: 'processing', enrichError: null }).where(eq(images.id, id))

  if (img.size > OCR_MAX_SIZE) {
    const [r] = await db.update(images).set({ enrichStatus: 'done', ocrText: img.ocrText ?? '' }).where(eq(images.id, id)).returning()
    return r ?? img
  }

  let result
  try {
    const dataUrl = await readImageDataUrl(img.storageKey, img.mime)
    result = await describeImageFull(dataUrl)
  } catch (err) {
    return await markFailed(id, (err as Error).message)
  }

  // Empty result → preserve existing data, record the attempt as failed (retryable).
  if (!result.summary && !result.ocrText && result.tags.length === 0) {
    return await markFailed(id, 'vision returned empty result')
  }

  // Tag split: library matches auto-apply to tags, new → recommendedTags.
  const library = await buildTagLibrary()
  const { confirmed, recommended } = splitTags(result.tags, library)

  // Optional document spin-off from the OCR markdown.
  if (img.makeDocument && result.ocrText.trim()) {
    try {
      const { title, markdown } = await cleanToMarkdown(result.ocrText)
      const effectiveTitle = title || img.originalName || `Scanned ${img.createdAt.toISOString().slice(0, 10)}`
      // Reuse an existing linked doc if present, else create one.
      const [existingDoc] = await db.select({ id: documents.id }).from(documents)
        .where(and(eq(documents.ocrId, id), isNull(documents.deletedAt))).limit(1)
      if (existingDoc) {
        await db.update(documents).set({ content: markdown || '(no text recognized)', title: effectiveTitle })
          .where(eq(documents.id, existingDoc.id))
      } else {
        const doc = await createDoc({
          path: `/input/${slugify(effectiveTitle)}-${nanoid(8)}.md`,
          title: effectiveTitle,
          content: markdown || '(no text recognized)'
        })
        await db.update(documents).set({ ocrId: id }).where(eq(documents.id, doc.id))
        publishChange({ resource: 'document', action: 'created', id: doc.id })
      }
    } catch (err) {
      console.warn(`[image-enrich] doc spin-off failed for ${id}:`, err)
      // non-fatal — continue with image enrichment
    }
  }

  // Embed the summary.
  let embedding: number[] | null = null
  if (result.summary.trim()) {
    try { embedding = (await embed([result.summary]))[0] ?? null } catch (err) {
      return await markFailed(id, `embed failed: ${(err as Error).message}`)
    }
  }

  const [r] = await db.update(images).set({
    summary: result.summary || null,
    ocrText: result.ocrText || '',
    tags: capTags([...img.tags, ...confirmed], 50),
    recommendedTags: capTags(recommended, 10),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    embedding: embedding as any,
    enrichStatus: 'done',
    enrichError: null
  }).where(eq(images.id, id)).returning()

  // Long OCR → chunk into the shared primitive (short OCR stays summary-only).
  // On re-enrich where OCR shrinks to ≤512 tokens (or empty), clear any stale
  // chunks so they don't linger in image search.
  try {
    if (result.ocrText && estimateTokens(result.ocrText) > 512) {
      await chunkAndEmbedSource({ sourceType: 'image', sourceId: id, title: result.summary || null, body: result.ocrText })
    } else {
      await db.delete(chunks).where(and(eq(chunks.sourceType, 'image'), eq(chunks.sourceId, id)))
    }
  } catch (err) {
    console.warn(`[image-enrich] OCR chunking failed for ${id}:`, (err as Error).message)
  }

  return r ?? img
}

export interface ImageEnrichResult {
  done: number
  failed: number
  remaining: number
}

/**
 * Process up to `limit` non-deleted images that are pending or retryable-failed
 * (failed with fewer than MAX_ATTEMPTS attempts). Runs the full enrichment
 * pipeline on each and tallies done/failed. `remaining` uses the same predicate.
 */
export async function runImageEnrich({ limit = 20 }: { limit?: number } = {}): Promise<ImageEnrichResult> {
  const db = useDb()
  const retryable = or(
    eq(images.enrichStatus, 'pending'),
    and(eq(images.enrichStatus, 'failed'), lt(images.enrichAttempts, MAX_ATTEMPTS))
  )

  const candidates = await db.select({ id: images.id }).from(images)
    .where(and(isNull(images.deletedAt), retryable))
    .limit(limit)

  let done = 0, failed = 0
  for (const c of candidates) {
    const r = await enrichImage(c.id)
    publishChange({ resource: 'image', action: 'updated', id: c.id })
    if (r?.enrichStatus === 'done') done++
    else failed++
  }

  const [row] = await db.select({ remaining: sql<number>`count(*)::int` }).from(images)
    .where(and(isNull(images.deletedAt), retryable))

  return { done, failed, remaining: row?.remaining ?? 0 }
}

/** Re-embed the image's CURRENT summary only (no vision call). For the Revectorize button. */
export async function revectorizeImage(id: string): Promise<typeof images.$inferSelect | null> {
  const db = useDb()
  const [img] = await db.select().from(images).where(and(eq(images.id, id), isNull(images.deletedAt))).limit(1)
  if (!img) return null
  if (!img.summary?.trim()) {
    const [r] = await db.update(images).set({ embedding: null }).where(eq(images.id, id)).returning()
    return r ?? img
  }
  try {
    const [vec] = await embed([img.summary])
    const [r] = await db.update(images)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .set({ embedding: vec as any }).where(eq(images.id, id)).returning()
    return r ?? img
  } catch (err) {
    return await markFailed(id, `revectorize failed: ${(err as Error).message}`)
  }
}
