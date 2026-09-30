// server/lib/channels/approvals.ts
// Exec approvals over iMessage (spec §6). A run that answers over iMessage (`reply_to`) gets an
// approval channel that texts "Run `cmd`? 👍 to approve · 👎 to deny" to the reply chat and waits:
// a 👍/❤️ tapback from an allowed handle on THAT message in THAT chat approves, 👎 denies, and
// 10 minutes of silence expires (= denies).
//
// The outcome lives in `channel_approvals.status`. Every transition out of `pending` is a
// conditional update guarded on `status = 'pending'`, so a tapback racing the expiry ends with
// exactly one outcome — whichever update matched — and the loser re-reads it. The waiter learns
// it either from the in-process map (resolveTapback in this process) or from the DB poll (a
// tapback handled by another process, or before a restart dropped the map entry).
import { randomUUID } from 'node:crypto'
import { and, eq, gt, inArray, lte, type SQL } from 'drizzle-orm'
import { useDb } from '../../db'
import { agentRuns, channelApprovals } from '../../db/schema'
import type { ApprovalRequest } from '../agent/types'
import { recordEvent } from '../observability/record'
import { loadChannelsConfig } from './config'
import { isAllowed, isSendersDirectChat } from './handles'
import { lastHealth } from './inbound'
import { imessageClient, type BlueBubblesClient } from './bluebubbles/client'
import type { TapbackEvent } from './types'

export const APPROVAL_TIMEOUT_MS = 600_000
const DEFAULT_POLL_MS = 5_000

type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired'
type Channel = (req: ApprovalRequest) => Promise<{ approved: boolean }>

export interface ApprovalChannelDeps {
  client?: BlueBubblesClient | null
  pollMs?: number
  timeoutMs?: number
  /** The run's abort signal (the runner passes `ac.signal`). Stop / `/clear` abort the run; the
   *  exec tool awaits the approval without racing the signal, so the wait itself must end on it
   *  (final review I1) — otherwise the run stays `running` until the 10-min expiry. */
  signal?: AbortSignal
}

// In-process waiters keyed by approval id; resolveTapback / expireApprovals wake them directly.
const waiters = new Map<string, (status: ApprovalStatus) => void>()

/** The command as texted: at most PROMPT_COMMAND_MAX chars (a long heredoc is not texted in full). */
export const PROMPT_COMMAND_MAX = 300

function promptText(req: ApprovalRequest): string {
  const cmd = req.command.length > PROMPT_COMMAND_MAX ? `${req.command.slice(0, PROMPT_COMMAND_MAX - 1)}…` : req.command
  return `Run \`${cmd}\`?\n👍 to approve · 👎 to deny`
}

/** pending → `to`, only if still pending. True when this call made the transition. */
async function settle(id: string, to: Exclude<ApprovalStatus, 'pending'>): Promise<boolean> {
  const rows = await useDb().update(channelApprovals).set({ status: to, resolvedAt: new Date() })
    .where(and(eq(channelApprovals.id, id), eq(channelApprovals.status, 'pending')))
    .returning({ id: channelApprovals.id })
  return rows.length > 0
}

/** Stop's own update: pending OR approved → denied. A 👍 whose guarded update reached the row a
 *  moment before Stop left it `approved`, but the wait was denied and nothing ran — the audit
 *  row must say so. Only the abort may overwrite a decided row; tapback and expiry keep their
 *  pending-only guard (`settle`). */
async function denyOnAbort(id: string): Promise<void> {
  await useDb().update(channelApprovals).set({ status: 'denied', resolvedAt: new Date() })
    .where(and(eq(channelApprovals.id, id), inArray(channelApprovals.status, ['pending', 'approved'])))
}

async function statusOf(id: string): Promise<ApprovalStatus | null> {
  const [row] = await useDb().select({ status: channelApprovals.status }).from(channelApprovals)
    .where(eq(channelApprovals.id, id)).limit(1)
  return (row?.status as ApprovalStatus | undefined) ?? null
}

