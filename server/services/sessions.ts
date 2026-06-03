import { eq, sql } from 'drizzle-orm'
import { useDb } from '../db'
import { sessions, messages } from '../db/schema'
import { parseTranscriptLines } from './transcript-parse'

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

  return { ingested, total }
}

async function countMessages(sessionId: string): Promise<number> {
  const [result] = await useDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .where(eq(messages.sessionId, sessionId))
  return result?.count ?? 0
}
