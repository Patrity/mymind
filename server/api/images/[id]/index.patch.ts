import { z } from 'zod'
import { getImage, patchImage, serveUrl, setImagePublic } from '../../../services/images'

const Body = z.object({
  summary: z.string().nullable().optional(),
  ocrText: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  recommendedTags: z.array(z.string()).optional(),
  isPublic: z.boolean().optional()
})

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const body = Body.parse(await readBody(event))

  let row = await getImage(id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Not found' })

  if (body.isPublic !== undefined) {
    row = (await setImagePublic(id, body.isPublic)) ?? row
  }

  if (
    body.summary !== undefined ||
    body.ocrText !== undefined ||
    body.tags !== undefined ||
    body.recommendedTags !== undefined
  ) {
    row = (await patchImage(id, {
      summary: body.summary,
      ocrText: body.ocrText,
      tags: body.tags,
      recommendedTags: body.recommendedTags
    })) ?? row
  }

  return { ...row, url: serveUrl(row) }
})
