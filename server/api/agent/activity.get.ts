// server/api/agent/activity.get.ts
import { subscribeActivity } from '../../lib/agent/bus'

export default defineEventHandler(async (event) => {
  const res = event.node.res
  setResponseHeaders(event, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no'
  })
  res.flushHeaders()
  res.write(': ping\n\n')

  const unsubscribe = subscribeActivity(e => res.write(`data: ${JSON.stringify(e)}\n\n`))
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 25_000)

  return new Promise<void>((resolve) => {
    event.node.req.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
      resolve()
    })
  })
})
