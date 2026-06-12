// One SSE connection per tab. Streams every live-bus change to the client.
// Auth-gated by server/middleware/auth.ts (only logged-in sessions/tokens reach here).
import { subscribeChanges } from '../utils/live-bus'

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

  const unsubscribe = subscribeChanges(e => res.write(`data: ${JSON.stringify(e)}\n\n`))
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 25_000)

  return new Promise<void>((resolve) => {
    event.node.req.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
      resolve()
    })
  })
})
