import type { ActivityKind } from './types'

const MAX_PART = 8_000   // per string/message content
const MAX_TOTAL = 32_000 // per request/response blob (JSON length)
const SECRET_KEYS = new Set(['apikey', 'api_key', 'authorization', 'auth', 'password', 'token', 'secret'])

export function truncate(s: string, max = MAX_PART): string {
  if (s.length <= max) return s
  return s.slice(0, max) + `…truncated(${s.length - max} more chars)`
}

// Looks like an embedding vector array? (number[] or number[][])
function isVectorish(v: unknown): boolean {
  if (!Array.isArray(v) || v.length === 0) return false
  const first = v[0]
  if (typeof first === 'number') return v.length > 16
  if (Array.isArray(first)) return typeof first[0] === 'number'
  return false
}

function scrub(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return truncate(value)
  if (isVectorish(value)) {
    const arr = value as unknown[]
    const dim = Array.isArray(arr[0]) ? (arr[0] as unknown[]).length : arr.length
    return { _vector: true, dim, count: Array.isArray(arr[0]) ? arr.length : 1 }
  }
  if (Array.isArray(value)) return depth > 4 ? '[…]' : value.map(v => scrub(v, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEYS.has(k.toLowerCase())) continue // never log secrets
      out[k] = depth > 4 ? '[…]' : scrub(v, depth + 1)
    }
    return out
  }
  return value
}

function cap(value: unknown): unknown {
  const json = JSON.stringify(value)
  if (json !== undefined && json.length > MAX_TOTAL) {
    return { _truncated: true, preview: truncate(json, MAX_TOTAL) }
  }
  return value
}

/** Sanitize a captured request payload by kind. Embedding inputs collapse to text+count. */
export function sanitizeRequest(kind: ActivityKind, req: unknown): unknown {
  if (req && typeof req === 'object' && 'inputs' in (req as Record<string, unknown>)) {
    const inputs = (req as { inputs: unknown }).inputs
    if (Array.isArray(inputs)) {
      return { count: inputs.length, sample: truncate(String(inputs[0] ?? ''), 500) }
    }
  }
  return cap(scrub(req))
}

/** Sanitize a captured response. Embedding vectors collapse to {dim,count}. */
export function sanitizeResponse(res: unknown): unknown {
  const r = res as Record<string, unknown> | undefined
  const data = r?.data ?? r?.embeddings
  if (Array.isArray(data) && isVectorish(data)) {
    const dim = Array.isArray(data[0]) ? (data[0] as unknown[]).length : data.length
    return { dim, count: Array.isArray(data[0]) ? data.length : 1, usage: r?.usage ?? null }
  }
  return cap(scrub(res))
}
