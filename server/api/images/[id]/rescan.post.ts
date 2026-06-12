import { rescanImage } from '../../../services/image-ocr'
import { serveUrl } from '../../../services/images'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const row = await rescanImage(id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Not found' })
  return { ...row, url: serveUrl(row) }
})