function logOutcome(runId: string, command: string, outcome: string, reason?: string): void {
  recordEvent({
    kind: 'tool', name: 'exec:approval', severity: outcome === 'approved' ? 'info' : 'warn',
    meta: { channel: 'imessage', runId, outcome, command, ...(reason ? { reason } : {}) }
  })
}

/** Wait until the row leaves `pending` (map or poll), or expire it after `timeoutMs`, or deny
 *  it the moment `signal` aborts (the run was stopped: nothing may approve it afterwards). */
function waitFor(id: string, pollMs: number, timeoutMs: number, signal?: AbortSignal): Promise<ApprovalStatus> {
  return new Promise((resolve) => {
    let done = false
    const finish = (s: ApprovalStatus) => {
      if (done) return
      done = true
      clearInterval(poll)
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (waiters.get(id) === finish) waiters.delete(id)
      resolve(s)
    }
    // Aborted: Stop always beats a late 👍. The wait is decided as denied SYNCHRONOUSLY, before
    // any await — `finish` drops the in-process waiter, so a tapback whose guarded update lands
    // in the same instant finds nothing to wake and can never flip this wait to approved (it
    // used to be decided only after the DB round trip, which a 👍 queued ahead of it could win),
    // and the run unwinds without waiting on the database. The audit row follows in the
    // background: denied, even over an `approved` that 👍 wrote first (nothing ran).
    const onAbort = () => {
      finish('denied')
      denyOnAbort(id)
        .catch(err => console.warn(`[channels] approval ${id} cancel failed:`, err instanceof Error ? err.message : err))
    }
    waiters.set(id, finish)
    const poll = setInterval(() => {
      statusOf(id).then((s) => {
        if (s === null) finish('denied') // row gone (its run was deleted): nothing can approve it
        else if (s !== 'pending') finish(s)
      }).catch(err => console.warn(`[channels] approval ${id} poll failed:`, err instanceof Error ? err.message : err))
    }, pollMs)
    const timer = setTimeout(() => {
      settle(id, 'expired')
        // The guarded update matched nothing: a tapback won the race — use its status.
        .then(async won => finish(won ? 'expired' : ((await statusOf(id)) ?? 'denied')))
        .catch((err) => {
          console.warn(`[channels] approval ${id} expiry failed:`, err instanceof Error ? err.message : err)
          finish('expired')
        })
    }, timeoutMs)
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * The approval channel for a run whose reply goes to iMessage chat `chatGuid`. Denies at once
 * (recorded, with the reason) when iMessage isn't configured or the Private API is known to be
 * off — tapbacks need it — or when the prompt can't be sent.
 */
export function imessageApprovalChannel(runId: string, chatGuid: string, deps: ApprovalChannelDeps = {}): Channel {
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS
  const timeoutMs = deps.timeoutMs ?? APPROVAL_TIMEOUT_MS
  return async (req) => {
    // Stopped before it could even ask: nothing to record, nothing to text.
    if (deps.signal?.aborted) {
      logOutcome(runId, req.command, 'denied', 'aborted')
      return { approved: false }
    }
    const db = useDb()
    const client = deps.client !== undefined ? deps.client : await imessageClient()
    const unavailable = !client ? 'imessage-not-configured' : lastHealth().privateApi === false ? 'private-api-off' : null
    const [row] = await db.insert(channelApprovals).values({
      runId, request: req, chatGuid,
      expiresAt: new Date(Date.now() + timeoutMs),
      ...(unavailable ? { status: 'denied', resolvedAt: new Date() } : {})
    }).returning({ id: channelApprovals.id })
    const id = row!.id
    if (unavailable || !client) {
      logOutcome(runId, req.command, 'denied', unavailable ?? undefined)
      return { approved: false }
    }

    let promptGuid: string | null = null
    try {
      promptGuid = (await client.sendText(chatGuid, promptText(req), randomUUID())).guid
    } catch (err) {
      console.warn(`[channels] approval prompt for run ${runId} failed:`, err instanceof Error ? err.message : err)
    }
    // No guid (a failed or unconfirmed send) → no message a tapback could point at.
    if (!promptGuid) {
      await settle(id, 'denied')
      logOutcome(runId, req.command, 'denied', 'prompt-send-failed')
      return { approved: false }
    }
    await db.update(channelApprovals).set({ promptGuid }).where(eq(channelApprovals.id, id))

    const status = await waitFor(id, pollMs, timeoutMs, deps.signal)
    logOutcome(runId, req.command, status, deps.signal?.aborted ? 'aborted' : undefined)
    return { approved: status === 'approved' }
  }
}

/**
 * The runner's channel for an interactive run: reads the run's `reply_to` FRESH at request time
 * (same read as planDeliveries; since C1 it is fixed at run creation, the read is just current) and, when
 * it names an iMessage chat, prompts there. Otherwise denies, as no channel would.
 */
export function replyToApprovalChannel(runId: string, deps: ApprovalChannelDeps = {}): Channel {
  return async (req) => {
    const [fresh] = await useDb().select({ replyTo: agentRuns.replyTo }).from(agentRuns).where(eq(agentRuns.id, runId)).limit(1)
    const r = fresh?.replyTo as { channel?: unknown; chatGuid?: unknown } | null | undefined
    if (r?.channel !== 'imessage' || typeof r.chatGuid !== 'string' || !r.chatGuid) return { approved: false }
    return imessageApprovalChannel(runId, r.chatGuid, deps)(req)
  }
}

/**
 * A tapback from the webhook / catch-up. Tapbacks are routed here BEFORE the inbound pipeline's
 * filters, so every filter is applied here: removed tapbacks, Bridget's own, group chats, a chat
 * that is not the sender's own direct chat and senders not on the allowlist never resolve anything. The tapback must target a pending,
 * unexpired prompt in the same chat the prompt went to.
 */
export async function resolveTapback(ev: TapbackEvent): Promise<'tapback'> {
  if (ev.removed || ev.isFromMe || ev.chatGuid.includes(';+;')) return 'tapback'
  if (!isSendersDirectChat(ev.chatGuid, ev.sender)) return 'tapback' // I2: the sender's own chat only
  const to = ev.tapback === 'love' || ev.tapback === 'like' ? 'approved' : ev.tapback === 'dislike' ? 'denied' : null
  if (!to) return 'tapback'
  const cfg = (await loadChannelsConfig()).imessage
  if (!isAllowed(ev.sender, cfg.allowedHandles)) return 'tapback'

  const [row] = await useDb().select({ id: channelApprovals.id }).from(channelApprovals).where(and(
    eq(channelApprovals.promptGuid, ev.targetGuid),
    eq(channelApprovals.chatGuid, ev.chatGuid),
    eq(channelApprovals.status, 'pending'),
    gt(channelApprovals.expiresAt, new Date())
  )).limit(1)
  if (!row) return 'tapback'
  if (await settle(row.id, to)) waiters.get(row.id)?.(to)
  return 'tapback'
}

/**
 * Housekeeping (catch-up tick): pending approvals past `expires_at` → `expired`. Catches rows
 * whose waiter died with a restart. `onlyIds` is a test seam (the dev DB is shared).
 */
export async function expireApprovals(now: Date = new Date(), opts: { onlyIds?: string[] } = {}): Promise<number> {
  if (opts.onlyIds && !opts.onlyIds.length) return 0
  const where: SQL = and(
    eq(channelApprovals.status, 'pending'),
    lte(channelApprovals.expiresAt, now),
    opts.onlyIds ? inArray(channelApprovals.id, opts.onlyIds) : undefined
  )!
  const rows = await useDb().update(channelApprovals).set({ status: 'expired', resolvedAt: now })
    .where(where).returning({ id: channelApprovals.id })
  for (const r of rows) waiters.get(r.id)?.('expired')
  return rows.length
}

/** Test seam: forget every in-process waiter, as a restart would. */
export function _dropWaiters(): void {
  waiters.clear()
}
