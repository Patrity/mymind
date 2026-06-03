import { eq } from 'drizzle-orm'
import { useDb } from '../../../db'
import { reviewQueue } from '../../../db/schema'
import { getDoc, updateDoc, moveDoc } from '../../../services/documents'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const db = useDb()
  const [item] = await db.select().from(reviewQueue).where(eq(reviewQueue.id, id)).limit(1)
  if (!item || item.status !== 'pending') throw createError({ statusCode: 404 })

  const p = item.proposed as {
    title?: string | null
    project?: string | null
    domain?: string | null
    type?: string | null
    tags?: string[] | null
    path?: string | null
    reasoning?: string | null
  }

  const doc = await getDoc(item.docId)
  if (doc) {
    await updateDoc(item.docId, {
      title: p.title ?? doc.title,
      project: p.project ?? doc.project,
      domain: p.domain ?? doc.domain,
      type: p.type ?? doc.type,
      tags: p.tags ?? doc.tags
    })
    if (p.path && p.path !== doc.path) {
      try {
        await moveDoc(item.docId, p.path)
      } catch {
        // path taken — leave in place
      }
    }
  }

  await db.update(reviewQueue)
    .set({ status: 'approved', resolvedAt: new Date() })
    .where(eq(reviewQueue.id, id))

  return { ok: true }
})
