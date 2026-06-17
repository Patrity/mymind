import { asc, desc, eq, sql } from 'drizzle-orm'
import { useDb } from '../db'
import { sessions, messages, toolEvents } from '../db/schema'
import { parseTranscriptLines } from './transcript-parse'
import { publishChange } from '../utils/live-bus'
import { findOrCreateProject } from './projects'
import type { SessionListItem, SessionMeta, SessionMessages, SessionMessageDTO, SessionToolEventDTO } from '../../shared/types/session'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UpsertSessionInput {
  source: string
  externalId: string
  project?: string | null
  cwd?: string | null
  title?: string | null
  machineId?: string | null
  hostname?: string | null
  gitBranch?: string | null
  gitCommit?: string | null
  gitRemote?: string | null
  appVersion?: string | null
  endedAt?: Date | null
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

  // Resolve canonical project when we have git/cwd signal (event path). Never
  // clobber an existing project_id when this call carries no signal (transcript path).
  let resolvedProjectId: string | undefined
  let resolvedProjectSlug: string | undefined
  if (input.gitRemote != null || input.cwd != null) {
    const proj = await findOrCreateProject({ gitRemote: input.gitRemote, cwd: input.cwd })
    resolvedProjectId = proj.id
    resolvedProjectSlug = proj.slug
  }

  // Build the set clause for conflict updates (only update provided fields)
  const updateSet: Partial<typeof sessions.$inferInsert> & { lastActive: Date } = {
    lastActive: now
  }
  if (input.project !== undefined && input.project !== null) updateSet.project = input.project
  if (resolvedProjectId) { updateSet.projectId = resolvedProjectId; updateSet.project = resolvedProjectSlug }
  if (input.cwd !== undefined && input.cwd !== null) updateSet.cwd = input.cwd
  if (input.title !== undefined && input.title !== null) updateSet.title = input.title
  if (input.machineId != null) updateSet.machineId = input.machineId
  if (input.hostname != null) updateSet.hostname = input.hostname
  if (input.gitBranch != null) updateSet.gitBranch = input.gitBranch
  if (input.gitCommit != null) updateSet.gitCommit = input.gitCommit
  if (input.gitRemote != null) updateSet.gitRemote = input.gitRemote
  if (input.appVersion != null) updateSet.appVersion = input.appVersion
  if (input.endedAt != null) updateSet.endedAt = input.endedAt
  if (input.metadata !== undefined) {
    // Merge metadata via jsonb concat on conflict
    updateSet.metadata = input.metadata as unknown as string
  }

  const insertValues: typeof sessions.$inferInsert = {
    source: input.source,
    externalId: input.externalId,
    lastActive: now,
    ...(input.project != null ? { project: input.project } : {}),
    ...(resolvedProjectId ? { projectId: resolvedProjectId, project: resolvedProjectSlug } : {}),
    ...(input.cwd != null ? { cwd: input.cwd } : {}),
    ...(input.title != null ? { title: input.title } : {}),
    ...(input.machineId != null ? { machineId: input.machineId } : {}),
    ...(input.hostname != null ? { hostname: input.hostname } : {}),
    ...(input.gitBranch != null ? { gitBranch: input.gitBranch } : {}),
    ...(input.gitCommit != null ? { gitCommit: input.gitCommit } : {}),
    ...(input.gitRemote != null ? { gitRemote: input.gitRemote } : {}),
    ...(input.appVersion != null ? { appVersion: input.appVersion } : {}),
    ...(input.endedAt != null ? { endedAt: input.endedAt } : {}),
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
  const session = await upsertSession({ source: input.source, externalId: input.externalId })
  const parsed = parseTranscriptLines(input.lines)

  // 1. Insert messages (idempotent on (session_id, external_uuid))
  if (parsed.messages.length > 0) {
    await db.insert(messages).values(parsed.messages.map(m => ({
      sessionId: session.id,
      role: m.role ?? undefined,
      content: m.content,
      externalUuid: m.externalUuid,
      parentUuid: m.parentUuid,
      thinking: m.thinking,
      model: m.model,
      stopReason: m.stopReason,
      requestId: m.requestId,
      isSidechain: m.isSidechain,
      usage: m.usage as unknown as string,
      metadata: m.metadata as unknown as string
    }))).onConflictDoNothing()
  }

  // 2. Map externalUuid -> message id for tool-event linkage
  const msgRows = await db.select({ id: messages.id, externalUuid: messages.externalUuid })
    .from(messages).where(eq(messages.sessionId, session.id))
  const idByUuid = new Map(msgRows.map(r => [r.externalUuid, r.id]))

  // 3. Insert/close tool events (idempotent on (session_id, tool_use_id))
  for (const te of parsed.toolEvents) {
    if (!te.toolUseId) continue
    await db.insert(toolEvents).values({
      sessionId: session.id,
      messageId: te.parentExternalUuid ? idByUuid.get(te.parentExternalUuid) ?? null : null,
      toolName: te.toolName,
      args: te.args as unknown as string,
      result: te.result as unknown as string,
      exitStatus: te.exitStatus,
      phase: te.phase,
      toolUseId: te.toolUseId,
      isSidechain: te.isSidechain,
      callerType: te.callerType
    }).onConflictDoUpdate({
      target: [toolEvents.sessionId, toolEvents.toolUseId],
      set: { result: te.result as unknown as string, exitStatus: te.exitStatus, phase: te.phase }
    })
  }

  // 4. Recompute aggregates from the real tables
  const [agg] = await db.select({
    msgCount: sql<number>`count(*)::int`,
    // input = fresh tokens + tokens cached for the FIRST time. cache_read is
    // EXCLUDED: it's the cached prefix re-read every turn (already counted once via
    // cache_creation), so summing it N-counts the same context and balloons the total.
    inTok: sql<number>`coalesce(sum( coalesce((${messages.usage}->>'input_tokens')::int,0)
      + coalesce((${messages.usage}->>'cache_creation_input_tokens')::int,0) ),0)::int`,
    outTok: sql<number>`coalesce(sum( coalesce((${messages.usage}->>'output_tokens')::int,0) ),0)::int`,
    minTs: sql<string | null>`min(${messages.createdAt})`,
    maxTs: sql<string | null>`max(${messages.createdAt})`
  }).from(messages).where(eq(messages.sessionId, session.id))

  const [toolAgg] = await db.select({ n: sql<number>`count(*)::int` })
    .from(toolEvents).where(eq(toolEvents.sessionId, session.id))

  await db.update(sessions).set({
    messageCount: agg?.msgCount ?? 0,
    inputTokens: agg?.inTok ?? 0,
    outputTokens: agg?.outTok ?? 0,
    toolCount: toolAgg?.n ?? 0,
    ...(agg?.minTs ? { startedAt: new Date(agg.minTs) } : {}),
    lastActive: agg?.maxTs ? new Date(agg.maxTs) : new Date()
  }).where(eq(sessions.id, session.id))

  publishChange({ resource: 'session', action: 'updated', id: session.id })
  return { ingested: parsed.messages.length, total: agg?.msgCount ?? 0 }
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

export async function getSessionMeta(id: string): Promise<SessionMeta | null> {
  const db = useDb()

  const [session] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, id))
    .limit(1)

  if (!session) return null

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
    machineId: session.machineId,
    gitBranch: session.gitBranch,
    gitCommit: session.gitCommit,
    gitRemote: session.gitRemote,
    appVersion: session.appVersion,
    endedAt: session.endedAt?.toISOString() ?? null,
    metadata: (session.metadata as Record<string, unknown>) ?? {}
  }
}

