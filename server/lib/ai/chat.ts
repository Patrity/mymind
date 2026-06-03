import { aiProvider, type AiRole } from './provider'

export async function chat(
  role: AiRole,
  messages: { role: 'system' | 'user' | 'assistant', content: string }[],
  opts: { temperature?: number, maxTokens?: number } = {}
): Promise<string> {
  const cfg = aiProvider(role, { required: true })
  const res = await $fetch<{ choices: { message: { content: string } }[] }>(
    `${cfg.baseURL!.replace(/\/$/, '')}/chat/completions`,
    {
      method: 'POST',
      headers: cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : undefined,
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
