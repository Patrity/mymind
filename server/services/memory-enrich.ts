import { and, eq, sql } from 'drizzle-orm'
import { useDb } from '../db'
import { sessions, messages, memEnrichmentState, toolEvents, projects } from '../db/schema'
import { chat } from '../lib/ai/chat'
import { parseMemories } from '../lib/ai/memory-extract'
import { resolveEnrichedMemory } from './memory-resolve'
import { projectIdForScope } from '../lib/projects/memory-project'

export interface EnrichMemoryResult {
  enriched: number
  candidates: number
  sessionsProcessed: number
  skipped: number
  actions: { inserted: number, superseded: number, contradicted: number, duplicate: number, reviewQueued: number }
}

const TRANSCRIPT_CHAR_LIMIT = 12000
const HEAD_CHARS = 2000

const SYSTEM_PROMPT = `You extract a SMALL number of DURABLE, HIGH-SIGNAL memories from an AI work-session transcript, for a long-term memory store serving Tony, a software engineer. Be RUTHLESSLY selective: most sessions yield 0-3 memories. If nothing is durably significant, return an empty list — that is a correct and common answer.

Each memory is a single atomic fact, present tense ("X is Y", not "we decided/shipped X"), <=240 chars, that a future session MONTHS from now would benefit from. The test for every candidate: "Will this still be true AND useful in 6 months, independent of this session?" If not, DROP it.

EXTRACT (high signal): durable architecture/design decisions + their rationale; stable project conventions, constraints, and invariants; non-obvious gotchas/footguns and how to avoid them; durable service/host/path/config facts; durable facts about Tony (preferences, identity, how he likes to work); non-obvious reusable facts about external systems (libraries/APIs/Postgres).

DO NOT EXTRACT (these are the most common mistakes — reject them):
- Transient state: test counts ("98 tests pass"), build/CI status, coverage numbers, "currently/now/the current X", what is in-progress, TODOs, what was "just shipped/built/fixed".
- In-progress bug details that get fixed within the session. (A durable LESSON from the fix can qualify; the bug-of-the-moment does not.)
- Anything about the AI's OWN process or tooling: skills (e.g. "superpowers:X", "the debugging skill"), the agent's workflow, "Tony uses the X skill", the agent's own review/commit/TDD conventions.
- Session narration: "Tony asked…", "we explored…", "the task is…", "this session…".
- Volatile specifics that churn: exact file paths, line numbers, commit SHAs, in-flux version numbers.

CONFIDENCE = DURABILITY + reusability, NOT how clearly you observed it. A precisely-observed fact that won't matter next month is LOW confidence. Bands: 0.85-1.0 = durable and clearly reusable; 0.6-0.84 = likely durable; below 0.6 DO NOT EMIT.

SCOPES: 'user' = durable facts about Tony (be conservative, never fabricate). 'agent' = the project/environment (most common). 'world' = external systems (only non-obvious, reusable).

For each memory: cite the transcript message ids that justify it (evidence_msg_ids), a short verbatim quote (<=240 chars), and one-line reasoning that states WHY it is durable (not just true).
Output STRICT JSON ONLY: {"memories":[{"scope":"user|agent|world","content":"...","tags":["kebab"],"confidence":0.0-1.0,"evidence_msg_ids":["..."],"quote":"...","reasoning":"..."}]}. No prose.`

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
        sql`(not exists (select 1 from ${memEnrichmentState} e where e.session_id = ${sessions.id})
          or exists (select 1 from ${memEnrichmentState} e where e.session_id = ${sessions.id} and (
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

      // Call the LLM
      const raw = await chat(
        'reasoning',
        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: transcript }
        ],
        { temperature: 0.2, maxTokens: 1200 }
      )

      const extracted = parseMemories(raw)
      candidates += extracted.length

      // Store each candidate with rich provenance via resolution orchestrator
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
          if (plan.action === 'insert') actions.inserted++
          else if (plan.action === 'supersede') actions.superseded++
          else if (plan.action === 'contradict') { actions.contradicted++; actions.reviewQueued++ }
          else if (plan.action === 'review-supersede') actions.reviewQueued++
          else if (plan.action === 'duplicate') actions.duplicate++
        } catch (memErr) {
          console.warn(`[memory-enrich] failed to store candidate for session ${session.id}:`, memErr)
        }
      }

      // Upsert enrichment state
      await db
        .insert(memEnrichmentState)
        .values({
          sessionId: session.id,
          lastEnrichedMessageCount: session.messageCount,
          lastRun: new Date(),
          status: 'ok',
          error: null
        })
        .onConflictDoUpdate({
          target: memEnrichmentState.sessionId,
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
            sessionId: session.id,
            lastEnrichedMessageCount: session.messageCount,
            lastRun: new Date(),
            status: 'error',
            error: String(err)
          })
          .onConflictDoUpdate({
            target: memEnrichmentState.sessionId,
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
