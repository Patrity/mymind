import { z } from 'zod'
import { moveDoc } from '../../../services/documents'
export default defineEventHandler(async (event) => {
  const { path } = z.object({ path: z.string().regex(/^\//) }).parse(await readBody(event))
  const doc = await moveDoc(getRouterParam(event, 'id')!, path)
  if (!doc) throw createError({ statusCode: 404 })
  return doc
})
