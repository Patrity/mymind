// server/lib/ai/registry/resolve.ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createAnthropic } from '@ai-sdk/anthropic'
import type { LanguageModel } from 'ai'
import { decryptSecret } from './crypto'
import { AiNotConfiguredError, AiAllFailedError } from './errors'
import { EMBEDDING_DIM, type AiConfigDoc, type ResolvedModel, type Usage } from './types'

/** Pure: build the ordered, decrypted chain for a usage from a config doc. */
export function resolveChainFrom(doc: AiConfigDoc, usage: Usage): ResolvedModel[] {
  const ids = doc.assignments[usage] ?? []
  const providers = new Map(doc.providers.map(p => [p.id, p]))
  let chain: ResolvedModel[] = []
  for (const id of ids) {
    const m = doc.models.find(x => x.id === id)
    if (!m) continue
    const p = providers.get(m.providerId)
    if (!p) continue
    let apiKey: string | null = null
    if (p.apiKeyEnc) { try { apiKey = decryptSecret(p.apiKeyEnc) } catch { apiKey = null } }
    chain.push({
      usage, modelDefId: m.id, providerKind: p.kind, baseURL: p.baseURL,
      apiKey, modelId: m.modelId, label: m.label, dim: m.dim
    })
  }
  // Embeddings can't fail over to a different dimension — keep only 2560.
  if (usage === 'embeddings') chain = chain.filter(m => m.dim === EMBEDDING_DIM)
  if (chain.length === 0) throw new AiNotConfiguredError(usage)
  return chain
}

/** Pure: run fn against each model in order until one succeeds. */
export async function withFailoverOver<T>(usage: Usage, chain: ResolvedModel[], fn: (m: ResolvedModel) => Promise<T>): Promise<T> {
  const attempts: { label: string; error: string }[] = []
  for (const m of chain) {
    try { return await fn(m) }
    catch (err) { attempts.push({ label: m.label, error: (err as Error).message }) }
  }
  throw new AiAllFailedError(usage, attempts)
}

/** Build a kind-aware AI SDK language model (used by reasoning/bulk/vision LLM roles). */
export function languageModel(m: ResolvedModel): LanguageModel {
  if (m.providerKind === 'anthropic') {
    return createAnthropic({ apiKey: m.apiKey || undefined })(m.modelId)
  }
  return createOpenAICompatible({
    name: `mymind-${m.usage}`,
    baseURL: (m.baseURL ?? '').replace(/\/$/, ''),
    apiKey: m.apiKey || 'none'
  })(m.modelId)
}
