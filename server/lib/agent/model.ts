// server/lib/agent/model.ts
import type { LanguageModel } from 'ai'
import { resolveChain, languageModel } from '../ai/registry/resolve'

/**
 * Ordered AI SDK language models for the reasoning role (registry-configured).
 * runAgent tries them in order at stream start (start-only failover).
 */
export async function reasoningModels(): Promise<LanguageModel[]> {
  const chain = await resolveChain('reasoning')
  return chain.map(languageModel)
}
