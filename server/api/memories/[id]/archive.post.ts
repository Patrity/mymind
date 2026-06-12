import { archiveMemory } from '../../../services/memory'
import { publishChange } from '../../../utils/live-bus'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const result = await archiveMemory(id)
  if (!result) throw createError({ statusCode: 404, statusMessage: 'Memory not found' })
  publishChange({ resource: 'memory', action: 'updated', id })
  return { ok: true }
})
