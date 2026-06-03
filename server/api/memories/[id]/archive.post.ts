import { archiveMemory } from '../../../services/memory'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const result = await archiveMemory(id)
  if (!result) throw createError({ statusCode: 404, statusMessage: 'Memory not found' })
  return { ok: true }
})
