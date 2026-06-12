import { asc, desc, eq, sql } from 'drizzle-orm'
import { useDb } from '../db'
import { sessions, messages } from '../db/schema'
import { parseTranscriptLines } from './transcript-parse'
import { publishChange } from '../utils/live-bus'
import type { SessionListItem, SessionDetail, SessionMessageDTO } from '../../shared/types/session'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UpsertSessionInput {
  source: string
  externalId: string
  project?: string | null
  cwd?: string | null
  title?: string | null
  metadata?: Record<string, unknown>
}

export interface IngestTranscriptInput {
  source: string
  externalId: string
  lines: string[]
}

export interface IngestResult {
  ingested: number
  total: number
}

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

export async function upsertSession(input: UpsertSessionInput): Promise<typeof sessions.$inferSelect> {
  const db = useDb()
  const now = new Date()

  // Build the set clause for conflict updates (only update provided fields)
  const updateSet: Partial<typeof sessions.$inferInsert> & { lastActive: Date } = {
    lastActive: now
  }
  if (input.project !== undefined && input.project !== null) updateSet.project = input.project
  if (input.cwd !== undefined && input.cwd !== null) updateSet.cwd = input.cwd
  if (input.title !== undefined && input.title !== null) updateSet.title = input.title
  if (input.metadata !== undefined) {
    // Merge metadata via jsonb concat on conflict
    updateSet.metadata = input.metadata as unknown as string
  }

  const insertValues: typeof sessions.$inferInsert = {
    source: input.source,
    externalId: input.externalId,
    lastActive: now,
    ...(input.project != null ? { project: input.project } : {}),
    ...(input.cwd != null ? { cwd: input.cwd } : {}),
    ...(input.title != null ? { title: input.title } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata as unknown as string } : {})
  }

  const [row] = await db
    .insert(sessions)
    .values(insertValues)
    .onConflictDoUpdate({
      target: [sessions.source, sessions.externalId],
      set: updateSet
    })
    .returning()

  return row!
}

export async function ingestTranscript(input: IngestTranscriptInput): Promise<IngestResult> {
  const db = useDb()

  // Ensure the session exists
  const session = await upsertSession({
    source: input.source,
    externalId: input.externalId
  })

  // Parse lines into message records (with metadata)
  const parsed = parseTranscriptLines(input.lines)

  if (parsed.messages.length === 0) {
    return { ingested: 0, total: await countMessages(session.id) }
  }

  // Insert idempotently — on conflict (sessionId, externalUuid) do nothing
  const toInsert = parsed.messages.map((m) => ({
    sessionId: session.id,
    role: m.role ?? undefined,
    content: m.content,
    externalUuid: m.externalUuid,
    metadata: m.metadata as unknown as string
  }))

  const inserted = await db
    .insert(messages)
    .values(toInsert)
    .onConflictDoNothing()
    .returning({ id: messages.id })

  const ingested = inserted.length

  // Recompute session aggregates from ALL messages for this session.
  // This is robust on partial / re-ingest: we always reflect the full truth.
  const allMessages = await db
    .select({ metadata: messages.metadata })
    .from(messages)
    .where(eq(messages.sessionId, session.id))

  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalToolCount = 0

  for (const row of allMessages) {
    const meta = row.metadata as Record<string, unknown>

    // Sum token usage from per-message metadata
    const usage = meta?.usage as Record<string, unknown> | undefined
    if (usage && typeof usage === 'object') {
      totalInputTokens += ((usage.input_tokens as number | undefined) ?? 0)
        + ((usage.cache_read_input_tokens as number | undefined) ?? 0)
        + ((usage.cache_creation_input_tokens as number | undefined) ?? 0)
      totalOutputTokens += (usage.output_tokens as number | undefined) ?? 0
    }

    // Count tools from metadata.tools array
    const tools = meta?.tools
    if (Array.isArray(tools)) {
      totalToolCount += tools.length
    }

    // Count tool_result markers
    if (meta?.type === 'tool_result') {
      totalToolCount++
    }
  }

  const total = allMessages.length
  await db
    .update(sessions)
    .set({
      messageCount: total,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      toolCount: totalToolCount,
      lastActive: new Date()
    })
    .where(eq(sessions.id, session.id))

  publishChange({ resource: 'session', action: 'updated', id: session.id })

  return { ingested, total }
}

// ---------------------------------------------------------------------------
// Read-only views
// ---------------------------------------------------------------------------

export interface ListSessionsOptions {
  source?: string
  project?: string
  limit?: number
}

export async function listSessions(opts: ListSessionsOptions = {}): Promise<SessionListItem[]> {
  const db = useDb()
  const { source, project, limit = 50 } = opts

  const rows = await db
    .select({
      id: sessions.id,
      source: sessions.source,
      project: sessions.project,
      title: sessions.title,
      summary: sessions.summary,
      messageCount: sessions.messageCount,
      toolCount: sessions.toolCount,
      inputTokens: sessions.inputTokens,
      outputTokens: sessions.outputTokens,
      startedAt: sessions.startedAt,
      lastActive: sessions.lastActive
    })
    .from(sessions)
    .where(
      source && project
        ? sql`${sessions.source} = ${source} AND ${sessions.project} = ${project}`
        : source
          ? eq(sessions.source, source)
          : project
            ? eq(sessions.project, project)
            : undefined
    )
    .orderBy(desc(sessions.lastActive))
    .limit(limit)

  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    project: r.project,
    title: r.title,
    summary: r.summary,
    messageCount: r.messageCount,
    toolCount: r.toolCount,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    startedAt: r.startedAt.toISOString(),
    lastActive: r.lastActive.toISOString()
  }))
}

export async function getSession(id: string): Promise<SessionDetail | null> {
  const db = useDb()

  const [session] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, id))
    .limit(1)

  if (!session) return null

  const msgs = await db
    .select()
    .from(messages)
    .where(eq(messages.sessionId, id))
    .orderBy(asc(messages.createdAt))

  const messageDTOs: SessionMessageDTO[] = msgs.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    metadata: (m.metadata as Record<string, unknown>) ?? {},
    createdAt: m.createdAt.toISOString()
  }))

  return {
    id: session.id,
    source: session.source,
    project: session.project,
    title: session.title,
    summary: session.summary,
    messageCount: session.messageCount,
    toolCount: session.toolCount,
    inputTokens: session.inputTokens,
    outputTokens: session.outputTokens,
    startedAt: session.startedAt.toISOString(),
    lastActive: session.lastActive.toISOString(),
    cwd: session.cwd,
    metadata: (session.metadata as Record<string, unknown>) ?? {},
    messages: messageDTOs
  }
}

async function countMessages(sessionId: string): Promise<number> {
  const [result] = await useDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .where(eq(messages.sessionId, sessionId))
  return result?.count ?? 0
}
