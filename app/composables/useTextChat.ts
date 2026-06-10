// app/composables/useTextChat.ts
import type { TranscriptEntry } from './useVoice'

// Posts to /api/agent/chat and appends streamed assistant text to `entries`.
// Parses OpenAI-compatible SSE chunks (choices[0].delta.content).
export async function textStreamToTranscript(entries: TranscriptEntry[]): Promise<void> {
  const res = await fetch('/api/agent/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: entries.map(e => ({ role: e.role, content: e.text })) })
  })
  if (!res.body) return
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  entries.push({ role: 'assistant', text: '' })
  const target = entries[entries.length - 1]!
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const t = line.trim()
      if (!t.startsWith('data:')) continue
      const payload = t.slice(5).trim()
      if (payload === '[DONE]') return
      try {
        const obj = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] }
        const c = obj.choices?.[0]?.delta?.content
        if (c) target.text += c
      } catch { /* ignore */ }
    }
  }
}
