import { createImage, serveUrl, setImagePublic } from '../services/images'
import { publishChange } from '../utils/live-bus'

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()
  const MAX_UPLOAD_BYTES: number = config.maxUploadBytes as number

  const contentType = getHeader(event, 'content-type') ?? ''
  const makePublic = getQuery(event).public === '1' || getHeader(event, 'x-public') === '1'
  const makeDocument = getQuery(event).makeDocument === '1' || getQuery(event).makeDocument === 'true' || getHeader(event, 'x-make-document') === '1'

  // Check Content-Length before reading the body (content-length can lie; buffer.length is the real guard below)
  const contentLength = Number(getHeader(event, 'content-length') ?? 0)
  if (contentLength > MAX_UPLOAD_BYTES) {
    throw createError({ statusCode: 413, statusMessage: 'Payload Too Large' })
  }

  let buffer: Buffer
  let mime: string
  let originalName: string | undefined

  if (contentType.includes('multipart/form-data')) {
    // ShareX multipart / CleanShot / browser form
    const parts = await readMultipartFormData(event)
    const filePart = parts?.find(p => p.name === 'file')
    if (!filePart) throw createError({ statusCode: 400, statusMessage: 'No file field in multipart body' })
    buffer = Buffer.isBuffer(filePart.data) ? filePart.data : Buffer.from(filePart.data)
    mime = filePart.type ?? 'application/octet-stream'
    originalName = filePart.filename ?? undefined
  } else {
    // ShareX Body=Binary or raw binary POST
    const raw = await readRawBody(event, false)
    if (!raw || raw.length === 0) throw createError({ statusCode: 400, statusMessage: 'Empty body' })
    buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer)
    // Strip parameters (e.g. "image/png; charset=binary") from the content-type
    mime = contentType.split(';')[0]!.trim() || 'application/octet-stream'
    originalName = getHeader(event, 'x-filename') ?? undefined
  }

  // Real size guard — content-length header can lie
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw createError({ statusCode: 413, statusMessage: 'Payload Too Large' })
  }

  let row: Awaited<ReturnType<typeof createImage>>
  try {
    row = await createImage(buffer, mime, originalName, { makeDocument })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.startsWith('Unsupported')) {
      throw createError({ statusCode: 415, statusMessage: 'Unsupported media type' })
    }
    throw err
  }

  if (makePublic) {
    row = (await setImagePublic(row.id, true)) ?? row
  }

  publishChange({ resource: 'image', action: 'created', id: row.id })

  const url = serveUrl(row)

  return {
    id: row.id,
    slug: row.publicSlug ?? null,
    url
  }
})
