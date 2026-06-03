import { getByPublicSlug } from '../../services/images'
import { storage } from '../../utils/storage'

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, 'slug')!
  const row = await getByPublicSlug(slug)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Not found' })

  const { stream } = await storage().get(row.storageKey)

  setResponseHeader(event, 'content-type', row.mime)
  setResponseHeader(event, 'cache-control', 'public, max-age=31536000, immutable')

  return sendStream(event, stream)
})
