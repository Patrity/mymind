// server/lib/agent/reflect/schema.ts
//
// The reflector's output contract, and a tolerant parser for what models actually send back:
// code fences, prose around the JSON, trailing commas, a bare array, or just "none". One bad
// item never sinks the others — invalid items are dropped individually. Nothing here throws.
import { z } from 'zod'

export const ProposalKind = z.enum(['skill.create', 'skill.edit', 'profile.edit', 'job.edit', 'job.disable'])

export const Proposal = z.object({
  kind: ProposalKind,
  target: z.string().min(1).max(80),
  content: z.string().max(8000).optional(),
  reason: z.string().min(1).max(600),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string().min(3).max(500)).min(1).max(5)
})
export type Proposal = z.infer<typeof Proposal>

/** At most this many proposals survive one pass. */
export const MAX_PROPOSALS = 3

export type ReflectorResult = { ok: true; proposals: Proposal[] } | { ok: false; error: string }

/** The first balanced `{...}` or `[...]` block, string- and escape-aware. Null when none closes. */
function firstJsonBlock(text: string): string | null {
  const start = text.search(/[{[]/)
  if (start < 0) return null
  const stack: string[] = []
  let inString = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') stack.push('}')
    else if (ch === '[') stack.push(']')
    else if (ch === '}' || ch === ']') {
      if (stack.pop() !== ch) return null
      if (!stack.length) return text.slice(start, i + 1)
    }
  }
  return null
}

function parseLenient(block: string): unknown {
  try {
    return JSON.parse(block)
  } catch {
    // The one malformation models commonly produce. Only tried after a strict parse fails, so a
    // literal ",}" inside a valid string is never rewritten.
    return JSON.parse(block.replace(/,\s*([}\]])/g, '$1'))
  }
}

export function parseReflectorOutput(raw: string, allowed: Proposal['kind'][]): ReflectorResult {
  const text = (raw ?? '').replace(/```[a-zA-Z]*/g, '').trim()
  if (!text || /^(none|no proposals?)\b\.?/i.test(text)) return { ok: true, proposals: [] }

  const block = firstJsonBlock(text)
  if (!block) return { ok: false, error: 'reflector output contained no JSON' }
  let parsed: unknown
  try {
    parsed = parseLenient(block)
  } catch (err) {
    return { ok: false, error: `reflector output is not valid JSON: ${(err as Error).message}` }
  }

  const items = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { proposals?: unknown }).proposals))
        ? (parsed as { proposals: unknown[] }).proposals
        : null
  if (!items) return { ok: false, error: 'reflector output has no proposals array' }

  const proposals: Proposal[] = []
  for (const item of items) {
    const r = Proposal.safeParse(item)
    if (!r.success || !allowed.includes(r.data.kind)) continue
    proposals.push(r.data)
    if (proposals.length >= MAX_PROPOSALS) break
  }
  return { ok: true, proposals }
}
