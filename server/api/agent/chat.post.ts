// server/api/agent/chat.post.ts
import { runAgentLoop } from '../../lib/agent/loop'
import { textChunk, doneFrame } from '../../lib/agent/openai-chunk'
import type { ChatMessage } from '../../lib/ai/chat'

// Session-authed. Streams the same OpenAI-chunk shape the client already parses
// from /api/agent/llm, so the page can reuse one stream reader for typed turns.
export default defineEventHandler(async (event) => {
  const body = await readBody<{ messages?: ChatMessage[] }>(event)
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
    for await (const ev of runAgentLoop(messages, { signal: ac.signal })) {
      if (ev.type === 'text-delta') res.write(textChunk(ev.text))
    }
  } finally {
    res.write(doneFrame())
    res.end()
    event._handled = true
  }
})
