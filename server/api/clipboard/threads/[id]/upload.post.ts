import { Readable } from 'node:stream'
import { createFileMessage } from '../../../../services/clipboard'
import { storage } from '../../../../utils/storage'
import { publish } from '../../../../utils/clip-pubsub'

export default defineEventHandler(async (event) => {
  const threadId = getRouterParam(event, 'id')!
  const cfg = useRuntimeConfig()

  const parts = await readMultipartFormData(event)
  if (!parts || !parts.length) {
    throw createError({ statusCode: 400, statusMessage: 'No file in request' })
  }
  const filePart = parts.find(p => p.name === 'file' && p.filename)
  if (!filePart) {
    throw createError({ statusCode: 400, statusMessage: 'No "file" field in multipart body' })
  }

  const maxBytes = Number(cfg.maxUploadBytes ?? 52428800)
  if (filePart.data.length > maxBytes) {
    throw createError({ statusCode: 413, statusMessage: 'Payload Too Large' })
  }

  const mime = filePart.type || 'application/octet-stream'

  // deviceId from cookie
  const deviceId = getCookie(event, 'clip_device') ?? undefined

  // Store original — no webp conversion for clipboard files
  const { key, sha256, size } = await storage().put(
    Readable.from(filePart.data),
    { contentType: mime }
  )

  // Attempt to read image dimensions via sharp (best-effort; failures yield null)
  let width: number | null = null
  let height: number | null = null
  if (mime.startsWith('image/')) {
    try {
      const sharp = await import('sharp').then(m => m.default ?? m).catch(() => null)
      if (sharp) {
        const meta = await sharp(filePart.data).metadata()
        width = meta.width ?? null
        height = meta.height ?? null
      }
    }
    catch { /* swallow — leave null */ }
  }

  const message = await createFileMessage({
    threadId,
    deviceId,
    attachment: {
      storageKey: key,
      sha256,
      size,
      mime,
      originalName: filePart.filename!,
      width: width ?? undefined,
      height: height ?? undefined
    }
  })

  publish(threadId, message)
  return message
})
