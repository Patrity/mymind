import { eq, desc } from 'drizzle-orm'
import { useDb } from '../../db'
import { reviewQueue, documents } from '../../db/schema'

export default defineEventHandler(async () => {
  const db = useDb()
  return db.select({
    id: reviewQueue.id,
    docId: reviewQueue.docId,
    kind: reviewQueue.kind,
    proposed: reviewQueue.proposed,
    createdAt: reviewQueue.createdAt,
    docPath: documents.path
  }).from(reviewQueue)
    .leftJoin(documents, eq(documents.id, reviewQueue.docId))
    .where(eq(reviewQueue.status, 'pending'))
    .orderBy(desc(reviewQueue.createdAt))
})
