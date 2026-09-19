// server/lib/agent/model.ts
import type { LanguageModel } from 'ai'
import { resolveChain, reorderChain, languageModel } from '../ai/registry/resolve'

/**
 * Ordered AI SDK language models for the reasoning role, each paired with the registry
 * modelDefId that produced it. runAgent tries them in order at stream start (start-only
 * failover). An optional modelDefId reorders the chain so that model is tried first
 * (chosen = primary; the rest stay as failover) — an ephemeral, connection-level override.
 * The modelDefId travels alongside the model so a usage report can stamp which registry
 * entry actually answered (failover-aware — see run.ts's `chosenId`).
 */
export async function reasoningChain(modelDefId?: string | null): Promise<{ model: LanguageModel; modelDefId: string }[]> {
  const chain = reorderChain(await resolveChain('reasoning'), modelDefId)
  return chain.map(m => ({ model: languageModel(m), modelDefId: m.modelDefId }))
}

/** Back-compat: just the models, in order. Prefer reasoningChain when the modelDefId matters. */
export async function reasoningModels(modelDefId?: string | null): Promise<LanguageModel[]> {
  return (await reasoningChain(modelDefId)).map(c => c.model)
}
