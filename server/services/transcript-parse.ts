import { createHash } from 'node:crypto'

export interface ParsedMessage {
  role: string | null
  /**
   * The line's own `timestamp`, as an ISO string — NOT a Date. stripNul and
   * clampStrings rebuild objects field by field, and a Date has no own enumerable
   * properties, so it would come out the far side as `{}`. Converted to a Date at
   * the insert site instead. Null when the line has none, letting the column
   * default (now()) stand.
   */
  createdAt: string | null
  content: string
  externalUuid: string | null
  parentUuid: string | null
  thinking: string | null
  model: string | null
  stopReason: string | null
  requestId: string | null
  isSidechain: boolean
  usage: Record<string, unknown> | null
  metadata: Record<string, unknown>
}

export interface ParsedToolEvent {
  toolUseId: string | null
  /** ISO string, same reasoning as ParsedMessage.createdAt. */
  createdAt: string | null
  parentExternalUuid: string | null
  toolName: string
  args: unknown
  result: unknown
  exitStatus: string | null
  phase: 'pre' | 'completed' | 'failed'
  callerType: string | null
  isSidechain: boolean
}

export interface ParsedTranscript {
  messages: ParsedMessage[]
  toolEvents: ParsedToolEvent[]
  inputTokens: number
  outputTokens: number
  toolCount: number
}

function extractText(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw)) {
    return raw
      .filter((p): p is Record<string, unknown> => p !== null && typeof p === 'object' && (p as Record<string, unknown>).type === 'text')
      .map(p => (p as Record<string, unknown>).text as string)
      .filter(t => typeof t === 'string')
      .join('\n')
  }
  return ''
}

function extractThinking(raw: unknown): string | null {
  if (!Array.isArray(raw)) return null
  const parts = raw
    .filter((p): p is Record<string, unknown> => p !== null && typeof p === 'object' && (p as Record<string, unknown>).type === 'thinking')
    .map(p => (p.thinking ?? p.text) as string)
    .filter(t => typeof t === 'string')
  return parts.length ? parts.join('\n') : null
}

/** CC stamps every line with an ISO `timestamp`; keep it only if it actually parses. */
function extractTimestamp(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null
  const t = Date.parse(raw)
  return Number.isNaN(t) ? null : raw
}

function syntheticUuid(role: string, content: string): string {
  return 'h:' + createHash('sha256').update(role + '|' + content).digest('hex').slice(0, 16)
}

/**
 * Recursively strip NUL (U+0000) from every string in a value. Postgres `text`
 * columns cannot store a raw NUL byte and `jsonb` rejects the `` escape
 * (SQLSTATE 22P05) — either one throws the whole insert. CC transcripts carry
 * NUL legitimately (binary tool output, or source code containing the literal
 * escape), so we scrub it here, the single choke point feeding every DB column.
 */
export function stripNul<T>(value: T): T {
  if (typeof value === 'string') return value.replace(/\u0000/g, '') as T
  if (Array.isArray(value)) return value.map(stripNul) as T
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = stripNul(v)
    return out as T
  }
  return value
}

/**
 * Cap on any single string reaching the DB. Transcript lines themselves are
 * accepted at full size (the parser needs valid JSON — see ingest-limits.ts),
 * so the size management happens here, on the parsed fields, where a 2 MB tool
 * result can be clamped without costing us the message that carried it.
 */
export const MAX_FIELD_CHARS = 200_000

/**
 * Recursively clamp every over-long string in a value, mirroring stripNul's
 * shape. Keeps the head (where the signal is) and says what was dropped, so a
 * truncated field reads as truncated rather than as the whole story.
 */
export function clampStrings<T>(value: T): T {
  if (typeof value === 'string') {
    if (value.length <= MAX_FIELD_CHARS) return value
    // Reserve room for the marker so MAX_FIELD_CHARS is a real cap on what we store.
    const marker = (n: number) => `… [truncated ${n} chars]`
    const keep = MAX_FIELD_CHARS - marker(value.length).length
    return (value.slice(0, keep) + marker(value.length - keep)) as T
  }
  if (Array.isArray(value)) return value.map(clampStrings) as T
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = clampStrings(v)
    return out as T
  }
  return value
}

