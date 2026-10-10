import { deleteImage } from '@mymind/core/services/images'
import { publishChange } from '@mymind/core/utils/live-bus'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const ok = await deleteImage(id)
  if (!ok) throw createError({ statusCode: 404, statusMessage: 'Not found' })
  publishChange({ resource: 'image', action: 'deleted', id })
  return { ok: true }
})
