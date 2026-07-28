// server/services/session-read.ts
// Bounded, LLM-safe reads of a session transcript. The pure core (snippet /
// truncate / item mappers / interleave) is unit-tested; the two DB wrappers
// (Task 2) build on it. Messages and tool events live in separate tables and
// are merged chronologically so a transcript reads in order.

import { and, asc, desc, eq, gt, lt, inArray } from 'drizzle-orm'
import { useDb } from '../db'
import { messages, toolEvents, sessions } from '../db/schema'

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

const MSG_COLS = { id: messages.id, role: messages.role, content: messages.content, thinking: messages.thinking, createdAt: messages.createdAt }
const TOOL_COLS = { id: toolEvents.id, toolName: toolEvents.toolName, exitStatus: toolEvents.exitStatus, phase: toolEvents.phase, args: toolEvents.args, result: toolEvents.result, createdAt: toolEvents.createdAt }

async function toolEventsFor(ids: string[], includeSidechain: boolean): Promise<ToolRow[]> {
  if (!ids.length) return []
  const db = useDb()
  const where = includeSidechain
    ? inArray(toolEvents.messageId, ids)
    : and(inArray(toolEvents.messageId, ids), eq(toolEvents.isSidechain, false))
  return db.select(TOOL_COLS).from(toolEvents).where(where) as unknown as Promise<ToolRow[]>
}

/** One chronological page of a session transcript (messages + their tool events). */
export async function readSessionPage(sessionId: string, opts: { offset?: number; limit?: number; full?: boolean; includeSidechain?: boolean } = {}) {
  const { offset = 0, limit = 25, full = false, includeSidechain = false } = opts
  const db = useDb()
  const [sess] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
  if (!sess) return { error: 'session not found', sessionId }

  const msgWhere = includeSidechain ? eq(messages.sessionId, sessionId) : and(eq(messages.sessionId, sessionId), eq(messages.isSidechain, false))
  const msgRows = await db.select(MSG_COLS).from(messages).where(msgWhere).orderBy(asc(messages.createdAt)).offset(offset).limit(limit) as unknown as MessageRow[]
  const toolRows = await toolEventsFor(msgRows.map(m => m.id), includeSidechain)

  return {
    session: { id: sess.id, title: sess.title, project: sess.project, startedAt: sess.startedAt.toISOString(), endedAt: sess.endedAt?.toISOString() ?? null, messageCount: sess.messageCount },
    offset, limit, returned: msgRows.length,
    // heuristic: a full page implies there is probably more. messageCount is the
    // stored raw total (may include sidechain) and is informational only.
    hasMore: msgRows.length === limit,
    items: interleave(msgRows, toolRows, full)
  }
}

/** The neighborhood around one message: `radius` before + the message + `radius` after. */
export async function readAroundMessage(messageId: string, opts: { radius?: number; full?: boolean; includeSidechain?: boolean } = {}) {
  const { radius = 8, full = false, includeSidechain = false } = opts
  const db = useDb()
  const [focal] = await db.select(MSG_COLS).from(messages).where(eq(messages.id, messageId)).limit(1) as unknown as MessageRow[]
  if (!focal) return { error: 'message not found', messageId }
  const [focalMeta] = await db.select({ sessionId: messages.sessionId }).from(messages).where(eq(messages.id, messageId)).limit(1)
  const sessionId = focalMeta!.sessionId

  const side = (col: typeof messages.isSidechain) => includeSidechain ? undefined : eq(col, false)
  const before = await db.select(MSG_COLS).from(messages)
    .where(and(eq(messages.sessionId, sessionId), lt(messages.createdAt, focal.createdAt), side(messages.isSidechain)))
    .orderBy(desc(messages.createdAt)).limit(radius) as unknown as MessageRow[]
  const after = await db.select(MSG_COLS).from(messages)
    .where(and(eq(messages.sessionId, sessionId), gt(messages.createdAt, focal.createdAt), side(messages.isSidechain)))
    .orderBy(asc(messages.createdAt)).limit(radius) as unknown as MessageRow[]

  const msgRows = [...before.reverse(), focal, ...after]
  const toolRows = await toolEventsFor(msgRows.map(m => m.id), includeSidechain)
  const [sess] = await db.select({ title: sessions.title, project: sessions.project }).from(sessions).where(eq(sessions.id, sessionId)).limit(1)

  return {
    sessionId, sessionTitle: sess?.title ?? null, project: sess?.project ?? null, focalMessageId: messageId,
    items: interleave(msgRows, toolRows, full)
  }
}
