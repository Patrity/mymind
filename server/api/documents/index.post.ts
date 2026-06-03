import { z } from 'zod'
import { createDoc } from '../../services/documents'
const Body = z.object({
  path: z.string().min(1).regex(/^\//, 'path must start with /'),
  title: z.string().nullish(), content: z.string().optional(),
  frontmatter: z.record(z.string(), z.unknown()).optional(),
  project: z.string().nullish(), domain: z.string().nullish(), type: z.string().nullish(),
  tags: z.array(z.string()).optional(), topic: z.string().nullish()
})
export default defineEventHandler(async (event) => {
  const body = Body.parse(await readBody(event))
  return createDoc(body)
})
