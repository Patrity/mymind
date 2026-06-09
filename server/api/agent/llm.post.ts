// server/api/agent/llm.post.ts
import { runAgentLoop } from '../../lib/agent/loop'
import { textChunk, doneFrame } from '../../lib/agent/openai-chunk'
import { publishActivity } from '../../lib/agent/bus'
import { isPrivateAddress } from '../../utils/net'
import type { ChatMessage } from '../../lib/ai/chat'

// OpenAI /v1/chat/completions-shaped endpoint that Unmute's LLM points at.
// AUTH: none (Unmute is keyless) — defended by a private-address guard + a proxy
// allow-list. NEVER expose this route publicly; it can mutate data.
export default defineEventHandler(async (event) => {
  const ip = getRequestIP(event, { xForwardedFor: true })
  if (!isPrivateAddress(ip)) {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden (LAN only)' })
  }

  const body = await readBody<{ messages?: ChatMessage[]; stream?: boolean }>(event)
  const messages = body?.messages ?? []

  // AbortSignal so barge-in (Unmute closing the request) cancels model + tools.
  const ac = new AbortController()
  event.node.req.on('close', () => ac.abort())

  publishActivity({ type: 'state', state: 'thinking' })

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
  } catch (err) {
    if (!ac.signal.aborted) console.error('[agent/llm] loop error:', err)
  } finally {
    res.write(doneFrame())
    res.end()
    event._handled = true
  }
})
