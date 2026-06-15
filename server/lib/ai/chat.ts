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

interface ChatCompletion { choices?: { message?: { content?: string } }[] }

/**
 * Pull the assistant message out of an OpenAI-style completion, THROWING on any
 * unexpected shape (missing choices, empty content, or a non-JSON body — e.g. an
 * HTML error page returned with HTTP 200). Throwing is deliberate: `chat()` runs
 * inside `withFailover`, which only advances to the next model on a thrown error.
 * Returning '' here would look like success and silently strand the call on a
 * broken provider (this is exactly what masked a misconfigured provider before).
 */
export function extractContent(res: unknown): string {
  const content = (res as ChatCompletion)?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || content.trim() === '') {
    throw new Error('chat: model returned no usable content')
  }
  return content
}

// `role` here is a registry Usage (e.g. 'bulk', 'vision').
export async function chat(
  role: Usage,
  messages: ChatMessage[],
  opts: { temperature?: number, maxTokens?: number } = {}
): Promise<string> {
  return withFailover(role, async (m) => {
    const res = await $fetch<unknown>(
      `${(m.baseURL ?? '').replace(/\/$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: m.apiKey ? { authorization: `Bearer ${m.apiKey}` } : undefined,
        signal: AbortSignal.timeout(60000),
        body: { model: m.modelId, messages, temperature: opts.temperature ?? 0.2, max_tokens: opts.maxTokens ?? 600 }
      }
    )
    return extractContent(res)
  })
}
