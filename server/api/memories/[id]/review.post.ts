import { reviewMemory } from '@mymind/core/services/memory'
import { publishChange } from '@mymind/core/utils/live-bus'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const result = await reviewMemory(id)
  if (!result) throw createError({ statusCode: 404, statusMessage: 'Memory not found' })
  publishChange({ resource: 'memory', action: 'updated', id })
  return { ok: true }
})
