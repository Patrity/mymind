import { revectorizeImage } from '../../../services/image-enrich'
import { toImageDTO } from '../../../services/images'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const row = await revectorizeImage(id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Not found' })
  return toImageDTO(row)
})
