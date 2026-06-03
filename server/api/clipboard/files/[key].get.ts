import { eq } from 'drizzle-orm'
import { useDb } from '../../../db'
import { clipAttachments } from '../../../db/schema'
import { storage } from '../../../utils/storage'

export default defineEventHandler(async (event) => {
  const key = getRouterParam(event, 'key')!

  // Look up attachment to get the stored mime type
  const [att] = await useDb()
    .select({ mime: clipAttachments.mime })
    .from(clipAttachments)
    .where(eq(clipAttachments.storageKey, key))
    .limit(1)

  const mime = att?.mime ?? 'application/octet-stream'

  const { stream } = await storage().get(key).catch(() => {
    throw createError({ statusCode: 404, statusMessage: 'File not found' })
  })

  setResponseHeaders(event, {
    'content-type': mime,
    'x-content-type-options': 'nosniff'
  })

  // Return the readable stream — Nitro/h3 will pipe it to the response
  return sendStream(event, stream)
})
