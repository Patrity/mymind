// server/lib/agent/reflect/transcript.ts
//
// Renders a thread's new messages as plain text for the reflector. Tool calls appear as their
// chip summary only (the same `name` + `summary` the UI shows) — never args or results, which
// can be whole documents. `reasoning` is never read: it is display-only everywhere.

export interface TranscriptMessage {
  id: string
  role: string
  content: string
  toolCalls?: unknown
  createdAt: Date
}

export const TRANSCRIPT_MAX_CHARS = 24_000
const OMITTED = '[… earlier turns omitted]'

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

/** `[tool name → summary]` per well-formed record; malformed jsonb elements are skipped. */
function toolLines(toolCalls: unknown): string[] {
  if (!Array.isArray(toolCalls)) return []
  const lines: string[] = []
  for (const r of toolCalls) {
    if (!r || typeof r !== 'object') continue
    const { name, summary } = r as { name?: unknown; summary?: unknown }
    if (typeof name !== 'string' || !name) continue
    const s = typeof summary === 'string' ? oneLine(summary) : ''
    lines.push(s ? `[tool ${name} → ${s}]` : `[tool ${name}]`)
  }
  return lines
}

function renderMessage(m: TranscriptMessage): string {
  const text = (m.content ?? '').trim()
  if (m.role === 'user') return text ? `[user] ${text}` : ''
  if (m.role === 'assistant') {
    return [...toolLines(m.toolCalls), ...(text ? [`[bridget] ${text}`] : [])].join('\n')
  }
  return text ? `[${m.role}] ${text}` : ''
}

/**
 * Tony's own messages, rendered exactly as the transcript renders them (`[user] …`), one entry per
 * message — the gate's `userInput`. Every `user` row is Tony: typed in the app, or an iMessage from
 * an allowlisted handle (origin `imessage:…`); wake prompts are `event` rows.
 */
export function tonyMessages(msgs: TranscriptMessage[]): string[] {
  return msgs.filter(m => m.role === 'user').map(renderMessage).filter(Boolean)
}

export function buildThreadTranscript(msgs: TranscriptMessage[], opts: { maxChars?: number } = {}): string {
  const maxChars = opts.maxChars ?? TRANSCRIPT_MAX_CHARS
  // Stable sort: rows written in one append share a created_at and keep their given order.
  const blocks = [...msgs]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map(renderMessage)
    .filter(Boolean)

  const full = blocks.join('\n')
  if (full.length <= maxChars) return full

  // Newest first, keep whole turns while they fit alongside the omission marker.
  const kept: string[] = []
  let used = OMITTED.length
  for (let i = blocks.length - 1; i >= 0; i--) {
    const cost = blocks[i]!.length + 1
    if (used + cost > maxChars) break
    kept.unshift(blocks[i]!)
    used += cost
  }
  if (!kept.length) {
    // Even the newest turn alone is too long: keep its tail.
    const room = Math.max(0, maxChars - OMITTED.length - 1)
    return `${OMITTED}\n${blocks[blocks.length - 1]!.slice(-room)}`.slice(0, maxChars)
  }
  return [OMITTED, ...kept].join('\n')
}
