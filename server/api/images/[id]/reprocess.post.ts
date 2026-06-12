import { enrichImage } from '../../../services/image-enrich'
import { serveUrl } from '../../../services/images'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const row = await enrichImage(id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Not found' })
  return { ...row, url: serveUrl(row) }
})
