import { subscribe } from '../../../../utils/clip-pubsub'

// SSE approach: set response headers, flush them immediately so the client sees
// the response head without waiting for the first event, then subscribe to the
// in-process EventEmitter for this thread. We hold h3 open with a never-resolving
// Promise and resolve it only when the req 'close' fires, which is when the client
// disconnects. The unsubscribe fn is called in that same handler so we never leak
// listeners. A periodic heartbeat comment keeps proxy connections alive.
export default defineEventHandler(async (event) => {
  const threadId = getRouterParam(event, 'id')!
  const res = event.node.res

  setResponseHeaders(event, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no' // disable nginx buffering
  })

  // Flush headers immediately — without this an idle stream never sends the
  // response head and the client hangs until the first event arrives.
  res.flushHeaders()

  // Initial ping so the client knows the stream is alive
  res.write(': ping\n\n')

  function send(data: unknown) {
    res.write(`data: ${JSON.stringify(data)}\n\n`)
  }

  const unsubscribe = subscribe(threadId, send)

  // Heartbeat every 25 s — keeps proxies from closing the idle connection
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n')
  }, 25_000)

  return new Promise<void>((resolve) => {
    event.node.req.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
      resolve()
    })
  })
})
