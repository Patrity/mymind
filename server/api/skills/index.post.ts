import { z } from 'zod'
import { createSkill } from '../../services/skills'
import { publishChange } from '../../utils/live-bus'

const Body = z.object({
  name: z.string(), description: z.string(), whenToUse: z.string(),
  body: z.string(), active: z.boolean().optional()
})

export default defineEventHandler(async (event) => {
  const input = Body.parse(await readBody(event))
  try {
    const s = await createSkill({ ...input, source: 'human' })
    publishChange({ resource: 'document', action: 'created', id: s.id })
    return s
  } catch (err) {
    throw createError({ statusCode: 400, statusMessage: (err as Error).message })
  }
})
