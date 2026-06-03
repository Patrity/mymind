import { eq, sql } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { useDb } from '../db'
import { sessions, messages } from '../db/schema'

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
// Helpers
// ---------------------------------------------------------------------------

function extractContent(rawContent: unknown): string {
  if (typeof rawContent === 'string') return rawContent
  if (Array.isArray(rawContent)) {
    return rawContent
      .filter((p: unknown) => p !== null && typeof p === 'object' && (p as Record<string, unknown>).type === 'text')
      .map((p: unknown) => (p as Record<string, unknown>).text as string)
      .join('\n')
  }
  return ''
}

function parseTranscriptLine(line: string): { role: string; content: string; externalUuid: string | null } | null {
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(line) as Record<string, unknown>
  } catch {
    return null
  }

  // Extract role
  const msg = obj.message as Record<string, unknown> | undefined
  const rawRole = msg?.role ?? obj.role ?? obj.type
  const role = typeof rawRole === 'string' ? rawRole : null

  // Only handle user/assistant messages
  if (role !== 'user' && role !== 'assistant') return null

  // Extract content — prefer message.content, then obj.content
  const rawContent = msg?.content ?? obj.content ?? null
  const content = extractContent(rawContent)
  if (!content.trim()) return null

  // Extract external UUID — fall back to a stable synthetic key so that
  // identical messages without a uuid don't re-insert on every transcript POST
  // (Postgres NULLs are distinct in a unique index, causing duplicates).
  const externalUuid = (typeof obj.uuid === 'string' ? obj.uuid : null)
    ?? (typeof msg?.id === 'string' ? msg.id : null)
    ?? ('h:' + createHash('sha256').update(role + '|' + content).digest('hex').slice(0, 16))

  return { role, content, externalUuid }
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

  // Parse lines into message records
  const toInsert: Array<{ sessionId: string; role: string; content: string; externalUuid: string | null }> = []
  for (const line of input.lines) {
    const parsed = parseTranscriptLine(line)
    if (!parsed) continue
    toInsert.push({ sessionId: session.id, ...parsed })
  }

  if (toInsert.length === 0) {
    return { ingested: 0, total: await countMessages(session.id) }
  }

  // Insert idempotently
  const inserted = await db
    .insert(messages)
    .values(toInsert)
    .onConflictDoNothing()
    .returning({ id: messages.id })

  const ingested = inserted.length

  // Update session message_count and lastActive
  const total = await countMessages(session.id)
  await db
    .update(sessions)
    .set({ messageCount: total, lastActive: new Date() })
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
