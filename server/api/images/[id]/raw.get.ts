import { getImage } from '../../../services/images'
import { storage } from '../../../utils/storage'

/** Derive a safe content-type from kind/ext instead of trusting the stored MIME directly. */
function safeContentType(kind: string, ext: string): string {
  if (kind === 'image' || kind === 'gif') return 'image/webp'
  if (ext === 'mp4') return 'video/mp4'
  if (ext === 'webm') return 'video/webm'
  if (ext === 'mov') return 'video/quicktime'
  return 'application/octet-stream'
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const row = await getImage(id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Not found' })

  const { stream } = await storage().get(row.storageKey)

  setResponseHeader(event, 'content-type', safeContentType(row.kind, row.ext))
  setResponseHeader(event, 'cache-control', 'private, max-age=3600')
  setResponseHeader(event, 'x-content-type-options', 'nosniff')
  setResponseHeader(event, 'content-disposition', 'inline')

  return sendStream(event, stream)
})
