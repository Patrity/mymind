export type AiRole = 'reasoning' | 'bulk' | 'embeddings' | 'vision' | 'stt' | 'tts'
export interface AiClient { baseURL?: string, apiKey?: string, model?: string }

// OpenAI-spec endpoint config per role, env-driven. Cycle 2 adds the actual chat/embed calls.
export function aiProvider(role: AiRole, opts: { required?: boolean } = {}): AiClient {
  const cfg = (useRuntimeConfig().ai as Record<AiRole, AiClient>)[role] ?? {}
  if (opts.required && !cfg.baseURL) {
    throw new Error(`AI role "${role}" is not configured (set AI_${role.toUpperCase()}_BASE_URL)`)
  }
  return cfg
}
