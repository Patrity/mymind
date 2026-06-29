import { saveFile } from '../../services/files'

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()
  const MAX_UPLOAD_BYTES: number = config.maxUploadBytes as number

  const parts = await readMultipartFormData(event)
  const filePart = parts?.find(p => p.name === 'file')
  if (!filePart) throw createError({ statusCode: 400, statusMessage: 'No file field in multipart body' })

  const buffer = Buffer.isBuffer(filePart.data) ? filePart.data : Buffer.from(filePart.data)
  const mime = filePart.type ?? 'application/octet-stream'
  const filename = filePart.filename ?? undefined

  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw createError({ statusCode: 413, statusMessage: 'Payload Too Large' })
  }

  const ref = await saveFile(buffer, mime, filename)

  return {
    id: ref.id,
    kind: 'file' as const,
    mime: ref.mime,
    name: ref.name,
    size: ref.size
  }
})
