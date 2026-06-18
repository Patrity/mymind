import { and, isNull, or, sql, eq } from 'drizzle-orm'
import { useDb } from '../db'
import { documents } from '../db/schema'
import { chunkAndEmbedSource } from '../lib/chunking/embed-source'
import { publishChange } from '../utils/live-bus'

export async function runEmbedding({ limit = 200 } = {}): Promise<{ embedded: number, failed: number, remaining: number }> {
  const db = useDb()
  const needWhere = and(
    isNull(documents.deletedAt),
    or(isNull(documents.chunkedHash), sql`${documents.chunkedHash} is distinct from ${documents.contentHash}`)
  )
  const rows = await db.select({ id: documents.id, title: documents.title, content: documents.content, contentHash: documents.contentHash })
    .from(documents).where(needWhere).limit(limit)

  let embedded = 0
  let failed = 0
  for (const r of rows) {
    try {
      await chunkAndEmbedSource({ sourceType: 'document', sourceId: r.id, title: r.title, body: r.content })
      await db.update(documents).set({ chunkedHash: r.contentHash }).where(eq(documents.id, r.id))
      publishChange({ resource: 'document', action: 'updated', id: r.id })
      embedded++
    } catch (err) {
      console.warn(`[embedding] failed to chunk/embed doc ${r.id}:`, (err as Error).message)
      failed++
    }
  }

  const countRows = await db.select({ count: sql<number>`count(*)::int` }).from(documents).where(needWhere)
  return { embedded, failed, remaining: Number(countRows[0]!.count) }
}
