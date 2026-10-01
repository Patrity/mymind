import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { useDb } from '../db'
import { sessions, messages, memEnrichmentState, toolEvents, projects, conversations, conversationMessages } from '../db/schema'
import { extractV3, EXTRACT_PROMPT_VERSION, type DocCandidate, type ExtractV3Result } from '../lib/memory/extract-v3'
import { resolveEnrichedMemory } from './memory-resolve'
import { createMemory } from './memory'
import { projectIdForScope } from '../lib/projects/memory-project'
import { publishChange } from '../utils/live-bus'
import { scoreMemories } from './memory-scoring'

export interface EnrichMemoryResult {
  enriched: number
  candidates: number
  sessionsProcessed: number
  skipped: number
  actions: { inserted: number, superseded: number, contradicted: number, duplicate: number, reviewQueued: number }
}

const TRANSCRIPT_CHAR_LIMIT = 12000
const HEAD_CHARS = 2000

/**
 * Build a transcript for memory enrichment. Pure, exported for tests.
 * Excludes sidechain messages and system_prompt metadata rows.
 * Prepends a tool-usage summary line.
 */
export function buildEnrichTranscript(
  msgs: { id: string, role: string | null, content: string | null, thinking: string | null, isSidechain: boolean, metadata: unknown }[],
  tools: { toolName: string, count: number }[]
): string {
  // Exclude sidechain and system_prompt rows
  const kept = msgs.filter(m => {
    if (m.isSidechain === true) return false
    const meta = m.metadata as Record<string, unknown> | null
    if (meta && meta.system_prompt === true) return false
    return true
  })

  const toolLine = tools.length
    ? `=== TOOL USAGE ===\n${tools.map(t => `${t.toolName}×${t.count}`).join(' ')}`
    : '=== TOOL USAGE ===\n(none)'

  const lines = kept.map(m => {
    const base = `[${m.id}][${m.role ?? 'unknown'}] ${m.content ?? ''}`
    const think = m.thinking ? ` <thinking>${m.thinking.slice(0, 800)}</thinking>` : ''
    return base + think
  })

  const body = [toolLine, ...lines].join('\n\n')

  if (body.length <= TRANSCRIPT_CHAR_LIMIT) return body

  // Keep head + tail, trim middle
  const head = body.slice(0, HEAD_CHARS)
  const tail = body.slice(-(TRANSCRIPT_CHAR_LIMIT - HEAD_CHARS))
  return `${head}\n\n[... transcript trimmed ...]\n\n${tail}`
}

/**
 * Call the model to extract durable memory candidates (and doc-worthy detail) from a transcript.
 * Shared by both enrichment sources (session + conversation) so the extraction prompt never
 * diverges between them — a divergent prompt is how the two sources start producing
 * incompatible memories. The prompt itself is extract-v3 (server/lib/memory/extract-v3.ts).
 */
export async function extractMemoriesFromTranscript(transcript: string): Promise<ExtractV3Result> {
  return extractV3(transcript)
}

/**
 * Hand doc-worthy extractions on for filing. No-op for now: cycle 77 Task 6 replaces this body
 * with fileDocCandidate() (a triage capture per candidate, fire-and-forget). Callers .catch it
 * anyway so a rejection can never surface as an unhandled rejection in Nitro.
 */
async function routeDocCandidates(_candidates: DocCandidate[], _src: { sessionId?: string, conversationId?: string }): Promise<void> {}

/**
 * Score freshly created memories (Jev + audit) without holding up enrichment. Fire-and-forget:
 * a failure leaves the rows for the backfill / queue scorer, which retry unscored rows anyway.
 */
function scoreNewMemories(ids: string[]): void {
  if (!ids.length) return
  void scoreMemories(ids).catch(err => console.warn('[memory-enrich] scoring new memories failed:', err))
}

/**
 * Run memory enrichment over sessions that have new messages since last enrichment.
 * Per-session failures are isolated — errors are logged and recorded in state.
 */
