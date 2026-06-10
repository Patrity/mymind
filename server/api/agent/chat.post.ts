// server/api/agent/chat.post.ts
import { runAgent, type AgentMessage } from '../../lib/agent/run'

// Session-authed (middleware). Streams plain text deltas as SSE `data:` lines.
export default defineEventHandler(async (event) => {
  const body = await readBody<{ messages?: AgentMessage[] }>(event)
  const messages = body?.messages ?? []
  const ac = new AbortController()
  event.node.req.on('close', () => ac.abort())
  const res = event.node.res
  setResponseHeaders(event, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no'
  })
  res.flushHeaders()
  try {
    for await (const ev of runAgent(messages, { signal: ac.signal })) {
      if (ev.type === 'text-delta') res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ev.text } }] })}\n\n`)
    }
  } finally {
    res.write('data: [DONE]\n\n')
    res.end()
    event._handled = true
  }
})
