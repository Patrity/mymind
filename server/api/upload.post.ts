import { createImage, serveUrl, setImagePublic } from '../services/images'

export default defineEventHandler(async (event) => {
  const contentType = getHeader(event, 'content-type') ?? ''
  const makePublic = getQuery(event).public === '1' || getHeader(event, 'x-public') === '1'

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

  let row = await createImage(buffer, mime, originalName)

  if (makePublic) {
    row = (await setImagePublic(row.id, true)) ?? row
  }

  const url = serveUrl(row)

  return {
    id: row.id,
    slug: row.publicSlug ?? null,
    url
  }
})
