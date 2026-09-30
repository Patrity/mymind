// server/lib/agent/reflect/schema.ts
//
// The reflector's output contract, and a tolerant parser for what models actually send back:
// a wrapping code fence, prose around the JSON, trailing commas, a bare array, or just "none". One bad
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

/** A fence wrapping the WHOLE reply (```json … ```), unwrapped. Fences anywhere else are left
 *  alone: skill bodies and evidence quotes legitimately contain them inside JSON strings. */
function unwrapFence(text: string): string {
  const m = /^```[\w-]*[ \t]*\n?([\s\S]*?)\n?[ \t]*```$/.exec(text)
  return m ? m[1]!.trim() : text
}

/** The balanced `{...}` or `[...]` block starting at `start`, string- and escape-aware.
 *  Null when it never closes or a closer mismatches. */
function blockAt(text: string, start: number): string | null {
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

/** Drop commas that directly precede a `}` or `]`, outside strings only. */
function stripTrailingCommas(block: string): string {
  let out = ''
  let inString = false
  for (let i = 0; i < block.length; i++) {
    const ch = block[i]!
    if (inString) {
      out += ch
      if (ch === '\\') { out += block[i + 1] ?? ''; i++ }
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === ',' && /^\s*[}\]]/.test(block.slice(i + 1))) continue
    out += ch
  }
  return out
}

/** Strict parse, then once more with trailing commas removed. Throws only if both fail. */
function parseLenient(block: string): unknown {
  try {
    return JSON.parse(block)
  } catch {
    return JSON.parse(stripTrailingCommas(block))
  }
}

/** `{ proposals: [...] }` or a bare array of objects — anything else (e.g. a `[1]` in prose)
 *  is not the reply, and the scan moves on. */
function proposalItems(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed.every(x => x && typeof x === 'object' && !Array.isArray(x)) ? parsed : null
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { proposals?: unknown }).proposals)) {
    return (parsed as { proposals: unknown[] }).proposals
  }
  return null
}

export function parseReflectorOutput(raw: string, allowed: Proposal['kind'][]): ReflectorResult {
  const text = unwrapFence((raw ?? '').trim())
  if (!text || /^(none|no proposals?)\b\.?/i.test(text)) return { ok: true, proposals: [] }

  // Try each `{` / `[` in turn: prose before the JSON ("per the [user] request …") often
  // contains brackets that are not the reply.
  let items: unknown[] | null = null
  let error = 'reflector output contained no JSON'
  for (let start = text.search(/[{[]/); start >= 0 && !items; start = nextBracket(text, start + 1)) {
    const block = blockAt(text, start)
    if (!block) continue
    try {
      items = proposalItems(parseLenient(block))
      if (!items) error = 'reflector output has no proposals array'
    } catch (err) {
      error = `reflector output is not valid JSON: ${(err as Error).message}`
    }
  }
  if (!items) return { ok: false, error }

  const proposals: Proposal[] = []
  for (const item of items) {
    const r = Proposal.safeParse(item)
    if (!r.success || !allowed.includes(r.data.kind)) continue
    proposals.push(r.data)
    if (proposals.length >= MAX_PROPOSALS) break
  }
  return { ok: true, proposals }
}

function nextBracket(text: string, from: number): number {
  const i = text.slice(from).search(/[{[]/)
  return i < 0 ? -1 : from + i
}
