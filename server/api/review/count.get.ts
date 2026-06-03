import { eq, count } from 'drizzle-orm'
import { useDb } from '../../db'
import { reviewQueue } from '../../db/schema'

export default defineEventHandler(async () => {
  const db = useDb()
  const [result] = await db.select({ pending: count() })
    .from(reviewQueue)
    .where(eq(reviewQueue.status, 'pending'))
  return { pending: result?.pending ?? 0 }
})
