import { z } from 'zod'
import { updateDoc } from '../../services/documents'
import { publishChange } from '../../utils/live-bus'
const Body = z.object({
  path: z.string().optional(), title: z.string().nullish(), content: z.string().optional(),
  frontmatter: z.record(z.string(), z.unknown()).optional(), project: z.string().nullish(),
  domain: z.string().nullish(), type: z.string().nullish(), tags: z.array(z.string()).optional(),
  topic: z.string().nullish()
})
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const doc = await updateDoc(id, Body.parse(await readBody(event)))
  if (!doc) throw createError({ statusCode: 404 })
  publishChange({ resource: 'document', action: 'updated', id })
  return doc
})
