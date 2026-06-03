import { createThread } from '../../../services/clipboard'

export default defineEventHandler(async (event) => {
  const body = await readBody(event).catch(() => ({})) as { title?: string }
  return createThread({ title: body?.title })
})
