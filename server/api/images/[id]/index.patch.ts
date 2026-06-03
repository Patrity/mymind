import { z } from 'zod'
import { getImage, patchTags, serveUrl, setImagePublic } from '../../../services/images'

const Body = z.object({
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

  if (body.tags !== undefined || body.recommendedTags !== undefined) {
    row = (await patchTags(id, { tags: body.tags, recommendedTags: body.recommendedTags })) ?? row
  }

  return { ...row, url: serveUrl(row) }
})
