import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedMessage {
  role: string | null
  content: string
  externalUuid: string | null
  metadata: Record<string, unknown>
}

export interface ParsedTranscript {
  messages: ParsedMessage[]
  inputTokens: number
  outputTokens: number
  toolCount: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractTextContent(rawContent: unknown): string {
  if (typeof rawContent === 'string') return rawContent
  if (Array.isArray(rawContent)) {
    return rawContent
      .filter((p): p is Record<string, unknown> => p !== null && typeof p === 'object' && (p as Record<string, unknown>).type === 'text')
      .map((p) => (p as Record<string, unknown>).text as string)
      .filter((t) => typeof t === 'string')
      .join('\n')
  }
  return ''
}

function syntheticUuid(role: string, content: string): string {
  return 'h:' + createHash('sha256').update(role + '|' + content).digest('hex').slice(0, 16)
}

// ---------------------------------------------------------------------------
// Main parser — never throws
// ---------------------------------------------------------------------------

/**
 * Parse an array of Claude Code JSONL lines into messages + aggregate stats.
 * Tolerant: skips lines that can't be parsed or have no usable content.
 */
export function parseTranscriptLines(lines: string[]): ParsedTranscript {
  const parsedMessages: ParsedMessage[] = []
  let inputTokens = 0
  let outputTokens = 0
  let toolCount = 0

  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>

      const msg = obj.message as Record<string, unknown> | undefined

      // Determine role
      const rawRole = msg?.role ?? obj.role ?? obj.type
      const role = typeof rawRole === 'string' ? rawRole : null

      // Only handle user and assistant turns
      if (role !== 'user' && role !== 'assistant') continue

      const rawContent = msg?.content ?? obj.content ?? null

      // Build metadata for this message
      const metadata: Record<string, unknown> = {}

      // --- Token usage (assistant only) ---
      const usage = msg?.usage as Record<string, unknown> | undefined
      if (usage && typeof usage === 'object') {
        const inp = (usage.input_tokens as number | undefined) ?? 0
        const cacheRead = (usage.cache_read_input_tokens as number | undefined) ?? 0
        const cacheCreate = (usage.cache_creation_input_tokens as number | undefined) ?? 0
        const out = (usage.output_tokens as number | undefined) ?? 0
        inputTokens += inp + cacheRead + cacheCreate
        outputTokens += out
        metadata.usage = usage
      }

      // --- Model ---
      if (typeof msg?.model === 'string') {
        metadata.model = msg.model
      }

      // --- Tool use / tool result in content array ---
      const contentArray = Array.isArray(rawContent) ? rawContent as Record<string, unknown>[] : []

      const toolNames: string[] = []
      let hasToolResult = false

      for (const part of contentArray) {
        if (part === null || typeof part !== 'object') continue
        if (part.type === 'tool_use') {
          toolCount++
          if (typeof part.name === 'string') {
            toolNames.push(part.name)
          }
        } else if (part.type === 'tool_result') {
          toolCount++
          hasToolResult = true
        }
      }

      if (toolNames.length > 0) metadata.tools = toolNames
      if (hasToolResult) metadata.type = 'tool_result'

      // --- Extract text content ---
      const textContent = extractTextContent(rawContent)

      // Skip lines with no text AND no tool activity AND no usage
      const hasText = textContent.trim().length > 0
      const hasTool = toolNames.length > 0 || hasToolResult
      const hasUsage = usage !== undefined

      if (!hasText && !hasTool && !hasUsage) continue

      // Build external UUID
      const externalUuid = (typeof obj.uuid === 'string' ? obj.uuid : null)
        ?? (typeof msg?.id === 'string' ? msg.id : null)
        ?? syntheticUuid(role, textContent)

      parsedMessages.push({
        role,
        content: textContent,
        externalUuid,
        metadata
      })
    } catch {
      // Tolerant: skip unparseable lines
    }
  }

  return { messages: parsedMessages, inputTokens, outputTokens, toolCount }
}
