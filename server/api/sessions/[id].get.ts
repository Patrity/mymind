import { getSessionMeta } from '../../services/sessions'

export default defineEventHandler(async (event) => {
  const session = await getSessionMeta(getRouterParam(event, 'id')!)
  if (!session) throw createError({ statusCode: 404 })
  return session
})
