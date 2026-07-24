import { z } from 'zod'
import { updateSkill } from '../../services/skills'
import { publishChange } from '../../utils/live-bus'

const Body = z.object({
  description: z.string().optional(), whenToUse: z.string().optional(),
  body: z.string().optional(), active: z.boolean().optional(), name: z.string().optional()
})

export default defineEventHandler(async (event) => {
  const name = getRouterParam(event, 'name')!
  const patch = Body.parse(await readBody(event))
  try {
    const s = await updateSkill(name, patch)
    if (!s) throw createError({ statusCode: 404, statusMessage: `no skill named "${name}"` })
    publishChange({ resource: 'document', action: 'updated', id: s.id })
    return s
  } catch (err) {
    const e = err as { statusCode?: number, message: string }
    if (e.statusCode) throw err
    throw createError({ statusCode: 400, statusMessage: e.message })
  }
})
