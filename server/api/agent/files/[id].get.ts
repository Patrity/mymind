import { getFileBytes } from '../../../services/files'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const result = await getFileBytes(id)
  if (!result) throw createError({ statusCode: 404, statusMessage: 'Not found' })

  setResponseHeader(event, 'content-type', result.mime)
  setResponseHeader(event, 'content-disposition', 'attachment')

  return result.bytes
})
