import { z } from 'zod'
import { setPublic } from '../../../services/documents'
export default defineEventHandler(async (event) => {
  const { isPublic } = z.object({ isPublic: z.boolean() }).parse(await readBody(event))
  const doc = await setPublic(getRouterParam(event, 'id')!, isPublic)
  if (!doc) throw createError({ statusCode: 404 })
  return doc
})
