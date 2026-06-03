import { getImage } from '../../../services/images'
import { storage } from '../../../utils/storage'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const row = await getImage(id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Not found' })

  const { stream } = await storage().get(row.storageKey)

  setResponseHeader(event, 'content-type', row.mime)
  setResponseHeader(event, 'cache-control', 'private, max-age=3600')

  return sendStream(event, stream)
})
