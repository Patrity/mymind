const ALLOWED_SCOPES = new Set(['user', 'agent', 'world'])

export interface MemoryCandidate {
  scope: 'user' | 'agent' | 'world'
  content: string
  tags?: string[]
  confidence?: number
  evidenceMsgIds?: string[]
  quote?: string
  reasoning?: string
}

/**
 * Strip ```json fences, find the JSON (expect `{ "memories": [...] }` OR a bare
 * array), parse tolerantly, validate each item. Returns [] on total failure —
 * never throws.
 */
export function parseMemories(raw: string): MemoryCandidate[] {
  if (!raw || !raw.trim()) return []

  try {
    // Strip ```json ... ``` or ``` ... ``` fences
    let text = raw.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim()

    // Try to find a JSON array first (bare array form)
    // Then try an object with "memories" key
    const arrayStart = text.indexOf('[')
    const objectStart = text.indexOf('{')

    let items: unknown[] | null = null

    // Prefer the token that appears first
    if (objectStart !== -1 && (arrayStart === -1 || objectStart < arrayStart)) {
      // Try object form first — find matching closing brace
      const jsonStr = extractBalanced(text, objectStart, '{', '}')
      if (jsonStr) {
        try {
          const parsed = JSON.parse(jsonStr) as Record<string, unknown>
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray(parsed.memories)) {
            items = parsed.memories as unknown[]
          }
        } catch {
          // fall through to array extraction
        }
      }
      // If object parse failed or no memories key, try bare array
      if (!items && arrayStart !== -1) {
        const arrStr = extractBalanced(text, arrayStart, '[', ']')
        if (arrStr) {
          try {
            const parsed = JSON.parse(arrStr)
            if (Array.isArray(parsed)) items = parsed
          } catch {
            // give up
          }
        }
      }
    } else if (arrayStart !== -1) {
      // Array comes first or no object
      const arrStr = extractBalanced(text, arrayStart, '[', ']')
      if (arrStr) {
        try {
          const parsed = JSON.parse(arrStr)
          if (Array.isArray(parsed)) {
            items = parsed
          } else if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            // Unlikely but handle if somehow we extracted an object instead
            const obj = parsed as Record<string, unknown>
            if (Array.isArray(obj.memories)) items = obj.memories as unknown[]
          }
        } catch {
          // fall through
        }
      }
      // If array extraction got us an object's memories, great. If nothing, try object
      if (!items && objectStart !== -1) {
        const jsonStr = extractBalanced(text, objectStart, '{', '}')
        if (jsonStr) {
          try {
            const parsed = JSON.parse(jsonStr) as Record<string, unknown>
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray(parsed.memories)) {
              items = parsed.memories as unknown[]
            }
          } catch {
            // give up
          }
        }
      }
    }

    if (!items) return []

    return items.flatMap((item): MemoryCandidate[] => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return []
      const obj = item as Record<string, unknown>

      // content must be a non-empty string
      if (typeof obj.content !== 'string' || !obj.content.trim()) return []
      const content = obj.content.trim()

      // scope: default to 'agent' if missing/invalid
      const rawScope = obj.scope
      const scope: 'user' | 'agent' | 'world' = (typeof rawScope === 'string' && ALLOWED_SCOPES.has(rawScope))
        ? (rawScope as 'user' | 'agent' | 'world')
        : 'agent'

      // tags: string[] or undefined; coerce single string; filter non-strings
      let tags: string[] | undefined
      if (obj.tags !== undefined) {
        if (typeof obj.tags === 'string') {
          tags = [obj.tags]
        } else if (Array.isArray(obj.tags)) {
          tags = obj.tags.filter((t): t is string => typeof t === 'string')
        }
        // other types → leave as undefined
      }

      // confidence: clamp to 0..1; drop if present and < 0.6
      let confidence: number | undefined
      if (typeof obj.confidence === 'number' && !isNaN(obj.confidence)) {
        confidence = Math.min(1, Math.max(0, obj.confidence))
        if (confidence < 0.6) return []
      }

      // evidence_msg_ids: array of strings, filter non-strings
      let evidenceMsgIds: string[] | undefined
      if (Array.isArray(obj.evidence_msg_ids)) {
        const filtered = obj.evidence_msg_ids.filter((x): x is string => typeof x === 'string')
        if (filtered.length > 0) evidenceMsgIds = filtered
      }

      // quote: string, trimmed, sliced to 280 chars
      let quote: string | undefined
      if (typeof obj.quote === 'string') {
        const trimmed = obj.quote.trim().slice(0, 280)
        if (trimmed) quote = trimmed
      }

      // reasoning: string, trimmed, sliced to 500 chars
      let reasoning: string | undefined
      if (typeof obj.reasoning === 'string') {
        const trimmed = obj.reasoning.trim().slice(0, 500)
        if (trimmed) reasoning = trimmed
      }

      return [{
        scope,
        content,
        ...(tags !== undefined ? { tags } : {}),
        ...(confidence !== undefined ? { confidence } : {}),
        ...(evidenceMsgIds !== undefined ? { evidenceMsgIds } : {}),
        ...(quote !== undefined ? { quote } : {}),
        ...(reasoning !== undefined ? { reasoning } : {})
      }]
    })
  } catch {
    return []
  }
}

/** Extract a balanced bracket sequence starting at `from`. */
function extractBalanced(text: string, from: number, open: string, close: string): string | null {
  let depth = 0
  let end = -1
  for (let i = from; i < text.length; i++) {
    if (text[i] === open) depth++
    else if (text[i] === close) {
      depth--
      if (depth === 0) { end = i; break }
    }
  }
  if (end === -1) return null
  return text.slice(from, end + 1)
}
