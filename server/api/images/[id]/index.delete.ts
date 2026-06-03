import { deleteImage } from '../../../services/images'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const ok = await deleteImage(id)
  if (!ok) throw createError({ statusCode: 404, statusMessage: 'Not found' })
  return { ok: true }
})
