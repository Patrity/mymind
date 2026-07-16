import { z } from 'zod'
import { createMemoryRelation } from '../../services/memory-relations'

const Body = z.object({
  fromId: z.uuid(),
  toId: z.uuid(),
  type: z.enum(['supersedes', 'contradicts'])
})

export default defineEventHandler(async (event) => {
  const parsed = Body.safeParse(await readBody(event))
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'Bad Request', data: parsed.error.issues })
  }
  const body = parsed.data
  try {
    return await createMemoryRelation(body.fromId, body.toId, body.type)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('cannot be related to itself') || msg.includes('unknown relation type')) {
      throw createError({ statusCode: 400, statusMessage: msg })
    }
    throw err
  }
})
