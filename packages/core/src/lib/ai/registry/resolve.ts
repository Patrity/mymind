// server/lib/ai/registry/resolve.ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import { decryptSecret } from './crypto'
import { AiNotConfiguredError, AiAllFailedError, UnknownSubagentModelError, type FailedAttempt } from './errors'
import { DEFAULT_MAX_IN_FLIGHT, EMBEDDING_DIM, type AiConfigDoc, type ResolvedModel, type Usage } from './types'
import { recordEvent as defaultRecord } from '../../observability/record'
import type { SpanInput } from '../../observability/types'

// Minimal seam so tests can inject without DB. Default = the app recorder.
interface ObsSeam { recordEvent: (e: SpanInput) => void }
const realObs: ObsSeam = { recordEvent: defaultRecord }

function providerHost(baseURL: string | null): string {
  if (!baseURL) return '(none)'
  try { return new URL(baseURL).host } catch { return baseURL }
}

/**
 * A cancelled call is the CALLER walking away (barge-in, a newer utterance, a closed
 * socket) — not a provider failing. Failing over would just re-dial the next provider
 * with the same dead signal, and recording it as an error made every barge-in look like
 * an outage. Node/undici's fetch surfaces this as `name === 'AbortError'`.
 */
function isAbort(err: unknown): boolean {
  return (err as Error | undefined)?.name === 'AbortError'
}

/** Pure: build the ordered, decrypted chain for a usage from a config doc. */
export function resolveChainFrom(doc: AiConfigDoc, usage: Usage): ResolvedModel[] {
  const chain = chainOf(doc, usage)
  if (chain.length === 0) throw new AiNotConfiguredError(usage)
  return chain
}

/** The chain for a usage, empty when nothing usable is assigned. */
function chainOf(doc: AiConfigDoc, usage: Usage): ResolvedModel[] {
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
      apiKey, modelId: m.modelId, label: m.label, dim: m.dim, contextWindow: m.contextWindow ?? null
    })
  }
  // Embeddings can't fail over to a different dimension — keep only 2560.
  if (usage === 'embeddings') chain = chain.filter(m => m.dim === EMBEDDING_DIM)
  return chain
}

/**
 * Pure: the ordered failover chain for a child workstream (cycle 83, spec §3): the `subagents`
 * model labelled `label` (no label = the first one), then the rest of `subagents` in order, then
 * the `reasoning` chain. Empty `subagents` → `reasoning` alone. A model listed under both is tried
 * once, at its first position. The head is the child's primary model — its pool key.
 * Throws UnknownSubagentModelError for a label not in `subagents`.
 */
export function resolveSubagentChainFrom(doc: AiConfigDoc, label?: string | null): ResolvedModel[] {
  let subs = chainOf(doc, 'subagents')
  const want = label?.trim()
  if (want) {
    const i = subs.findIndex(m => m.label === want)
    if (i < 0) throw new UnknownSubagentModelError(want, subs.map(m => m.label))
    subs = [subs[i]!, ...subs.slice(0, i), ...subs.slice(i + 1)]
  }
  const seen = new Set<string>()
  const chain = [...subs, ...chainOf(doc, 'reasoning')].filter(m => !seen.has(m.modelDefId) && !!seen.add(m.modelDefId))
  if (chain.length === 0) throw new AiNotConfiguredError('reasoning')
  return chain
}

/**
 * Pure: the approval judge / output guard chain (cycle 84, spec D1): the `judge` models in order,
 * with ordinary failover between them. Empty `judge` → the `reasoning` chain (self-consistency).
 * Embedding models are skipped — they cannot answer a prompt.
 */
export function resolveJudgeChainFrom(doc: AiConfigDoc): ResolvedModel[] {
  const judge = chainOf(doc, 'judge').filter(m => m.dim === null)
  const chain = judge.length ? judge : chainOf(doc, 'reasoning')
  if (chain.length === 0) throw new AiNotConfiguredError('reasoning')
  return chain
}

export interface SubagentModelInfo { label: string; description: string | null; maxInFlight: number }

/** Pure: the `subagents` list as the coordinator's tool description shows it, in order. */
export function listSubagentModelsFrom(doc: AiConfigDoc): SubagentModelInfo[] {
  return (doc.assignments.subagents ?? []).flatMap((id) => {
    const m = doc.models.find(x => x.id === id)
    return m ? [{ label: m.label, description: m.description ?? null, maxInFlight: m.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT }] : []
  })
}

