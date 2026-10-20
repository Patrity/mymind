import { z } from 'zod'
import { createDoc } from '@mymind/core/services/documents'
import { publishChange } from '@mymind/core/utils/live-bus'
const Body = z.object({
  path: z.string().min(1).regex(/^\//, 'path must start with /'),
  title: z.string().nullish(), content: z.string().optional(),
  frontmatter: z.record(z.string(), z.unknown()).optional(),
  project: z.string().nullish(), domain: z.string().nullish(), type: z.string().nullish(),
  tags: z.array(z.string()).optional(), topic: z.string().nullish()
})
export default defineEventHandler(async (event) => {
  const body = Body.parse(await readBody(event))
  let doc
  try {
    doc = await createDoc(body)
  } catch (err) {
    // documents_path_live_uidx: a live document already owns this path. Surface a 409, not a 500.
    const e = err as { code?: string, constraint?: string, cause?: { code?: string, constraint?: string } }
    const code = e?.code ?? e?.cause?.code
    const constraint = e?.constraint ?? e?.cause?.constraint
    if (code === '23505' && constraint === 'documents_path_live_uidx') {
      throw createError({ statusCode: 409, statusMessage: 'Conflict', message: `A document already exists at ${body.path}` })
    }
    throw err
  }
  publishChange({ resource: 'document', action: 'created', id: doc.id })
  return doc
})
