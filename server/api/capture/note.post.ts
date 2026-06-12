import { z } from 'zod'
import { nanoid } from 'nanoid'
import { createDoc } from '../../services/documents'
import { publishChange } from '../../utils/live-bus'

const Body = z.object({
  text: z.string().min(1, 'text is required'),
  title: z.string().optional()
})

/** Convert a title to a filesystem-safe kebab slug. */
function toSlug(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 64)
    || nanoid(8)
}

export default defineEventHandler(async (event) => {
  const body = Body.parse(await readBody(event))
  const slug = body.title ? toSlug(body.title) : nanoid(10)
  const path = `/input/${slug}.md`
  const doc = await createDoc({
    path,
    title: body.title ?? null,
    content: body.text
  })
  publishChange({ resource: 'document', action: 'created', id: doc.id })
  return doc
})
