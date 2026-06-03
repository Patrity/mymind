import { z } from 'zod'
import { updateDoc } from '../../services/documents'
const Body = z.object({
  path: z.string().optional(), title: z.string().nullish(), content: z.string().optional(),
  frontmatter: z.record(z.string(), z.unknown()).optional(), project: z.string().nullish(),
  domain: z.string().nullish(), type: z.string().nullish(), tags: z.array(z.string()).optional(),
  topic: z.string().nullish()
})
export default defineEventHandler(async (event) => {
  const doc = await updateDoc(getRouterParam(event, 'id')!, Body.parse(await readBody(event)))
  if (!doc) throw createError({ statusCode: 404 })
  return doc
})