export async function getSessionMessages(id: string, opts: { since?: string } = {}): Promise<SessionMessages> {
  const db = useDb()
  const msgs = await db.select().from(messages)
    .where(opts.since
      ? sql`${messages.sessionId} = ${id} and ${messages.createdAt} > ${opts.since}`
      : eq(messages.sessionId, id))
    .orderBy(asc(messages.createdAt))
  const messageDTOs: SessionMessageDTO[] = msgs.map(m => ({
    id: m.id, role: m.role, content: m.content, thinking: m.thinking, model: m.model,
    isSidechain: m.isSidechain, metadata: (m.metadata as Record<string, unknown>) ?? {}, createdAt: m.createdAt.toISOString()
  }))
  const tevs = await db.select().from(toolEvents).where(eq(toolEvents.sessionId, id)).orderBy(asc(toolEvents.createdAt))
  const toolEventDTOs: SessionToolEventDTO[] = tevs.map(t => ({
    id: t.id, messageId: t.messageId, toolName: t.toolName, args: t.args, result: t.result,
    exitStatus: t.exitStatus, phase: t.phase, toolUseId: t.toolUseId, isSidechain: t.isSidechain, createdAt: t.createdAt.toISOString()
  }))
  return { messages: messageDTOs, toolEvents: toolEventDTOs }
}
