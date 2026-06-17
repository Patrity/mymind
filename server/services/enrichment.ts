import { and, eq, isNull, sql, notExists } from 'drizzle-orm'
import { useDb } from '../db'
import { documents, projects as projectsTable, reviewQueue } from '../db/schema'
import { proposeFrontmatter } from '../lib/ai/enrich'
import { publishChange } from '../utils/live-bus'
import { recordEvent } from '../lib/observability/record'

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

  // Load active projects once before the loop — used to classify each doc.
  // Filter out 'uncategorized' (a system bucket, not a filing target).
  const activeProjects = (await db
    .select({ slug: projectsTable.slug, name: projectsTable.name, description: projectsTable.description })
    .from(projectsTable)
    .where(eq(projectsTable.active, true)))
    .filter(p => p.slug !== 'uncategorized')

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
        ocrId: doc.ocrId,
        updatedAt: doc.updatedAt.toISOString()
      }

      const proposal = await proposeFrontmatter(docDto, activeProjects)

      if (!proposal) {
        recordEvent({
          kind: 'job', name: 'enrich-input:parse-failed', status: 'warn', severity: 'warn',
          meta: { docId: doc.id, path: doc.path },
          error: { message: `proposeFrontmatter returned null (model produced no parseable proposal)` }
        })
        skipped++
        continue
      }

      const [inserted] = await db.insert(reviewQueue).values({
        docId: doc.id,
        kind: 'enrichment',
        proposed: proposal as unknown as string,
        status: 'pending'
      }).onConflictDoNothing().returning({ id: reviewQueue.id })

      if (inserted) {
        publishChange({ resource: 'review', action: 'created', id: inserted.id })
        recordEvent({ kind: 'job', name: 'enrich-input:queued', status: 'ok', severity: 'info', meta: { docId: doc.id, path: doc.path, reviewId: inserted.id } })
      }
      proposed++
    } catch (err) {
      recordEvent({
        kind: 'job', name: 'enrich-input:doc-error', status: 'error', severity: 'error',
        meta: { docId: doc.id, path: doc.path },
        error: { message: (err as Error).message, stack: (err as Error).stack }
      })
      skipped++
    }
  }

  return { proposed, skipped }
}
