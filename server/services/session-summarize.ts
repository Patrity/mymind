import { and, eq, sql } from 'drizzle-orm'
import { useDb } from '../db'
import { sessions, messages, toolEvents, sessSummaryState } from '../db/schema'
import { chat } from '../lib/ai/chat'
import { embedOne } from '../lib/ai/embeddings'
import { publishChange } from '../utils/live-bus'

export interface SummaryResult { enriched: number, processed: number, skipped: number }

const MIN_MESSAGES = 6
const REFRESH_DELTA = 50
const STALE_HOURS = 24
const PER_RUN = 30
const MAX_INPUT_CHARS = 60000

const SYSTEM_PROMPT = `You summarize an AI coding/work session. Output STRICT JSON only: {"title": "...", "summary": "..."}. TITLE: <=100 chars, topical/imperative, no "Tony asked about…" — name the concrete thing done. SUMMARY: 3-6 sentences, neutral past-tense changelog voice (no "successfully", no "comprehensive"): the intent, key decisions/trade-offs, concrete artifacts (names/ids/paths), and the open next step if any. No prose outside the JSON.`

export function parseSummary(raw: string): { title: string, summary: string } | null {
  const s = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  let obj: unknown = null
  try { obj = JSON.parse(s) } catch {
    const m = s.match(/\{[\s\S]*\}/)
    if (m) { try { obj = JSON.parse(m[0]) } catch { /* fall through */ } }
  }
  if (!obj || typeof obj !== 'object') return null
  const o = obj as Record<string, unknown>
  const title = typeof o.title === 'string' ? o.title.slice(0, 200) : ''
  const summary = typeof o.summary === 'string' ? o.summary.slice(0, 4000) : ''
  if (!summary.trim()) return null
  return { title, summary }
}

export function buildSummaryTranscript(
  msgs: { role: string | null, content: string, thinking: string | null }[],
  tools: { toolName: string, exitStatus: string | null }[],
  maxChars = MAX_INPUT_CHARS
): string {
  const lines = msgs.map(m => {
    const think = m.thinking ? ` <thinking>${m.thinking}</thinking>` : ''
    return `[${m.role ?? 'unknown'}] ${m.content}${think}`
  })
  const toolLine = tools.length
    ? '\n[tools] ' + tools.map(t => `[tool] ${t.toolName}${t.exitStatus ? '→' + t.exitStatus : ''}`).join(' ')
    : ''
  let body = lines.join('\n') + toolLine
  if (body.length > maxChars) {
    const head = Math.floor(maxChars * 0.3), tail = maxChars - head
    body = body.slice(0, head) + `\n[… ${msgs.length} messages elided …]\n` + body.slice(-tail)
  }
  return body
}

export async function runSessionSummarize({ limit = PER_RUN }: { limit?: number } = {}): Promise<SummaryResult> {
  const db = useDb()
  // Candidates via drizzle-select + sql subqueries in the where (clean typed rows; mirrors
  // server/services/memory-enrich.ts). Real-message floor >= MIN_MESSAGES, AND
  // (never summarized | prior error | grew by >= REFRESH_DELTA | stale > STALE_HOURS with new msgs).
  const candidates = await db.select({ id: sessions.id })
    .from(sessions)
    .where(and(
      sql`(select count(*) from ${messages} m where m.session_id = ${sessions.id}
            and m.role in ('user','assistant')
            and (coalesce(m.content,'') <> '' or coalesce(m.thinking,'') <> '')
            and coalesce((m.metadata->>'system_prompt')::boolean, false) is not true) >= ${MIN_MESSAGES}`,
      sql`(not exists (select 1 from ${sessSummaryState} st where st.session_id = ${sessions.id})
        or exists (select 1 from ${sessSummaryState} st where st.session_id = ${sessions.id} and (
             st.status = 'error'
             or (${sessions.messageCount} - coalesce(st.last_summarized_message_count, 0)) >= ${REFRESH_DELTA}
             or (${sessions.lastActive} > st.last_run + (${STALE_HOURS} * interval '1 hour') and ${sessions.messageCount} > coalesce(st.last_summarized_message_count, 0)))))`
    ))
    .orderBy(sessions.lastActive)
    .limit(limit)

  let enriched = 0, processed = 0, skipped = 0
  for (const c of candidates) {
    const sessionId = c.id
    const t0 = Date.now()
    try {
      const msgs = await db.select({ role: messages.role, content: messages.content, thinking: messages.thinking, createdAt: messages.createdAt })
        .from(messages).where(eq(messages.sessionId, sessionId)).orderBy(messages.createdAt)
      const real = msgs.filter(m => (m.role === 'user' || m.role === 'assistant') && ((m.content ?? '') !== '' || (m.thinking ?? '') !== ''))
      if (real.length === 0) { await upsertState(sessionId, 0, 'skipped', null, Date.now() - t0); skipped++; continue }
      const tools = await db.select({ toolName: toolEvents.toolName, exitStatus: toolEvents.exitStatus })
        .from(toolEvents).where(eq(toolEvents.sessionId, sessionId)).limit(40)
      const transcript = buildSummaryTranscript(real, tools)
      // 'bulk' = no-think model: this is a capped, single-shot summary. The
      // reasoning alias emits <think>/reasoning_content and returns null content
      // under the token cap, which chat() throws on (rescued only by failover).
      const raw = await chat('bulk', [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: transcript }
      ], { temperature: 0.3, maxTokens: 1024 })
      const parsed = parseSummary(raw)
      if (!parsed) { await upsertState(sessionId, msgs.length, 'error', 'unparseable summary', Date.now() - t0); skipped++; continue }
      let vec: number[] | null = null
      try { vec = await embedOne(`${parsed.title}\n\n${parsed.summary}`) } catch { /* keep null, retry next run */ }
      await db.update(sessions).set({
        title: sql`coalesce(nullif(${parsed.title}, ''), ${sessions.title})`,
        summary: parsed.summary,
        ...(vec ? { summaryEmbedding: vec as any, lastEmbeddedAt: new Date() } : {})
      }).where(eq(sessions.id, sessionId))
      await upsertState(sessionId, msgs.length, 'ok', null, Date.now() - t0, parsed)
      publishChange({ resource: 'session', action: 'updated', id: sessionId })
      enriched++; processed++
    } catch (err) {
      await upsertState(sessionId, 0, 'error', String(err), Date.now() - t0); skipped++
    }
  }
  return { enriched, processed, skipped }
}

async function upsertState(sessionId: string, count: number, status: string, error: string | null, durationMs: number, parsed?: { title: string, summary: string }) {
  const db = useDb()
  const set = { lastSummarizedMessageCount: count, lastRun: new Date(), status, error, durationMs, updatedAt: new Date(),
    summaryChars: parsed?.summary.length ?? null, titleChars: parsed?.title.length ?? null }
  await db.insert(sessSummaryState).values({ sessionId, ...set })
    .onConflictDoUpdate({ target: sessSummaryState.sessionId, set })
}
