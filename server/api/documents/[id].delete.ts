import { deleteDoc } from '../../services/documents'
export default defineEventHandler(async (event) => {
  const ok = await deleteDoc(getRouterParam(event, 'id')!)
  if (!ok) throw createError({ statusCode: 404 })
  return { ok: true }
})
