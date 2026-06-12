import { revectorizeImage } from '../../../services/image-enrich'
import { toImageDTO } from '../../../services/images'
import { publishChange } from '../../../utils/live-bus'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const row = await revectorizeImage(id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Not found' })
  publishChange({ resource: 'image', action: 'updated', id })
  return toImageDTO(row)
})
