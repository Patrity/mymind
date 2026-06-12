import { and, isNull, ne } from 'drizzle-orm'
import { useDb } from '../../db'
import { images } from '../../db/schema'

// Mark images for (re)enrichment. ?all=1 re-enriches everything; default only non-done.
export default defineEventHandler(async (event) => {
  const all = getQuery(event).all === '1'
  const where = all
    ? isNull(images.deletedAt)
    : and(isNull(images.deletedAt), ne(images.enrichStatus, 'done'))
  const updated = await useDb().update(images)
    .set({ enrichStatus: 'pending', enrichAttempts: 0, enrichError: null })
    .where(where).returning({ id: images.id })
  return { queued: updated.length }
})
