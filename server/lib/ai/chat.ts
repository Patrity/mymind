import { aiProvider, type AiRole } from './provider'

/** A single content part for vision messages (OpenAI spec). */
export interface TextPart { type: 'text', text: string }
export interface ImageUrlPart { type: 'image_url', image_url: { url: string } }
export type ContentPart = TextPart | ImageUrlPart

/** Message with either a plain string or structured content parts (for vision). */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ContentPart[]
}

export async function chat(
  role: AiRole,
  messages: ChatMessage[],
  opts: { temperature?: number, maxTokens?: number } = {}
): Promise<string> {
  const cfg = aiProvider(role, { required: true })
  const res = await $fetch<{ choices: { message: { content: string } }[] }>(
    `${cfg.baseURL!.replace(/\/$/, '')}/chat/completions`,
    {
      method: 'POST',
      headers: cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : undefined,
      signal: AbortSignal.timeout(60000),
      body: {
        model: cfg.model,
        messages,
        temperature: opts.temperature ?? 0.2,
        max_tokens: opts.maxTokens ?? 600
      }
    }
  )
  return res.choices?.[0]?.message?.content ?? ''
}