export async function runMemoryEnrichment({ limit = 10 }: { limit?: number } = {}): Promise<EnrichMemoryResult> {
  const db = useDb()

  // Select candidate sessions with all conditions:
  // 1. real-message floor >= 4 (user/assistant, non-empty, non-sidechain, non-system_prompt)
  // 2. grace period: last_active < now() - 1 hour
  // 3. not an explicitly-INACTIVE project (null / unknown / active all pass; only projects
  //    registered AND marked inactive are excluded — imported sessions have unregistered
  //    projects and must still enrich)
  // 4. never-enriched OR grew-by->=5 OR errored->=24h-ago
  const candidateSessions = await db
    .select({
      id: sessions.id,
      messageCount: sessions.messageCount,
      project: sessions.project,
      projectId: sessions.projectId,
      startedAt: sessions.startedAt
    })
    .from(sessions)
    .where(
      and(
        sql`(select count(*) from ${messages} m where m.session_id = ${sessions.id}
              and m.role in ('user','assistant')
              and (coalesce(m.content,'') <> '' or coalesce(m.thinking,'') <> '')
              and coalesce((m.metadata->>'system_prompt')::boolean, false) is not true
              and m.is_sidechain is not true) >= 4`,
        sql`${sessions.lastActive} < now() - interval '1 hour'`,
        sql`not exists (select 1 from ${projects} p where p.id = ${sessions.projectId} and p.active = false)`,
        sql`(not exists (select 1 from ${memEnrichmentState} e where e.source_kind = 'session' and e.source_id = ${sessions.id})
          or exists (select 1 from ${memEnrichmentState} e where e.source_kind = 'session' and e.source_id = ${sessions.id} and (
            (${sessions.messageCount} - coalesce(e.last_enriched_message_count, 0)) >= 5
            or (e.status = 'error' and e.last_run < now() - interval '24 hours')
          )))`
      )
    )
    .orderBy(sessions.lastActive)
    .limit(limit)

  let enriched = 0
  let candidates = 0
  let sessionsProcessed = 0
  let skipped = 0
  const actions = { inserted: 0, superseded: 0, contradicted: 0, duplicate: 0, reviewQueued: 0 }

  for (const session of candidateSessions) {
    try {
      // Load messages with provenance fields
      const msgs = await db
        .select({
          id: messages.id,
          role: messages.role,
          content: messages.content,
          thinking: messages.thinking,
          isSidechain: messages.isSidechain,
          metadata: messages.metadata
        })
        .from(messages)
        .where(eq(messages.sessionId, session.id))
        .orderBy(messages.createdAt)

      if (msgs.length === 0) {
        skipped++
        continue
      }

      // Compute tool usage summary
      const toolRows = await db
        .select({
          toolName: toolEvents.toolName,
          count: sql<number>`cast(count(*) as int)`
        })
        .from(toolEvents)
        .where(eq(toolEvents.sessionId, session.id))
        .groupBy(toolEvents.toolName)

      const tools = toolRows.map(r => ({ toolName: r.toolName, count: r.count }))

      const transcript = buildEnrichTranscript(msgs, tools)

      const { memories: extracted, docCandidates } = await extractMemoriesFromTranscript(transcript)
      candidates += extracted.length
      void routeDocCandidates(docCandidates, { sessionId: session.id }).catch(err => console.warn('[memory-enrich] doc candidate routing failed:', err))

      // Store each candidate with rich provenance via resolution orchestrator
      const newIds: string[] = []
      for (const candidate of extracted) {
        try {
          const plan = await resolveEnrichedMemory({
            scope: candidate.scope,
            content: candidate.content,
            tags: [...(candidate.tags ?? []), 'enrichment', 'unreviewed'],
            source: `enrichment:${session.id}`,
            project: session.project ?? null,
            projectId: projectIdForScope(candidate.scope, session.projectId ?? null),
            sourceDate: session.startedAt ?? null,
            sessionId: session.id,
            confidence: candidate.confidence ?? null,
            extractPromptVersion: EXTRACT_PROMPT_VERSION,
            evidence: [{
              sessionId: session.id,
              sessionDate: session.startedAt?.toISOString() ?? null,
              msgIds: candidate.evidenceMsgIds ?? [],
              quote: candidate.quote ?? null,
              reasoning: candidate.reasoning ?? null,
              mergedAt: new Date().toISOString()
            }]
          })
          enriched++
          if (plan.newId) newIds.push(plan.newId)
          if (plan.action === 'insert') actions.inserted++
          else if (plan.action === 'supersede') actions.superseded++
          else if (plan.action === 'contradict') { actions.contradicted++; actions.reviewQueued++ }
          else if (plan.action === 'review-supersede') actions.reviewQueued++
          else if (plan.action === 'review-contradict') actions.reviewQueued++
          else if (plan.action === 'duplicate') actions.duplicate++
        } catch (memErr) {
          console.warn(`[memory-enrich] failed to store candidate for session ${session.id}:`, memErr)
        }
      }
      scoreNewMemories(newIds)

      // Upsert enrichment state
      await db
        .insert(memEnrichmentState)
        .values({
          sourceKind: 'session',
          sourceId: session.id,
          lastEnrichedMessageCount: session.messageCount,
          lastRun: new Date(),
          status: 'ok',
          error: null
        })
        .onConflictDoUpdate({
          target: [memEnrichmentState.sourceKind, memEnrichmentState.sourceId],
          set: {
            lastEnrichedMessageCount: session.messageCount,
            lastRun: new Date(),
            status: 'ok',
            error: null
          }
        })

      sessionsProcessed++
      console.log(`[memory-enrich] session ${session.id}: extracted ${extracted.length} candidates, stored ${enriched} so far`)
    } catch (err) {
      console.error(`[memory-enrich] error processing session ${session.id}:`, err)

      // Record error in state but do NOT advance the watermark to current messageCount —
      // keep it at current (or 0 for new rows) so the 24h-retry selector branch can re-pick
      // this session after 24 hours.
      try {
        await db
          .insert(memEnrichmentState)
          .values({
            sourceKind: 'session',
            sourceId: session.id,
            lastEnrichedMessageCount: session.messageCount,
            lastRun: new Date(),
            status: 'error',
            error: String(err)
          })
          .onConflictDoUpdate({
            target: [memEnrichmentState.sourceKind, memEnrichmentState.sourceId],
            set: {
              lastRun: new Date(),
              status: 'error',
              error: String(err)
            }
          })
      } catch (stateErr) {
        console.error(`[memory-enrich] failed to record error state for session ${session.id}:`, stateErr)
      }

      skipped++
    }
  }

  return { enriched, candidates, sessionsProcessed, skipped, actions }
}

