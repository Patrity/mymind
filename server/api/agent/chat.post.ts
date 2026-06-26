// server/api/agent/chat.post.ts
import { runAgent, type AgentMessage } from '../../lib/agent/run'

// Session-authed (middleware). Streams plain text deltas as SSE `data:` lines.
// TEXT-ONLY: this headless path forwards only `text-delta`; it does NOT apply the
// server-authored image embed (that lives in the WS orchestrator, see
// server/lib/voice/orchestrator.ts + lib/agent/image-embed.ts). image tools
// (generate_image/edit_image) return no URL to the model, so over THIS endpoint an
// image is created + searchable but is not rendered inline. If a UI is ever wired to
// this endpoint, fold in applyImageEmbeds from the tool-result `display` channel first.
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
    for await (const ev of runAgent(messages, { signal: ac.signal, speak: false })) {
      if (ev.type === 'text-delta') res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ev.text } }] })}\n\n`)
    }
  } finally {
    res.write('data: [DONE]\n\n')
    res.end()
    event._handled = true
  }
})
