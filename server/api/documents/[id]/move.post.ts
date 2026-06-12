import { z } from 'zod'
import { moveDoc } from '../../../services/documents'
import { publishChange } from '../../../utils/live-bus'
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const { path } = z.object({ path: z.string().regex(/^\//) }).parse(await readBody(event))
  const doc = await moveDoc(id, path)
  if (!doc) throw createError({ statusCode: 404 })
  publishChange({ resource: 'document', action: 'updated', id })
  return doc
})
