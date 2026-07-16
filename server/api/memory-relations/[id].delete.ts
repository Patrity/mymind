import { deleteMemoryRelation } from '../../services/memory-relations'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  try {
    return await deleteMemoryRelation(id)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('not found')) {
      throw createError({ statusCode: 404, statusMessage: msg })
    }
    throw err
  }
})
