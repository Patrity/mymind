import { z } from 'zod'
import { createSkill } from '../../services/skills'

const Body = z.object({
  name: z.string(), description: z.string(), whenToUse: z.string(),
  body: z.string(), active: z.boolean().optional()
})

export default defineEventHandler(async (event) => {
  let input: z.infer<typeof Body>
  try {
    input = Body.parse(await readBody(event))
  } catch (err) {
    throw createError({ statusCode: 400, statusMessage: (err as Error).message })
  }
  try {
    // createSkill publishes the `agentSkill` live event itself.
    const s = await createSkill({ ...input, source: 'human' }, { actor: 'human' })
    return s
  } catch (err) {
    throw createError({ statusCode: 400, statusMessage: (err as Error).message })
  }
})
