// server/services/session-read.ts
// Bounded, LLM-safe reads of a session transcript. The pure core (snippet /
// truncate / item mappers / interleave) is unit-tested; the two DB wrappers
// (Task 2) build on it. Messages and tool events live in separate tables and
// are merged chronologically so a transcript reads in order.

export const CONTENT_CAP = 2000
export const TOOL_CAP = 600
export const SNIPPET_RADIUS = 120

export interface MessageItem { kind: 'message'; id: string; role: string | null; content: string; thinking?: string; createdAt: string; truncated?: number }
export interface ToolEventItem { kind: 'tool'; id: string; toolName: string; exitStatus: string | null; phase: string; argsSnippet: string; resultSnippet: string; createdAt: string; truncated?: number }
export type TranscriptItem = MessageItem | ToolEventItem

export interface MessageRow { id: string; role: string | null; content: string; thinking: string | null; createdAt: Date }
export interface ToolRow { id: string; toolName: string; exitStatus: string | null; phase: string; args: unknown; result: unknown; createdAt: Date }

/** Cap a string, reporting how many chars were dropped (undefined if none). */
export function truncate(s: string, cap: number): { text: string; truncated?: number } {
  if (s.length <= cap) return { text: s }
  return { text: s.slice(0, cap), truncated: s.length - cap }
}

/** Window a snippet around the first case-insensitive match of `query`; head-fallback when absent. */
export function snippetAround(content: string, query: string, radius = SNIPPET_RADIUS): string {
  const c = content ?? ''
  const q = (query ?? '').trim().toLowerCase()
  const i = q ? c.toLowerCase().indexOf(q) : -1
  if (i < 0) return c.length > radius * 2 ? c.slice(0, radius * 2) + '…' : c
  const start = Math.max(0, i - radius)
  const end = Math.min(c.length, i + q.length + radius)
  return (start > 0 ? '…' : '') + c.slice(start, end) + (end < c.length ? '…' : '')
}

export function mapMessage(row: MessageRow, full: boolean): MessageItem {
  const { text, truncated } = full ? { text: row.content, truncated: undefined as number | undefined } : truncate(row.content, CONTENT_CAP)
  const item: MessageItem = { kind: 'message', id: row.id, role: row.role, content: text, createdAt: row.createdAt.toISOString() }
  if (truncated) item.truncated = truncated
  if (full && row.thinking) item.thinking = row.thinking
  return item
}

export function mapTool(row: ToolRow, full: boolean): ToolEventItem {
  const argsStr = row.args == null ? '' : JSON.stringify(row.args)
  const resStr = row.result == null ? '' : (typeof row.result === 'string' ? row.result : JSON.stringify(row.result))
  const a = full ? { text: argsStr, truncated: undefined as number | undefined } : truncate(argsStr, TOOL_CAP)
  const r = full ? { text: resStr, truncated: undefined as number | undefined } : truncate(resStr, TOOL_CAP)
  const item: ToolEventItem = { kind: 'tool', id: row.id, toolName: row.toolName, exitStatus: row.exitStatus, phase: row.phase, argsSnippet: a.text, resultSnippet: r.text, createdAt: row.createdAt.toISOString() }
  const omitted = (a.truncated ?? 0) + (r.truncated ?? 0)
  if (omitted) item.truncated = omitted
  return item
}

/** Merge messages + tool events into one chronological transcript. */
export function interleave(msgRows: MessageRow[], toolRows: ToolRow[], full: boolean): TranscriptItem[] {
  const rows = [
    ...msgRows.map(m => ({ at: m.createdAt.getTime(), item: mapMessage(m, full) })),
    ...toolRows.map(t => ({ at: t.createdAt.getTime(), item: mapTool(t, full) }))
  ]
  rows.sort((x, y) => x.at - y.at)
  return rows.map(r => r.item)
}
