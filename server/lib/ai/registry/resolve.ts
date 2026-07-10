// server/lib/ai/registry/resolve.ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import { decryptSecret } from './crypto'
import { AiNotConfiguredError, AiAllFailedError } from './errors'
import { EMBEDDING_DIM, type AiConfigDoc, type ResolvedModel, type Usage } from './types'
import { recordEvent as defaultRecord } from '../../observability/record'
import type { SpanInput } from '../../observability/types'

// Minimal seam so tests can inject without DB. Default = the app recorder.
interface ObsSeam { recordEvent: (e: SpanInput) => void }
const realObs: ObsSeam = { recordEvent: defaultRecord }

function providerHost(baseURL: string | null): string {
  if (!baseURL) return '(none)'
  try { return new URL(baseURL).host } catch { return baseURL }
}

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

/** Pure: move the chosen model to the front (chosen = primary; the rest stay as failover). */
export function reorderChain(chain: ResolvedModel[], modelDefId?: string | null): ResolvedModel[] {
  if (!modelDefId) return chain
  const idx = chain.findIndex(m => m.modelDefId === modelDefId)
  if (idx <= 0) return chain
  return [chain[idx]!, ...chain.slice(0, idx), ...chain.slice(idx + 1)]
}

/** Pure: run fn against each model in order until one succeeds. */
export async function withFailoverOver<T>(
  usage: Usage,
  chain: ResolvedModel[],
  fn: (m: ResolvedModel) => Promise<T>,
  obs: ObsSeam = realObs
): Promise<T> {
  const attempts: { label: string; error: string }[] = []
  for (let i = 0; i < chain.length; i++) {
    const m = chain[i]!
    const started = Date.now()
    try {
      const out = await fn(m)
      obs.recordEvent({
        kind: 'attempt', name: `${usage}:${m.label}`, status: 'ok', severity: 'info',
        usage, provider: `${m.label}@${providerHost(m.baseURL)}`, modelId: m.modelId,
        attempt: i, durationMs: Date.now() - started
      })
      return out
    } catch (err) {
      const message = (err as Error).message
      attempts.push({ label: m.label, error: message })
      obs.recordEvent({
        kind: 'attempt', name: `${usage}:${m.label}`, status: 'error', severity: 'warn',
        usage, provider: `${m.label}@${providerHost(m.baseURL)}`, modelId: m.modelId,
        attempt: i, durationMs: Date.now() - started, error: { message }
      })
    }
  }
  obs.recordEvent({
    kind: 'model', name: `${usage}:all-failed`, status: 'error', severity: 'error',
    usage, error: { message: `all ${chain.length} models failed`, cause: JSON.stringify(attempts) }
  })
  throw new AiAllFailedError(usage, attempts)
}

/**
 * Build an AI SDK language model (used by reasoning/bulk/vision LLM roles).
 * All providers are OpenAI-compatible — non-OpenAI vendors (e.g. Anthropic) are
 * fronted by an OpenAI-compatible gateway (LiteLLM), so there's a single transport.
 */
export function languageModel(m: ResolvedModel): LanguageModel {
  return createOpenAICompatible({
    name: `mymind-${m.usage}`,
    baseURL: (m.baseURL ?? '').replace(/\/$/, ''),
    apiKey: m.apiKey || 'none'
  })(m.modelId)
}

import { loadConfig } from './store'

/** Cached: ordered decrypted chain for a usage (loads the doc once). */
export async function resolveChain(usage: Usage): Promise<ResolvedModel[]> {
  return resolveChainFrom(await loadConfig(), usage)
}

/** Cached: run fn against the usage's chain with failover. */
export async function withFailover<T>(usage: Usage, fn: (m: ResolvedModel) => Promise<T>): Promise<T> {
  return withFailoverOver(usage, await resolveChain(usage), fn)
}
