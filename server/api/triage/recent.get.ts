// server/api/triage/recent.get.ts
//
// The "recently applied" strip's data source. This is a FEED, not a queue — every row
// here already happened (auto-applied or human-approved), so it deliberately does NOT
// touch review_queue and must never affect GET /api/review/count (the sidebar badge).
import { and, desc, eq, gte, isNull } from 'drizzle-orm'
import { useDb } from '../../db'
import { triageActions, documents } from '../../db/schema'

const RECENT_LIMIT = 20
const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

export default defineEventHandler(async () => {
  const db = useDb()
  const since = new Date(Date.now() - RECENT_WINDOW_MS)

  return db.select({
    id: triageActions.id,
    docId: triageActions.docId,
    kind: triageActions.kind,
    entityType: triageActions.entityType,
    entityId: triageActions.entityId,
    confidence: triageActions.confidence,
    autoApplied: triageActions.autoApplied,
    payload: triageActions.payload,
    createdAt: triageActions.createdAt,
    // leftJoin, not an inner join or getDoc: the courier document is routinely
    // soft-deleted by the actuator itself (applyTask/applyMemory/applyAppend), and a
    // note's destination path is exactly what this row needs to show "where it went".
    docPath: documents.path
  }).from(triageActions)
    .leftJoin(documents, eq(documents.id, triageActions.docId))
    .where(and(isNull(triageActions.revertedAt), gte(triageActions.createdAt, since)))
    .orderBy(desc(triageActions.createdAt))
    .limit(RECENT_LIMIT)
})
