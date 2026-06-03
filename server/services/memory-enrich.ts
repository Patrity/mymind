import { and, eq, isNull, sql, notExists, gt } from 'drizzle-orm'
import { useDb } from '../db'
import { sessions, messages, memEnrichmentState } from '../db/schema'
import { chat } from '../lib/ai/chat'
import { parseMemories } from '../lib/ai/memory-extract'
import { createMemory } from './memory'

export interface EnrichMemoryResult {
  enriched: number
  candidates: number
  sessionsProcessed: number
  skipped: number
}

const TRANSCRIPT_CHAR_LIMIT = 12000
const HEAD_CHARS = 2000

const SYSTEM_PROMPT = `You extract durable, atomic memories from an AI coding session transcript. A memory is a fact still true/useful in 6 months. Scopes: 'user' (facts about the user/their preferences — be conservative), 'agent' (facts about this project/environment/how things are built), 'world' (external systems/APIs). Output STRICT JSON only: {"memories":[{"scope":"user|agent|world","content":"one atomic declarative fact, <=240 chars","tags":["kebab"],"confidence":0.0-1.0}]}. No prose.`

function buildTranscript(msgs: { role: string | null, content: string }[]): string {
  const lines = msgs.map(m => `[${m.role ?? 'unknown'}]\n${m.content}`)
  const full = lines.join('\n\n')

  if (full.length <= TRANSCRIPT_CHAR_LIMIT) return full

  // Keep head + tail, trim middle
  const head = full.slice(0, HEAD_CHARS)
  const tail = full.slice(-(TRANSCRIPT_CHAR_LIMIT - HEAD_CHARS))
  return `${head}\n\n[... transcript trimmed ...]\n\n${tail}`
}

/**
 * Run memory enrichment over sessions that have new messages since last enrichment.
 * Per-session failures are isolated — errors are logged and recorded in state.
 */
export async function runMemoryEnrichment({ limit = 10 }: { limit?: number } = {}): Promise<EnrichMemoryResult> {
  const db = useDb()

  // Select candidate sessions: message_count >= 4 AND
  // (no enrichment state row OR message_count > last_enriched_message_count)
  const candidateSessions = await db
    .select({
      id: sessions.id,
      messageCount: sessions.messageCount
    })
    .from(sessions)
    .where(
      and(
        gt(sessions.messageCount, 3), // message_count >= 4
        sql`(
          NOT EXISTS (
            SELECT 1 FROM mem_enrichment_state
            WHERE session_id = ${sessions.id}
          )
          OR EXISTS (
            SELECT 1 FROM mem_enrichment_state
            WHERE session_id = ${sessions.id}
              AND ${sessions.messageCount} > last_enriched_message_count
          )
        )`
      )
    )
    .limit(limit)

  let enriched = 0
  let candidates = 0
  let sessionsProcessed = 0
  let skipped = 0

  for (const session of candidateSessions) {
    try {
      // Load messages ordered by createdAt
      const msgs = await db
        .select({ role: messages.role, content: messages.content })
        .from(messages)
        .where(eq(messages.sessionId, session.id))
        .orderBy(messages.createdAt)

      if (msgs.length === 0) {
        skipped++
        continue
      }

      const transcript = buildTranscript(msgs)

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

      // Store each candidate
      for (const candidate of extracted) {
        try {
          await createMemory({
            scope: candidate.scope,
            content: candidate.content,
            tags: [...(candidate.tags ?? []), 'enrichment', 'unreviewed'],
            source: `enrichment:${session.id}`,
            sessionId: session.id,
            confidence: candidate.confidence ?? null,
            evidence: [{ sessionId: session.id, mergedAt: new Date().toISOString() }]
          })
          enriched++
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

      // Record error in state — advance watermark to current messageCount so
      // this session is NOT re-picked on the next run unless new messages arrive.
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
              lastEnrichedMessageCount: session.messageCount,
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

  return { enriched, candidates, sessionsProcessed, skipped }
}
