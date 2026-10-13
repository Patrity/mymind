/**
 * Embeddings adapter.
 *
 * Primary: the OpenAI-compatible endpoint, POST {baseURL}/embeddings with
 * { model, input } → { data: [{ embedding, index }] }. This is what LiteLLM serves, so
 * embeddings route through the gateway like every other usage.
 *
 * Fallback: TEI's native POST {baseURL}/embed with { inputs, normalize } → number[][].
 * Used only when the OpenAI route 404s — i.e. a provider pointed straight at a TEI root
 * (TEI serves its OpenAI route under /v1, not at the root).
 *
 * Both paths return the same normalized vectors: LiteLLM → TEI was verified byte-identical
 * to /embed, so stored vectors stay comparable across the switch.
 */

import { ofetch } from 'ofetch'
import { withFailover } from './registry/resolve'
import { currentEvalScope } from '../eval/context'

const DIM = 2560

/** Normalize defensively: unwrap known envelope shapes, fall back to raw value. */
export function normalizeResponse(raw: unknown): number[][] {
  if (Array.isArray(raw)) return raw as number[][]
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>
    if (Array.isArray(r.embeddings)) return r.embeddings as number[][]
    if (Array.isArray(r.data)) {
      const data = r.data as unknown[]
      // OpenAI shape: [{ embedding, index }] — order by index, not arrival
      if (data.every(d => d !== null && typeof d === 'object' && Array.isArray((d as { embedding?: unknown }).embedding))) {
        return (data as Array<{ embedding: number[], index?: number }>)
          .map((d, i) => ({ v: d.embedding, i: d.index ?? i }))
          .sort((a, b) => a.i - b.i)
          .map(d => d.v)
      }
      return data as number[][]
    }
  }
  throw new Error(`Unexpected embeddings response shape: ${JSON.stringify(raw)}`)
}

/** One embeddings request against a resolved model: OpenAI route, TEI /embed fallback on 404. */
export async function requestEmbeddings(
  m: { baseURL: string | null, apiKey: string | null, modelId?: string },
  texts: string[],
  opts: { signal?: AbortSignal } = {}
): Promise<number[][]> {
  const base = (m.baseURL ?? '').replace(/\/$/, '')
  const headers = m.apiKey ? { authorization: `Bearer ${m.apiKey}` } : undefined
  try {
    const raw = await ofetch(`${base}/embeddings`, {
      method: 'POST', headers, signal: opts.signal,
      body: { model: m.modelId, input: texts }
    })
    return normalizeResponse(raw)
  } catch (err) {
    const e = err as { statusCode?: number, status?: number, response?: { status?: number } }
    if ((e.statusCode ?? e.status ?? e.response?.status) !== 404) throw err
  }
  const raw = await ofetch(`${base}/embed`, {
    method: 'POST', headers, signal: opts.signal,
    body: { inputs: texts, normalize: true }
  })
  return normalizeResponse(raw)
}

export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []
  // Cycle 85: an eval world embeds locally (deterministic, no rig call) — its memories and docs
  // live in the tenant and are recalled against each other only.
  const scope = currentEvalScope()
  if (scope) return scope.embed(texts)

  const vectors = await withFailover('embeddings', m => requestEmbeddings(m, texts))

  for (const v of vectors) {
    if (!Array.isArray(v) || v.length !== DIM) {
      throw new Error(
        `embedding dim mismatch: expected ${DIM}, got ${Array.isArray(v) ? v.length : typeof v}`
      )
    }
  }

  return vectors
}

export async function embedOne(text: string): Promise<number[]> {
  const vectors = await embed([text])
  if (!vectors[0]) throw new Error('embed returned no vectors')
  return vectors[0]
}
