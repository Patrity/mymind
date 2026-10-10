import { z } from 'zod'
import { updateSkill } from '@mymind/core/services/skills'

const Body = z.object({
  description: z.string().optional(), whenToUse: z.string().optional(),
  body: z.string().optional(), active: z.boolean().optional(), name: z.string().optional()
})

export default defineEventHandler(async (event) => {
  const name = getRouterParam(event, 'name')!
  let patch: z.infer<typeof Body>
  try {
    patch = Body.parse(await readBody(event))
  } catch (err) {
    throw createError({ statusCode: 400, statusMessage: (err as Error).message })
  }
  try {
    // updateSkill publishes the `agentSkill` live event itself.
    const s = await updateSkill(name, patch, { actor: 'human' })
    if (!s) throw createError({ statusCode: 404, statusMessage: `no skill named "${name}"` })
    return s
  } catch (err) {
    const e = err as { statusCode?: number, message: string }
    if (e.statusCode) throw err
    throw createError({ statusCode: 400, statusMessage: e.message })
  }
})
