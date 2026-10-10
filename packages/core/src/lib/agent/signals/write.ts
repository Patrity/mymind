// server/lib/agent/signals/write.ts
// Cycle 76 (spec §3): engagement signals on job messages, written by existing code paths, never
// by the model. A job run's assistant message opens a 2 h observation window (derived from the
// message's created_at — nothing is recorded when it opens). Within it:
//   - Tony's next message in main → `replied` (+ `said_stop` / `said_thanks` from its text);
//   - a tapback on its iMessage delivery → `tapback_positive` / `tapback_negative`.
// A window that closes with no signal at all → `ignored` (the nightly jobs pass calls
// closeObservations). The unique index (message_id, kind) keeps one row per kind per message, so
// every insert here is ON CONFLICT DO NOTHING and duplicates are free.
//
// Every writer is called fire-and-forget from a user-facing path: callers catch and log, and a
// failure here never touches the user's turn (spec §9).
import { and, eq, gt, gte, inArray, isNotNull, lt, lte, notExists, sql, type SQL } from 'drizzle-orm'
import { useDb } from '../../../db'
import { agentRuns, agentSignals, channelDeliveries, conversationMessages, settings } from '../../../db/schema'
import { findMain } from '../runtime/sessions'
import { loadChannelsConfig } from '../../channels/config'
import { isAllowed, isSendersDirectChat } from '../../channels/handles'
import type { TapbackEvent } from '../../channels/types'
import { classifyReplyText, tapbackSignal, OBSERVATION_WINDOW_MS, type SignalKind } from './classify'

/** A reply's text kept as the signal's detail (the reflector reads up to 5 snippets per job). */
const DETAIL_MAX = 200

/** closeObservations never looks further back than this (the jobs pass reads 14 days). */
export const CLOSE_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000

/** Settings key: when signals started being recorded. Job messages older than it were never
 *  observed, so they are never judged `ignored`. Written once, by the first closeObservations. */
export const SIGNALS_STARTED_AT_KEY = 'signals_started_at'

type SignalInsert = typeof agentSignals.$inferInsert

async function insertSignals(rows: SignalInsert[]): Promise<number> {
  if (!rows.length) return 0
  const written = await useDb().insert(agentSignals).values(rows).onConflictDoNothing().returning({ id: agentSignals.id })
  return written.length
}

/** The run → its assistant message join every query below starts from: job runs that spoke. */
function jobMessages() {
  return useDb().select({
    messageId: conversationMessages.id,
    jobId: agentRuns.jobId,
    runId: agentRuns.id
  }).from(agentRuns)
    .innerJoin(conversationMessages, eq(conversationMessages.id, agentRuns.assistantMessageId))
}

function withoutSignal(): SQL {
  return notExists(useDb().select({ one: sql`1` }).from(agentSignals).where(eq(agentSignals.messageId, conversationMessages.id)))
}

/**
 * The post-run hook (jobs/outcome.ts) for a job run that spoke. Records nothing: the window is
 * the message's own created_at + OBSERVATION_WINDOW_MS, and the writers below derive it. Kept as
 * the one named place a job message enters observation.
 */
export async function openObservation(run: { id: string; jobId: string | null; assistantMessageId?: string | null }): Promise<void> {
  if (!run.jobId || !run.assistantMessageId) return
}

/**
 * Tony wrote in main at `at`. Every job assistant message in main whose window holds `at` gets
 * `replied` (its detail is the first reply's text), plus whatever this text classifies as — a
 * later "stop" still counts after an earlier "ok". The unique index keeps one row per kind.
 * Returns the rows written. Main is looked up read-only: with no main yet there is nothing to
 * reply to. `mainConversationId` is the test seam: tests must never read or write real main.
 */
