// TypeSafe System One ("Jev") — a non-autoregressive decision model. One POST answers a set
// of named questions about a piece of text at once; extra questions are effectively
// latency-free, which is why the caller asks four rather than one.
//
// The credential lives in the AI config like every other model's, resolved through
// `resolveChain('jev')` — same path `rerank` takes. It is deliberately NOT read from an env
// file: that would have made Jev the one model secret not editable from Settings.
//
// It does not go through `withFailover`, though: this is not a chat completion and has no
// fallback chain. When Jev is unconfigured or unreachable the caller leaves the memory
// unscored, which the review queue already renders as "unknown" rather than "bad".

import { resolveChain } from './registry/resolve'

/** Default when the config carries no explicit model id. Pinned, never `jev-latest` — a
 *  silent model bump would invalidate every stored score it is compared against. */
export const JEV_MODEL = 'jev-1.13.0'

const DEFAULT_BASE_URL = 'https://api.typesafe.ai/v1'

export interface NoulAnswer { type: 'noul', noul: number }

export interface JevConfig { baseURL: string, apiKey: string, model: string }

export class JevNotConfiguredError extends Error {
  constructor() { super('No `jev` model is assigned in the AI config') }
}

/**
 * Resolve Jev's endpoint + key from the AI config, or null when nothing is assigned.
 *
 * Null rather than throwing, because "not configured" is a normal state the scoring task
 * reports as `skipped` — Jev is an optional second opinion, not a dependency.
 */
export async function jevConfig(): Promise<JevConfig | null> {
  try {
    const [m] = await resolveChain('jev')
    if (!m) return null
    return {
      baseURL: (m.baseURL ?? DEFAULT_BASE_URL).replace(/\/$/, ''),
      apiKey: m.apiKey ?? '',
      model: m.modelId || JEV_MODEL
    }
  } catch {
    return null  // AiNotConfiguredError → Jev stays off
  }
}

/**
 * Ask Jev a set of Noul questions about `state`.
 *
 * Retries only on 429, honouring `retry-after` when present and otherwise backing off
 * exponentially. Every other failure throws — a 4xx means the request shape is wrong and
 * retrying would just repeat it.
 */
export async function askJev(
  state: string,
  questions: Record<string, { type: string, instructions: string }>,
  cfg: JevConfig,
  attempt = 0
): Promise<Record<string, NoulAnswer>> {
  const res = await fetch(`${cfg.baseURL}/systemone`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, model: cfg.model, questions })
  })

  if (res.status === 429 && attempt < 5) {
    const retryAfter = Number(res.headers.get('retry-after') ?? 0) * 1000
    await new Promise(r => setTimeout(r, retryAfter || 2 ** attempt * 500))
    return askJev(state, questions, cfg, attempt + 1)
  }
  if (!res.ok) throw new Error(`Jev ${res.status}: ${(await res.text()).slice(0, 200)}`)

  const body = await res.json() as { answers?: Record<string, NoulAnswer> }
  return body.answers ?? {}
}

/** Flatten `{ transient: { type:'noul', noul: 0.8 } }` → `{ transient: 0.8 }`. */
export function nouls(answers: Record<string, NoulAnswer>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(answers)) {
    if (v && v.type === 'noul' && typeof v.noul === 'number') out[k] = v.noul
  }
  return out
}
