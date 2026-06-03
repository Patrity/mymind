import { and, eq, isNull, sql, notExists } from 'drizzle-orm'
import { useDb } from '../db'
import { documents, reviewQueue } from '../db/schema'
import { proposeFrontmatter } from '../lib/ai/enrich'

export interface EnrichResult {
  proposed: number
  skipped: number
}

/**
 * Find /input/* documents with sparse metadata and no existing review_queue row,
 * call the AI proposer, and insert a pending review_queue row.
 * NEVER mutates the document itself.
 */
export async function runEnrichInput({ limit = 20 }: { limit?: number } = {}): Promise<EnrichResult> {
  const db = useDb()

  // Select live /input/* docs with sparse metadata (project IS NULL, tags empty)
  // that have no review_queue row (any status) for that docId
  const candidates = await db
    .select()
    .from(documents)
    .where(
      and(
        isNull(documents.deletedAt),
        sql`${documents.path} LIKE '/input/%'`,
        isNull(documents.project),
        sql`(${documents.tags} = '{}' OR array_length(${documents.tags}, 1) IS NULL)`,
        notExists(
          db
            .select({ id: reviewQueue.id })
            .from(reviewQueue)
            .where(eq(reviewQueue.docId, documents.id))
        )
      )
    )
    .limit(limit)

  let proposed = 0
  let skipped = 0

  for (const doc of candidates) {
    try {
      const docDto = {
        id: doc.id,
        path: doc.path,
        title: doc.title,
        content: doc.content,
        language: doc.language,
        frontmatter: doc.frontmatter as Record<string, unknown>,
        project: doc.project,
        domain: doc.domain,
        type: doc.type,
        tags: doc.tags,
        topic: doc.topic,
        isPublic: doc.isPublic,
        publicSlug: doc.publicSlug,
        updatedAt: doc.updatedAt.toISOString()
      }

      const proposal = await proposeFrontmatter(docDto)

      if (!proposal) {
        console.warn(`[enrichment] parse failed for doc ${doc.id} (${doc.path}), skipping`)
        skipped++
        continue
      }

      await db.insert(reviewQueue).values({
        docId: doc.id,
        kind: 'enrichment',
        proposed: proposal as unknown as string,
        status: 'pending'
      })

      console.log(`[enrichment] queued proposal for ${doc.path}`)
      proposed++
    } catch (err) {
      console.error(`[enrichment] error processing doc ${doc.id}:`, err)
      skipped++
    }
  }

  return { proposed, skipped }
}
