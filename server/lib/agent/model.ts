// server/lib/agent/model.ts
import type { LanguageModel } from 'ai'
import { resolveChain, reorderChain, languageModel } from '../ai/registry/resolve'

/**
 * Ordered AI SDK language models for the reasoning role (registry-configured).
 * runAgent tries them in order at stream start (start-only failover). An optional
 * modelDefId reorders the chain so that model is tried first (chosen = primary;
 * the rest stay as failover) — an ephemeral, connection-level override.
 */
export async function reasoningModels(modelDefId?: string | null): Promise<LanguageModel[]> {
  const chain = reorderChain(await resolveChain('reasoning'), modelDefId)
  return chain.map(languageModel)
}
