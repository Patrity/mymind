import { getDoc } from '../../services/documents'
export default defineEventHandler(async (event) => {
  const doc = await getDoc(getRouterParam(event, 'id')!)
  if (!doc) throw createError({ statusCode: 404 })
  return doc
})
