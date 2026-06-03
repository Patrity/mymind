import { z } from 'zod'
import { createMemory } from '../../services/memory'

const Body = z.object({
  content: z.string().min(1).max(2000),
  scope: z.enum(['user', 'agent', 'world']).default('user'),
  project: z.string().nullish(),
  tags: z.array(z.string().max(100)).max(50).optional()
})

export default defineEventHandler(async (event) => {
  const body = Body.parse(await readBody(event))
  return createMemory({ ...body, source: 'manual', reviewed: true })
})
