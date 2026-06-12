import { eq } from 'drizzle-orm'
import { useDb } from '../../../db'
import { reviewQueue } from '../../../db/schema'
import { publishChange } from '../../../utils/live-bus'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const db = useDb()
  const [item] = await db.select().from(reviewQueue).where(eq(reviewQueue.id, id)).limit(1)
  if (!item || item.status !== 'pending') throw createError({ statusCode: 404 })

  await db.update(reviewQueue)
    .set({ status: 'rejected', resolvedAt: new Date() })
    .where(eq(reviewQueue.id, id))

  publishChange({ resource: 'review', action: 'updated', id })

  return { ok: true }
})
