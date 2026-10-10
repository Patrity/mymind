import { enrichImage } from '../../../services/image-enrich'
import { toImageDTO } from '@mymind/core/services/images'
import { publishChange } from '@mymind/core/utils/live-bus'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const row = await enrichImage(id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Not found' })
  publishChange({ resource: 'image', action: 'updated', id })
  return toImageDTO(row)
})
