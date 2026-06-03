import { renameThread } from '../../../../services/clipboard'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const body = await readBody(event) as { title: string }
  if (!body?.title || typeof body.title !== 'string') {
    throw createError({ statusCode: 400, statusMessage: 'title is required' })
  }
  const thread = await renameThread(id, body.title)
  if (!thread) throw createError({ statusCode: 404, statusMessage: 'Thread not found' })
  return thread
})