export async function noteUserReply(
  i: { conversationId: string; text: string; at: Date },
  opts: { mainConversationId?: string } = {}
): Promise<number> {
  const mainId = opts.mainConversationId ?? await findMain()
  if (!mainId || i.conversationId !== mainId) return 0
  const open = await jobMessages().where(and(
    isNotNull(agentRuns.jobId),
    eq(agentRuns.conversationId, mainId), // a run's reply is written to its own thread
    // Bounds the scan of main's runs, which otherwise grows forever (final review m6): a run
    // whose message is still in its 2 h window started well inside the 14 days the jobs pass reads.
    gte(agentRuns.createdAt, new Date(i.at.getTime() - CLOSE_LOOKBACK_MS)),
    gte(conversationMessages.createdAt, new Date(i.at.getTime() - OBSERVATION_WINDOW_MS)),
    lte(conversationMessages.createdAt, i.at)
  ))
  if (!open.length) return 0
  const kinds: SignalKind[] = ['replied', ...classifyReplyText(i.text)]
  const detail = i.text.trim().slice(0, DETAIL_MAX) || null
  return insertSignals(open.flatMap(m => kinds.map(kind => ({ jobId: m.jobId, runId: m.runId, messageId: m.messageId, kind, detail }))))
}

/**
 * A tapback that was not an approval answer. When it targets a job's iMessage delivery
 * (channel_deliveries.external_id = the tapped message's GUID) → a tapback_* signal on that
 * delivery's message. The same filters as resolveTapback: removed tapbacks, Bridget's own, group
 * chats, a chat that is not the sender's own direct chat and senders off the allowlist say
 * nothing; nor does `question`. True when a signal row was written.
 */
export async function noteTapback(ev: TapbackEvent): Promise<boolean> {
  if (ev.removed || ev.isFromMe || ev.chatGuid.includes(';+;')) return false
  if (!isSendersDirectChat(ev.chatGuid, ev.sender)) return false
  const kind = tapbackSignal(ev.tapback)
  if (!kind) return false
  if (!isAllowed(ev.sender, (await loadChannelsConfig()).imessage.allowedHandles)) return false
  const [d] = await useDb().select({
    id: channelDeliveries.id, jobId: channelDeliveries.jobId, runId: channelDeliveries.runId, messageId: channelDeliveries.messageId
  }).from(channelDeliveries).where(and(
    eq(channelDeliveries.channel, 'imessage'),
    eq(channelDeliveries.externalId, ev.targetGuid),
    isNotNull(channelDeliveries.jobId)
  )).limit(1)
  if (!d) return false
  return (await insertSignals([{ jobId: d.jobId, runId: d.runId, messageId: d.messageId, deliveryId: d.id, kind, detail: ev.tapback }])) > 0
}

/** The signals_started_at setting, written as `now` when absent (the first caller wins a race). */
export async function signalsStartedAt(now: Date = new Date()): Promise<Date> {
  await useDb().insert(settings).values({ key: SIGNALS_STARTED_AT_KEY, value: now.toISOString() }).onConflictDoNothing()
  const [row] = await useDb().select({ value: settings.value }).from(settings).where(eq(settings.key, SIGNALS_STARTED_AT_KEY)).limit(1)
  const d = typeof row?.value === 'string' ? new Date(row.value) : null
  return d && !Number.isNaN(d.getTime()) ? d : now
}

/**
 * Close every window that ended before `now` with no signal of any kind: `ignored`. Only job
 * messages created after signals_started_at and within CLOSE_LOOKBACK_MS are judged: older ones
 * were never observed. Returns the rows written. Test seams (the dev DB is shared with real
 * jobs and settings): `onlyJobIds`, and `startedAt` in place of the settings key.
 */
export async function closeObservations(now: Date = new Date(), opts: { onlyJobIds?: string[]; startedAt?: Date } = {}): Promise<number> {
  if (opts.onlyJobIds && !opts.onlyJobIds.length) return 0
  const startedAt = opts.startedAt ?? await signalsStartedAt(now)
  const since = new Date(Math.max(startedAt.getTime(), now.getTime() - CLOSE_LOOKBACK_MS))
  const closed = await jobMessages().where(and(
    isNotNull(agentRuns.jobId),
    opts.onlyJobIds ? inArray(agentRuns.jobId, opts.onlyJobIds) : undefined,
    gt(conversationMessages.createdAt, since),
    lt(conversationMessages.createdAt, new Date(now.getTime() - OBSERVATION_WINDOW_MS)),
    withoutSignal()
  ))
  return insertSignals(closed.map(m => ({ jobId: m.jobId, runId: m.runId, messageId: m.messageId, kind: 'ignored' as const })))
}
