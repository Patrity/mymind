import { deleteDoc } from '../../services/documents'
import { publishChange } from '../../utils/live-bus'
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const ok = await deleteDoc(id)
  if (!ok) throw createError({ statusCode: 404 })
  publishChange({ resource: 'document', action: 'deleted', id })
  return { ok: true }
})
