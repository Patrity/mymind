import { z } from 'zod'
import { setPublic } from '@mymind/core/services/documents'
import { publishChange } from '@mymind/core/utils/live-bus'
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const { isPublic } = z.object({ isPublic: z.boolean() }).parse(await readBody(event))
  const doc = await setPublic(id, isPublic)
  if (!doc) throw createError({ statusCode: 404 })
  publishChange({ resource: 'document', action: 'updated', id })
  return doc
})
