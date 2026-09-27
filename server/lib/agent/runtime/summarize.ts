// server/lib/agent/runtime/summarize.ts
// The incremental thread summary writer — conversations.summary's first writer. Off the hot
// path: called after a run persists, and by the */10 idle sweep. Folds the oldest turns outside
// the last SUMMARY_KEEP_TURNS (at most SUMMARY_FOLD_MAX_TOKENS of transcript per call) into
// prose, advances summarized_through to the last folded row's created_at (a POSTGRES
// timestamp, read back from the row — never the app clock).
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { useDb } from '../../../db'
import { conversations } from '../../../db/schema'
import { loadActivePath } from '../../../services/conversation-path'
import { rowToAgentMessage } from '../../../services/conversations'
import { chat } from '../../ai/chat'
import { embedOne } from '../../ai/embeddings'
import { messageText } from '../run'
import { estimateTokens } from '../../chunking/chunk-markdown'
import { groupTurns, costTurns, capToTokens } from './history'

export const SUMMARY_TRIGGER_TOKENS = 12_000
export const SUMMARY_KEEP_TURNS = 6
export const SIDE_THREAD_IDLE_MS = 30 * 60_000
/** Most transcript one fold sends the summarizer (final review I6). A thread's FIRST fold used
 *  to send everything but the tail in one call — a long thread's whole history, far past what
 *  the bulk model takes. Now each call folds the oldest turns up to this, advances
 *  summarized_through to the end of that chunk, and the next fold continues from there. */
export const SUMMARY_FOLD_MAX_TOKENS = 24_000
/** The idle sweep only looks at threads with more than this many messages: at most
 *  SUMMARY_KEEP_TURNS turns (≥ 2 rows each) can never have anything to fold. */
export const SWEEP_MIN_MESSAGES = 12

const SYSTEM = [
  'You maintain the running summary of a conversation between Tony and his assistant Bridget.',
  'Given the PREVIOUS summary (may be empty) and NEW transcript turns, write the updated summary.',
  'First paragraph: what Tony is working on right now, in 1-3 sentences. Then short paragraphs: decisions made, open questions, things Bridget promised to do.',
  'Plain prose, no headings, no bullet markers, under 250 words. Never invent anything not in the text.'
].join('\n')

async function defaultSummarizer(prev: string | null, transcript: string): Promise<string> {
  return chat('bulk', [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `PREVIOUS SUMMARY:\n${prev ?? '(none)'}\n\nNEW TURNS:\n${transcript}` }
  ], { temperature: 0.2, maxTokens: 700 })
}

/** Speaker label per ROW, not per mapped message (final review m2): rowToAgentMessage maps an
 *  event row to the user role, so labelling the mapped message said "Tony:" for a wake prompt
 *  or a restart note. An event row's model text already opens with "Background wake (…):" or
 *  "Note (…):" (eventModelText), so it gets no speaker prefix at all. */
function transcriptLine(row: { role: string }, msg: { role: string; content: unknown }): string {
  const text = messageText(msg.content as never)
  if (row.role === 'event') return text
  return `${row.role === 'user' ? 'Tony' : 'Bridget'}: ${text}`
}

export type SummarizeOutcome = 'skipped' | 'summarized' | 'failed'