/** Parse CC JSONL lines into rich messages + tool events. Tolerant: never throws. */
export function parseTranscriptLines(lines: string[]): ParsedTranscript {
  const messages: ParsedMessage[] = []
  const toolEvents: ParsedToolEvent[] = []
  const byToolUseId = new Map<string, ParsedToolEvent>()
  let inputTokens = 0
  let outputTokens = 0

  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>
      const msg = obj.message as Record<string, unknown> | undefined
      const rawRole = msg?.role ?? obj.role ?? obj.type
      const role = typeof rawRole === 'string' ? rawRole : null
      if (role !== 'user' && role !== 'assistant') continue

      const rawContent = msg?.content ?? obj.content ?? null
      const contentArray = Array.isArray(rawContent) ? rawContent as Record<string, unknown>[] : []
      const isSidechain = obj.isSidechain === true

      const usage = (msg?.usage && typeof msg.usage === 'object') ? msg.usage as Record<string, unknown> : null
      if (usage) {
        inputTokens += ((usage.input_tokens as number | undefined) ?? 0)
          + ((usage.cache_read_input_tokens as number | undefined) ?? 0)
          + ((usage.cache_creation_input_tokens as number | undefined) ?? 0)
        outputTokens += (usage.output_tokens as number | undefined) ?? 0
      }

      const toolNames: string[] = []
      let hasToolUse = false
      let hasToolResult = false
      const parentUuid = (typeof obj.parentUuid === 'string' ? obj.parentUuid : null)
      const selfUuid = (typeof obj.uuid === 'string' ? obj.uuid : null)
        ?? (typeof msg?.id === 'string' ? msg.id as string : null)

      const text = extractText(rawContent)
      const thinking = extractThinking(rawContent)
      const effectiveUuid = selfUuid ?? syntheticUuid(role, text)
      const lineTs = extractTimestamp(obj.timestamp)

      for (const part of contentArray) {
        if (part === null || typeof part !== 'object') continue
        if (part.type === 'tool_use') {
          hasToolUse = true
          if (typeof part.name === 'string') toolNames.push(part.name)
          if (typeof part.id === 'string') {
            const ev: ParsedToolEvent = {
              toolUseId: part.id,
              parentExternalUuid: effectiveUuid,
              toolName: typeof part.name === 'string' ? part.name : 'unknown',
              args: part.input ?? null,
              result: null,
              exitStatus: null,
              phase: 'pre',
              createdAt: lineTs,
              callerType: (part.caller && typeof part.caller === 'object') ? ((part.caller as Record<string, unknown>).type as string ?? null) : null,
              isSidechain
            }
            toolEvents.push(ev)
            byToolUseId.set(part.id, ev)
          }
        } else if (part.type === 'tool_result') {
          hasToolResult = true
          const tuid = typeof part.tool_use_id === 'string' ? part.tool_use_id : null
          if (tuid) {
            const ev = byToolUseId.get(tuid)
            if (ev) {
              ev.result = part.content ?? null
              ev.exitStatus = part.is_error ? 'error' : 'ok'
              ev.phase = part.is_error ? 'failed' : 'completed'
            }
          }
        }
      }

      const hasText = text.trim().length > 0

      const pureToolResult = role === 'user' && hasToolResult && !hasText && !hasToolUse
      if (pureToolResult) continue

      if (!hasText && !hasToolUse && !hasToolResult && !usage && !thinking) continue

      const metadata: Record<string, unknown> = {}
      if (usage) metadata.usage = usage
      if (typeof msg?.model === 'string') metadata.model = msg.model
      if (toolNames.length) metadata.tools = toolNames
      if (hasToolResult) metadata.type = 'tool_result'
      if (role === 'user' && !selfUuid && text.length > 200) metadata.system_prompt = true

      messages.push({
        role,
        createdAt: lineTs,
        content: text,
        externalUuid: effectiveUuid,
        parentUuid,
        thinking,
        model: typeof msg?.model === 'string' ? msg.model : null,
        stopReason: typeof msg?.stop_reason === 'string' ? msg.stop_reason : null,
        requestId: typeof obj.requestId === 'string' ? obj.requestId : null,
        isSidechain,
        usage,
        metadata
      })
    } catch {
      // tolerant: skip unparseable lines
    }
  }

  // Scrub NUL from every string before it reaches the DB (text + jsonb both reject it),
  // then clamp anything over-long — an oversized field must cost us that field, never
  // the message, and never (as it did until 2026-09) the entire batch behind it.
  return {
    messages: messages.map(m => clampStrings(stripNul(m))),
    toolEvents: toolEvents.map(e => clampStrings(stripNul(e))),
    inputTokens,
    outputTokens,
    toolCount: toolEvents.length
  }
}
