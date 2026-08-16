import { eq } from 'drizzle-orm'
import { useDb } from '../../../db'
import { reviewQueue } from '../../../db/schema'
import { approveHandlers } from '../kinds'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const db = useDb()
  const [item] = await db.select().from(reviewQueue).where(eq(reviewQueue.id, id)).limit(1)
  if (!item || item.status !== 'pending') throw createError({ statusCode: 404 })

  const handler = approveHandlers[item.kind]
  if (!handler) throw createError({ statusCode: 400, statusMessage: `Unknown review kind: ${item.kind}` })

  await handler(item)

  return { ok: true }
})
