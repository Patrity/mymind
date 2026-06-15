import { createHash } from 'node:crypto'

export interface ParsedMessage {
  role: string | null
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

function syntheticUuid(role: string, content: string): string {
  return 'h:' + createHash('sha256').update(role + '|' + content).digest('hex').slice(0, 16)
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

  return { messages, toolEvents, inputTokens, outputTokens, toolCount: toolEvents.length }
}