/** Pure: move the chosen model to the front (chosen = primary; the rest stay as failover). */
export function reorderChain(chain: ResolvedModel[], modelDefId?: string | null): ResolvedModel[] {
  if (!modelDefId) return chain
  const idx = chain.findIndex(m => m.modelDefId === modelDefId)
  if (idx <= 0) return chain
  return [chain[idx]!, ...chain.slice(0, idx), ...chain.slice(idx + 1)]
}

/** The HTTP status carried by a thrown fetch error (ofetch's FetchError: statusCode/status), if any. */
export function httpStatusOf(err: unknown): number | undefined {
  const e = err as { statusCode?: unknown, status?: unknown, response?: { status?: unknown } } | null
  const s = e?.statusCode ?? e?.status ?? e?.response?.status
  return typeof s === 'number' && s >= 100 && s < 600 ? s : undefined
}

/** Pure: run fn against each model in order until one succeeds. */
export async function withFailoverOver<T>(
  usage: Usage,
  chain: ResolvedModel[],
  fn: (m: ResolvedModel) => Promise<T>,
  obs: ObsSeam = realObs
): Promise<T> {
  const attempts: FailedAttempt[] = []
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
      // Cancellation short-circuits the chain and rethrows the ORIGINAL error, so the
      // `err.name === 'AbortError'` guards in orchestrator.ts/ws.ts still fire. Wrapping
      // it in AiAllFailedError used to defeat them, surfacing a bogus "all models failed"
      // error frame to the client on every barge-in.
      if (isAbort(err)) {
        obs.recordEvent({
          kind: 'attempt', name: `${usage}:${m.label}`, status: 'warn', severity: 'info',
          usage, provider: `${m.label}@${providerHost(m.baseURL)}`, modelId: m.modelId,
          attempt: i, durationMs: Date.now() - started, error: { message }, meta: { cancelled: true }
        })
        throw err
      }
      const status = httpStatusOf(err)
      attempts.push({ label: m.label, error: message, ...(status ? { status } : {}) })
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
 * Build an AI SDK language model. All providers are OpenAI-compatible — non-OpenAI
 * vendors (e.g. Anthropic) are fronted by an OpenAI-compatible gateway (LiteLLM), so
 * there's a single transport.
 *
 * The streaming caller is reasoningChain() (server/lib/agent/model.ts), consumed by run.ts's
 * streamText() calls — bulk/vision go through chat.ts's raw REST fetch, and embeddings/stt/tts
 * have their own raw-fetch adapters, none of which touch this function. The other caller is the
 * cycle 84 judge (agent/judge/verdict.ts), a NON-streaming generateText, so `includeUsage: true`
 * is still scoped to the streaming agent chat path: the AI SDK only turns it into an outbound
 * `stream_options` field on a streaming call (openai-compatible/dist). It's what makes the transcript's per-turn token count (conversation_messages
 * .usage) possible — without it, the provider never reports usage and run.ts's
 * partToUsageEvent() has nothing to read, no matter what the client does with it.
 */
export function languageModel(m: ResolvedModel, opts: { structuredOutputs?: boolean } = {}): LanguageModel {
  return createOpenAICompatible({
    name: `mymind-${m.usage}`,
    baseURL: (m.baseURL ?? '').replace(/\/$/, ''),
    apiKey: m.apiKey || 'none',
    includeUsage: true,
    // Cycle 84: the judge asks for a JSON-schema response (`response_format: json_schema`) —
    // vLLM and LiteLLM honour it. Off for everything else (the streaming agent path).
    ...(opts.structuredOutputs ? { supportsStructuredOutputs: true } : {})
  })(m.modelId)
}

import { loadConfig } from './store'

/** Cached: ordered decrypted chain for a usage (loads the doc once). */
export async function resolveChain(usage: Usage): Promise<ResolvedModel[]> {
  return resolveChainFrom(await loadConfig(), usage)
}

/** Cached: a child workstream's failover chain — see resolveSubagentChainFrom. */
export async function resolveSubagentModel(label?: string | null): Promise<ResolvedModel[]> {
  return resolveSubagentChainFrom(await loadConfig(), label)
}

/** Cached: the judge chain — see resolveJudgeChainFrom. */
export async function resolveJudgeChain(): Promise<ResolvedModel[]> {
  return resolveJudgeChainFrom(await loadConfig())
}

/** Cached: the `subagents` models (label, description, maxInFlight) for the coordinator's tools. */
export async function listSubagentModels(): Promise<SubagentModelInfo[]> {
  return listSubagentModelsFrom(await loadConfig())
}

/** Cached: run fn against the usage's chain with failover. */
export async function withFailover<T>(usage: Usage, fn: (m: ResolvedModel) => Promise<T>): Promise<T> {
  return withFailoverOver(usage, await resolveChain(usage), fn)
}
