// server/lib/ai/chat.ts
import { withFailover } from './registry/resolve'
import type { Usage } from './registry/types'

export interface TextPart { type: 'text', text: string }
export interface ImageUrlPart { type: 'image_url', image_url: { url: string } }
export type ContentPart = TextPart | ImageUrlPart

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ContentPart[]
}

// `role` here is a registry Usage (e.g. 'bulk', 'vision').
export async function chat(
  role: Usage,
  messages: ChatMessage[],
  opts: { temperature?: number, maxTokens?: number } = {}
): Promise<string> {
  return withFailover(role, async (m) => {
    const res = await $fetch<{ choices: { message: { content: string } }[] }>(
      `${(m.baseURL ?? '').replace(/\/$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: m.apiKey ? { authorization: `Bearer ${m.apiKey}` } : undefined,
        signal: AbortSignal.timeout(60000),
        body: { model: m.modelId, messages, temperature: opts.temperature ?? 0.2, max_tokens: opts.maxTokens ?? 600 }
      }
    )
    return res.choices?.[0]?.message?.content ?? ''
  })
}
