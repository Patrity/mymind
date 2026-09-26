// TypeSafe System One ("Jev") — a non-autoregressive decision model. One POST answers a set
// of named questions about a piece of text at once; extra questions are effectively
// latency-free, which is why the caller asks four rather than one.
//
// Separate from the `withFailover` model registry on purpose: this is not a chat completion
// and has no fallback chain. If Jev is unreachable the caller leaves the memory unscored,
// which the review queue already treats as "unknown" rather than "bad".

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone'

/** Pinned, never `jev-latest` — a silent model bump would invalidate stored scores. */
export const JEV_MODEL = 'jev-1.13.0'

export interface NoulAnswer { type: 'noul', noul: number }

export class JevNotConfiguredError extends Error {
  constructor() { super('JEV_KEY is not set') }
}

/**
 * Ask Jev a set of Noul questions about `state`.
 *
 * Retries only on 429, honouring `retry-after` when present and otherwise backing off
 * exponentially. Every other failure throws to the caller — a 4xx means the request shape
 * is wrong and retrying would just repeat it.
 */
export async function askJev(
  state: string,
  questions: Record<string, { type: string, instructions: string }>,
  opts: { key?: string, model?: string, attempt?: number } = {}
): Promise<Record<string, NoulAnswer>> {
  const key = opts.key ?? process.env.JEV_KEY
  if (!key) throw new JevNotConfiguredError()
  const attempt = opts.attempt ?? 0

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, model: opts.model ?? JEV_MODEL, questions })
  })

  if (res.status === 429 && attempt < 5) {
    const retryAfter = Number(res.headers.get('retry-after') ?? 0) * 1000
    await new Promise(r => setTimeout(r, retryAfter || 2 ** attempt * 500))
    return askJev(state, questions, { ...opts, attempt: attempt + 1 })
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
