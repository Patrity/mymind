import { createTextMessage } from '../../../../services/clipboard'
import { publish } from '../../../../utils/clip-pubsub'

export default defineEventHandler(async (event) => {
  const threadId = getRouterParam(event, 'id')!
  const body = await readBody(event) as {
    bodyText?: string
    bodyHtml?: string
    deviceId?: string
  }

  if (!body?.bodyText || typeof body.bodyText !== 'string') {
    throw createError({ statusCode: 400, statusMessage: 'bodyText is required' })
  }

  // deviceId can come from body or from the clip_device cookie
  const deviceId = body.deviceId ?? getCookie(event, 'clip_device') ?? undefined

  const message = await createTextMessage({
    threadId,
    deviceId,
    bodyText: body.bodyText,
    bodyHtml: body.bodyHtml
  })

  publish(threadId, message)
  return message
})
