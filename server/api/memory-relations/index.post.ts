import { z } from 'zod'
import { createMemoryRelation } from '../../services/memory-relations'

const Body = z.object({
  fromId: z.string().min(1),
  toId: z.string().min(1),
  type: z.enum(['supersedes', 'contradicts'])
})

export default defineEventHandler(async (event) => {
  const body = Body.parse(await readBody(event))
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
