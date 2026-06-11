/**
 * TEI (Text Embeddings Inference) adapter.
 *
 * TEI native endpoint: POST /embed
 * Expected request body: { inputs: string[], normalize?: boolean }
 * Expected response:     number[][] (one vector per input)
 *
 * Assumption: TEI returns a bare number[][] at the top level.
 * If the real rig returns an envelope (e.g. { embeddings: [...] }), Task 4
 * will catch the dim-mismatch error and the normalization below can be adjusted.
 */

import { withFailover } from './registry/resolve'

const DIM = 2560

/** Normalize defensively: unwrap known envelope shapes, fall back to raw value. */
function normalizeResponse(raw: unknown): number[][] {
  if (Array.isArray(raw)) return raw as number[][]
  // Some servers wrap under { embeddings: [...] } or { data: [...] }
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>
    if (Array.isArray(r.embeddings)) return r.embeddings as number[][]
    if (Array.isArray(r.data)) return r.data as number[][]
  }
  throw new Error(`Unexpected embeddings response shape: ${JSON.stringify(raw)}`)
}

export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []

  const vectors = await withFailover('embeddings', async (m) => {
    const raw = await $fetch(`${(m.baseURL ?? '').replace(/\/$/, '')}/embed`, {
      method: 'POST',
      headers: m.apiKey ? { authorization: `Bearer ${m.apiKey}` } : undefined,
      body: { inputs: texts, normalize: true }
    })
    return normalizeResponse(raw)
  })

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