export async function maybeSummarize(conversationId: string, opts: {
  force?: boolean
  summarizer?: (prev: string | null, transcript: string) => Promise<string>
  embed?: (t: string) => Promise<number[] | null>
} = {}): Promise<SummarizeOutcome> {
  // Read the epoch WITH the summary, at fold start (final review I5). The summarizer call takes
  // seconds; a /clear landing meanwhile nulls the summary and moves the epoch, and an
  // unconditional write afterwards would resurrect everything it just forgot. The epoch is read
  // as TEXT so the guard below compares Postgres's own microsecond value, not a millisecond Date.
  const [conv] = await useDb().select({ summary: conversations.summary, epoch: sql<string | null>`${conversations.contextEpochAt}::text` })
    .from(conversations).where(eq(conversations.id, conversationId)).limit(1)
  if (!conv) return 'skipped'
  const { rows } = await loadActivePath(conversationId, { sinceEpoch: true, sinceSummary: true })
  const msgs = rows.map(r => ({ row: r, msg: rowToAgentMessage(r) }))
  const turns = groupTurns(msgs.map(m => m.msg))
  const tokens = costTurns(turns).reduce((n, t) => n + t.tokens, 0)
  if (turns.length <= SUMMARY_KEEP_TURNS) return 'skipped'
  if (!opts.force && tokens <= SUMMARY_TRIGGER_TOKENS) return 'skipped'

  // Fold the OLDEST foldable turns, whole turns only, up to SUMMARY_FOLD_MAX_TOKENS of
  // transcript (always at least one turn, so a single giant turn still makes progress — capped).
  const foldable = turns.slice(0, -SUMMARY_KEEP_TURNS)
  let foldCount = 0, used = 0, taken = 0
  const lines: string[] = []
  for (const turn of foldable) {
    const turnLines = msgs.slice(foldCount, foldCount + turn.length).map(({ row, msg }) => transcriptLine(row, msg))
    const cost = estimateTokens(turnLines.join('\n\n'))
    if (taken > 0 && used + cost > SUMMARY_FOLD_MAX_TOKENS) break
    lines.push(...turnLines); used += cost; foldCount += turn.length; taken++
  }
  const folded = msgs.slice(0, foldCount)
  const transcript = capToTokens(lines.join('\n\n'), SUMMARY_FOLD_MAX_TOKENS)

  let summary: string
  try {
    summary = (await (opts.summarizer ?? defaultSummarizer)(conv.summary ?? null, transcript)).trim()
  } catch (err) {
    console.warn('[summarize] summarizer failed — tail stays longer, next trigger retries:', err)
    return 'failed'
  }
  if (!summary) return 'failed'
  let vec: number[] | null = null
  try { vec = await (opts.embed ?? embedOne)(summary) } catch { /* keep null; next fold re-embeds */ }

  const through = folded[folded.length - 1]!.row.createdAt
  const written = await useDb().update(conversations).set({
    summary, summarizedThrough: through, ...(vec ? { summaryEmbedding: vec as never } : {}), updatedAt: sql`now()`
  }).where(and(
    eq(conversations.id, conversationId),
    sql`${conversations.contextEpochAt} is not distinct from ${conv.epoch}::timestamptz`
  )).returning({ id: conversations.id })
  if (!written.length) {
    console.info(`[summarize] ${conversationId}: context was cleared mid-fold — fold discarded`)
    return 'skipped'
  }
  return 'summarized'
}

/** The every-10-minutes idle sweep. Most-recently-active first, and only threads that can have something
 *  to fold (final review I6): the old unordered `limit 20` over every idle thread kept picking
 *  the same already-folded threads, whose summarized_through always trails last_message_at by
 *  the kept tail, and starved the rest. The unsummarised-row count excludes a thread whose
 *  folds have caught up to its tail. */
export async function idleThreadCandidates(opts: { onlyIds?: string[] } = {}): Promise<string[]> {
  const rows = await useDb().select({ id: conversations.id }).from(conversations).where(and(
    // Test seam: the dev DB is shared, so a test scopes the sweep query to its own threads.
    opts.onlyIds ? inArray(conversations.id, opts.onlyIds) : undefined,
    eq(conversations.kind, 'thread'),
    isNotNull(conversations.lastMessageAt),
    sql`${conversations.lastMessageAt} < now() - make_interval(secs => ${SIDE_THREAD_IDLE_MS / 1000})`,
    sql`(${conversations.summarizedThrough} is null or ${conversations.summarizedThrough} < ${conversations.lastMessageAt})`,
    sql`${conversations.lastMessageAt} > now() - interval '7 days'`,
    sql`${conversations.messageCount} > ${SWEEP_MIN_MESSAGES}`,
    // Millisecond-truncated, matching loadActivePath's JS-Date comparison: summarized_through
    // is written from a JS Date, so the rows of its own append compare µs-greater than it.
    sql`(select count(*) from conversation_messages m where m.conversation_id = ${conversations.id}
          and date_trunc('milliseconds', m.created_at) > coalesce(${conversations.summarizedThrough}, '-infinity'::timestamptz)
          and date_trunc('milliseconds', m.created_at) >= coalesce(date_trunc('milliseconds', ${conversations.contextEpochAt}), '-infinity'::timestamptz)) > ${SWEEP_MIN_MESSAGES}`
  )).orderBy(desc(conversations.lastMessageAt)).limit(20)
  return rows.map(r => r.id)
}

export async function summarizeIdleThreads(): Promise<{ summarized: number; failed: number }> {
  let summarized = 0, failed = 0
  for (const id of await idleThreadCandidates()) {
    const r = await maybeSummarize(id, { force: true }).catch((err) => {
      console.warn('[summarize] idle fold failed:', err)
      return 'failed' as const
    })
    if (r === 'summarized') summarized++
    else if (r === 'failed') failed++
  }
  return { summarized, failed }
}
