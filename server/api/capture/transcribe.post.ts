import { z } from 'zod'
import { nanoid } from 'nanoid'
import { getImage } from '../../services/images'
import { storage } from '../../utils/storage'
import { describeImage } from '../../lib/ai/vision'
import { createDoc } from '../../services/documents'

const Body = z.object({
  imageId: z.string().min(1, 'imageId is required'),
  title: z.string().optional()
})

export default defineEventHandler(async (event) => {
  const body = Body.parse(await readBody(event))

  const image = await getImage(body.imageId)
  if (!image) throw createError({ statusCode: 404, statusMessage: 'Image not found' })

  // Read blob from storage and convert to base64 data URL
  const { stream } = await storage().get(image.storageKey)
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer))
  }
  const buf = Buffer.concat(chunks)
  const dataUrl = `data:${image.mime};base64,${buf.toString('base64')}`

  const { ocrText } = await describeImage(dataUrl)

  const doc = await createDoc({
    path: `/input/transcribed-${nanoid(8)}.md`,
    title: body.title ?? 'Transcribed note',
    content: ocrText || '(no text recognized)'
  })

  return { ...doc, ocrText }
})
