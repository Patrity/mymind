// server/lib/agent/reflect/candidates.ts
//
// Which threads the per-thread reflection pass looks at, and the watermark it advances.
// Modelled on idleThreadCandidates (runtime/summarize.ts): same idle shape, but keyed on
// reflected_through, and main is included (the spec's per-thread pass covers Bridget's home thread).
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { useDb } from '../../../db'
import { conversations } from '../../../db/schema'

/** Spec §4.1, verbatim: ≥ 4 new messages, idle ≥ 30 min, not reflected in the last 2 h. */
export const REFLECT_MIN_NEW_MESSAGES = 4
export const REFLECT_IDLE_MS = 30 * 60_000
export const REFLECT_COOLDOWN_MS = 2 * 3600_000
export const REFLECT_CANDIDATE_LIMIT = 5

export async function threadCandidates(
  opts: { now?: Date; limit?: number; onlyConversationIds?: string[] } = {}
): Promise<{ conversationId: string; since: Date | null }[]> {
  const now = sql`${(opts.now ?? new Date()).toISOString()}::timestamptz`
  const rows = await useDb().select({ id: conversations.id, since: conversations.reflectedThrough }).from(conversations).where(and(
    // Test seam: the dev DB is shared, so a test scopes the query to its own threads.
    opts.onlyConversationIds ? inArray(conversations.id, opts.onlyConversationIds) : undefined,
    isNotNull(conversations.lastMessageAt),
    sql`${conversations.lastMessageAt} <= ${now} - make_interval(secs => ${REFLECT_IDLE_MS / 1000})`,
    sql`(${conversations.reflectedThrough} is null or ${conversations.reflectedThrough} < ${now} - make_interval(secs => ${REFLECT_COOLDOWN_MS / 1000}))`,
    // Conversation turns only — 'event' rows are system notices, not something Bridget did.
    // Millisecond-truncated like summarize.ts: the watermark is written from a JS Date, so rows
    // of the same append compare µs-greater than it.
    sql`(select count(*) from conversation_messages m where m.conversation_id = ${conversations.id}
          and m.role in ('user', 'assistant')
          and date_trunc('milliseconds', m.created_at) > coalesce(${conversations.reflectedThrough}, '-infinity'::timestamptz)) >= ${REFLECT_MIN_NEW_MESSAGES}`
  )).orderBy(desc(conversations.lastMessageAt)).limit(opts.limit ?? REFLECT_CANDIDATE_LIMIT)
  return rows.map(r => ({ conversationId: r.id, since: r.since }))
}

/** Advance the watermark: the pass covered every message with created_at <= `through`. */
export async function markReflected(conversationId: string, through: Date): Promise<void> {
  await useDb().update(conversations).set({ reflectedThrough: through }).where(eq(conversations.id, conversationId))
}
