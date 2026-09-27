// server/lib/agent/runtime/summarize.ts
// The incremental thread summary writer — conversations.summary's first writer. Off the hot
// path: called after a run persists, and by the */10 idle sweep. Folds everything but the last
// SUMMARY_KEEP_TURNS turns into prose, advances summarized_through to the last folded row's
// created_at (a POSTGRES timestamp, read back from the row — never the app clock).
import { and, eq, isNotNull, sql } from 'drizzle-orm'
import { useDb } from '../../../db'
import { conversations } from '../../../db/schema'
import { loadActivePath } from '../../../services/conversation-path'
import { rowToAgentMessage } from '../../../services/conversations'
import { chat } from '../../ai/chat'
import { embedOne } from '../../ai/embeddings'
import { messageText } from '../run'
import { groupTurns, turnTier } from './history'

export const SUMMARY_TRIGGER_TOKENS = 12_000
export const SUMMARY_KEEP_TURNS = 6
export const SIDE_THREAD_IDLE_MS = 30 * 60_000

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

export async function maybeSummarize(conversationId: string, opts: {
  force?: boolean
  summarizer?: (prev: string | null, transcript: string) => Promise<string>
  embed?: (t: string) => Promise<number[] | null>
} = {}): Promise<'skipped' | 'summarized'> {
  const { rows } = await loadActivePath(conversationId, { sinceEpoch: true, sinceSummary: true })
  const msgs = rows.map(r => ({ row: r, msg: rowToAgentMessage(r) }))
  const turns = groupTurns(msgs.map(m => m.msg))
  const tokens = turns.reduce((n, t, i) => n + turnTier(t, i).tokens, 0)
  if (turns.length <= SUMMARY_KEEP_TURNS) return 'skipped'
  if (!opts.force && tokens <= SUMMARY_TRIGGER_TOKENS) return 'skipped'

  const foldCount = turns.slice(0, -SUMMARY_KEEP_TURNS).reduce((n, t) => n + t.length, 0)
  const folded = msgs.slice(0, foldCount)
  const transcript = folded.map(({ msg }) => `${msg.role === 'user' ? 'Tony' : 'Bridget'}: ${messageText(msg.content)}`).join('\n\n')
  const [conv] = await useDb().select({ summary: conversations.summary }).from(conversations).where(eq(conversations.id, conversationId)).limit(1)

  let summary: string
  try {
    summary = (await (opts.summarizer ?? defaultSummarizer)(conv?.summary ?? null, transcript)).trim()
  } catch (err) {
    console.warn('[summarize] summarizer failed — tail stays longer, next trigger retries:', err)
    return 'skipped'
  }
  if (!summary) return 'skipped'
  let vec: number[] | null = null
  try { vec = await (opts.embed ?? embedOne)(summary) } catch { /* keep null; next fold re-embeds */ }

  const through = folded[folded.length - 1]!.row.createdAt
  await useDb().update(conversations).set({
    summary, summarizedThrough: through, ...(vec ? { summaryEmbedding: vec as never } : {}), updatedAt: sql`now()`
  }).where(eq(conversations.id, conversationId))
  return 'summarized'
}

export async function summarizeIdleThreads(): Promise<number> {
  const idle = await useDb().select({ id: conversations.id }).from(conversations).where(and(
    eq(conversations.kind, 'thread'),
    isNotNull(conversations.lastMessageAt),
    sql`${conversations.lastMessageAt} < now() - make_interval(secs => ${SIDE_THREAD_IDLE_MS / 1000})`,
    sql`(${conversations.summarizedThrough} is null or ${conversations.summarizedThrough} < ${conversations.lastMessageAt})`,
    sql`${conversations.lastMessageAt} > now() - interval '7 days'`
  )).limit(20)
  let n = 0
  for (const c of idle) if (await maybeSummarize(c.id, { force: true }).catch(() => 'skipped') === 'summarized') n++
  return n
}
