import { getActivityTrace } from '../../services/activity'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const result = await getActivityTrace(id)
  if (!result.root) throw createError({ statusCode: 404, statusMessage: 'Activity record not found' })
  return result
})