export interface EnrichConversationsOptions {
  limit?: number
  /**
   * Restrict the candidate query to these conversation ids. Test-only scoping seam — the
   * production sweep (server/tasks/enrich-memories.ts) never sets this, so the real query keeps
   * scanning every conversation. Exists so tests never touch real Bridget conversation history:
   * without it, the candidate query has no way to distinguish a test's own seeded rows from
   * real ones, and a mocked `extract` run against this shared dev DB would durably mark real
   * conversations "checked, zero memories" under a fake result.
   */
  only?: string[]
  deps?: { extract?: (transcript: string) => Promise<ExtractV3Result> }
}

/**
 * Enrich Bridget conversations, not just Claude Code sessions.
 *
 * Before this, every memory in the store came from a session transcript and talking to Bridget
 * produced nothing — which makes a persistent session accumulate forever and graduate nothing.
 *
 * Output is review-gated exactly like session enrichment: Bridget talks more loosely than a work
 * transcript and the extraction prompt is tuned for the latter, so yield should be measured
 * before this is trusted.
 */
export async function enrichConversations(
  opts: EnrichConversationsOptions = {}
): Promise<{ conversationsProcessed: number, memoriesCreated: number }> {
  const db = useDb()
  const limit = opts.limit ?? 10
  const extract = opts.deps?.extract ?? extractMemoriesFromTranscript

  const candidates = await db.select({ id: conversations.id, messageCount: conversations.messageCount })
    .from(conversations)
    .leftJoin(memEnrichmentState, and(
      eq(memEnrichmentState.sourceKind, 'conversation'),
      eq(memEnrichmentState.sourceId, conversations.id)
    ))
    .where(and(
      // Idle guard — same 1-hour quiet period runMemoryEnrichment requires of a session
      // (sessions.lastActive) above, applied to lastMessageAt: a conversation still being
      // actively typed into shouldn't be snapshotted mid-thought.
      sql`${conversations.lastMessageAt} < now() - interval '1 hour'`,
      // Delta + error-backoff gate — mirrors the session selector's OR above (never-enriched
      // OR grown-by->=5 OR errored->=24h-ago). Without this a conversation with exactly one new
      // message fires every 15-minute cron tick forever, and a source that errors retries on
      // every tick too since nothing here previously read `status`/`last_run` at all.
      sql`(${memEnrichmentState.sourceId} is null
        or (${conversations.messageCount} - coalesce(${memEnrichmentState.lastEnrichedMessageCount}, 0)) >= 5
        or (${memEnrichmentState.status} = 'error' and ${memEnrichmentState.lastRun} < now() - interval '24 hours'))`,
      ...(opts.only ? [inArray(conversations.id, opts.only)] : [])
    ))
    .orderBy(desc(conversations.lastMessageAt))
    .limit(limit)

  let memoriesCreated = 0
  for (const c of candidates) {
    const rows = await db.select().from(conversationMessages)
      .where(eq(conversationMessages.conversationId, c.id))
      .orderBy(conversationMessages.createdAt, conversationMessages.id)
    // Same head/tail trim runMemoryEnrichment uses for a session transcript (see
    // buildEnrichTranscript above) — previously unused here, so an unbounded Bridget thread
    // rode straight into the extraction prompt with no cap at all.
    const transcript = buildEnrichTranscript(
      rows.map(r => ({ id: r.id, role: r.role, content: r.content, thinking: r.reasoning, isSidechain: false, metadata: null })),
      []
    )

    try {
      const { memories: extracted, docCandidates } = await extract(transcript)
      void routeDocCandidates(docCandidates, { conversationId: c.id }).catch(err => console.warn('[memory-enrich] doc candidate routing failed:', err))
      const newIds: string[] = []
      for (const e of extracted) {
        const memory = await createMemory({
          scope: e.scope,
          content: e.content,
          confidence: e.confidence,
          source: `conversation:${c.id}`,
          extractPromptVersion: EXTRACT_PROMPT_VERSION
        })
        publishChange({ resource: 'memory', action: 'created', id: memory.id })
        newIds.push(memory.id)
        memoriesCreated++
      }
      scoreNewMemories(newIds)
      await db.insert(memEnrichmentState)
        .values({ sourceKind: 'conversation', sourceId: c.id, lastEnrichedMessageCount: rows.length, lastRun: new Date(), status: 'ok' })
        .onConflictDoUpdate({
          target: [memEnrichmentState.sourceKind, memEnrichmentState.sourceId],
          set: { lastEnrichedMessageCount: rows.length, lastRun: new Date(), status: 'ok', error: null }
        })
    } catch (err) {
      await db.insert(memEnrichmentState)
        .values({ sourceKind: 'conversation', sourceId: c.id, lastRun: new Date(), status: 'error', error: String(err) })
        .onConflictDoUpdate({
          target: [memEnrichmentState.sourceKind, memEnrichmentState.sourceId],
          set: { lastRun: new Date(), status: 'error', error: String(err) }
        })
    }
  }

  return { conversationsProcessed: candidates.length, memoriesCreated }
}
