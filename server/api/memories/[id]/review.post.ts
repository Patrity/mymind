import { reviewMemory } from '../../../services/memory'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const result = await reviewMemory(id)
  if (!result) throw createError({ statusCode: 404, statusMessage: 'Memory not found' })
  return { ok: true }
})
