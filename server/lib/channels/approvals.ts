// server/lib/channels/approvals.ts
// Exec approvals over iMessage (spec §6). A run that answers over iMessage (`reply_to`) gets an
// approval channel that texts "Run `cmd`? 👍 to approve · 👎 to deny" (worded per tool — see
// approvalPromptText) to the reply chat and waits:
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

/** gmail_send's command is a multi-line From/To/Cc/Bcc/Subject + the FULL draft body (the tool no
 *  longer caps it — cycle 79 fix wave I2, so the web card shows everything). A text message can't
 *  carry an arbitrarily long email, so the iMessage prompt keeps a ceiling on the WHOLE rendered
 *  command — but whenever it cuts, it says so explicitly ("showing N of M chars") and tells Tony
 *  to open the draft before approving, so he never approves text he thinks he has read in full. */
export const GMAIL_SEND_PROMPT_MAX = 1800

/** The cut-off notice shared by the gmail and calendar prompts. */
function truncatedPrompt(command: string, max: number, advice: string): string {
  if (command.length <= max) return command
  return `${command.slice(0, max)}…\n[showing ${max.toLocaleString('en-US')} of ${command.length.toLocaleString('en-US')} chars — ${advice}]`
}

function gmailSendPromptBody(command: string): string {
  return truncatedPrompt(command, GMAIL_SEND_PROMPT_MAX, 'open the draft in Gmail before approving')
}

/** calendar_guest_event / calendar_rsvp (cycle 79, Task 5): the command is a multi-line card (op,
 *  title, when in Tony's zone, guests, the change, and the FULL description/note — fix wave I2).
 *  Like gmail_send it must not be cut at PROMPT_COMMAND_MAX (a long guest list would lose the
 *  change Tony is approving); a ceiling on the whole command, with the same explicit notice. */
export const CALENDAR_PROMPT_MAX = 1500
const CALENDAR_APPROVAL_TOOLS: ReadonlySet<string> = new Set(['calendar_guest_event', 'calendar_rsvp'])

function calendarPromptBody(command: string): string {
  return truncatedPrompt(command, CALENDAR_PROMPT_MAX, 'open the event in Google Calendar before approving')
}

/** Any other TITLED card (fix wave I3 / 79b: an outbound call — web_fetch / web_search / research_web, or a job/wake tool —
 *  after a Google read still in the model context) carries its own heading and a multi-line body showing the
 *  exact URL/query; same ceiling-with-notice treatment, since there is nothing to "open". */
export const TITLED_PROMPT_MAX = 1500

/**
 * The texted question, worded per tool (final review m1): exec asks to run a command; a review
 * decision is not a command, so it reads as one (`command` is "<choice> — <summary>"); any other
 * dangerous tool names itself. gmail_send (cycle 79 review I3) gets its own format — "Send this
 * email?" over the real From/To/Cc/Bcc/Subject + body, no backtick wrapping (iMessage doesn't
 * render them, and a closing backtick-question-mark after a long body reads badly) — and is
 * EXEMPT from PROMPT_COMMAND_MAX, using GMAIL_SEND_PROMPT_MAX instead. calendar_guest_event /
 * calendar_rsvp (cycle 79, Task 5) likewise: their own card title ("Invite guests?", "Send
 * RSVP?") over the multi-line event card, no backticks, CALENDAR_PROMPT_MAX. Any other titled
 * card (fix wave I3 / 79b outbound-after-a-Google-read) gets its title + body under TITLED_PROMPT_MAX.
 * Every cut states "showing N of M chars" (fix wave I2).
 */
export function approvalPromptText(req: ApprovalRequest): string {
  if (req.tool === 'gmail_send') {
    return `Send this email?\n\n${gmailSendPromptBody(req.command)}\n\n👍 to send · 👎 to deny`
  }
  if (CALENDAR_APPROVAL_TOOLS.has(req.tool)) {
    return `${req.title ?? 'Change this calendar event?'}\n\n${calendarPromptBody(req.command)}\n\n👍 to approve · 👎 to deny`
  }
  if (req.title && req.tool !== 'exec' && req.tool !== 'decide_review') {
    return `${req.title}?\n\n${truncatedPrompt(req.command, TITLED_PROMPT_MAX, 'deny unless you can see the whole request')}\n\n👍 to approve · 👎 to deny`
  }
  const cmd = req.command.length > PROMPT_COMMAND_MAX ? `${req.command.slice(0, PROMPT_COMMAND_MAX - 1)}…` : req.command
  const ask = req.tool === 'exec' ? `Run \`${cmd}\`?`
    : req.tool === 'decide_review' ? `Approve review decision: ${cmd}?`
      : `Allow ${req.tool}: \`${cmd}\`?`
  return `${ask}\n👍 to approve · 👎 to deny`
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

// Takes the whole request (not just a command string) so it can prefer `req.logSummary` over
// `req.command` — gmail_send's `command` is the exact draft body, which the global constraint
// forbids writing to activity_log (cycle 79 review I4). Every OTHER tool has no `logSummary`, so
// this is a no-op fallback to the same `command` it always logged.
function logOutcome(runId: string, req: ApprovalRequest, outcome: string, reason?: string): void {
  recordEvent({
    kind: 'tool', name: 'exec:approval', severity: outcome === 'approved' ? 'info' : 'warn',
    meta: { channel: 'imessage', runId, outcome, command: req.logSummary ?? req.command, ...(reason ? { reason } : {}) }
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
      logOutcome(runId, req, 'denied', 'aborted')
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
      logOutcome(runId, req, 'denied', unavailable ?? undefined)
      return { approved: false }
    }

    let promptGuid: string | null = null
    try {
      promptGuid = (await client.sendText(chatGuid, approvalPromptText(req), randomUUID())).guid
    } catch (err) {
      console.warn(`[channels] approval prompt for run ${runId} failed:`, err instanceof Error ? err.message : err)
    }
    // No guid (a failed or unconfirmed send) → no message a tapback could point at.
    if (!promptGuid) {
      await settle(id, 'denied')
      logOutcome(runId, req, 'denied', 'prompt-send-failed')
      return { approved: false }
    }
    await db.update(channelApprovals).set({ promptGuid }).where(eq(channelApprovals.id, id))

    const status = await waitFor(id, pollMs, timeoutMs, deps.signal)
    logOutcome(runId, req, status, deps.signal?.aborted ? 'aborted' : undefined)
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
 *
 * True when the tapback answered an approval prompt (even one a racing expiry settled first):
 * the caller then must not count it as anything else (cycle 76 engagement signals).
 */
export async function resolveTapback(ev: TapbackEvent): Promise<boolean> {
  if (ev.removed || ev.isFromMe || ev.chatGuid.includes(';+;')) return false
  if (!isSendersDirectChat(ev.chatGuid, ev.sender)) return false // I2: the sender's own chat only
  const to = ev.tapback === 'love' || ev.tapback === 'like' ? 'approved' : ev.tapback === 'dislike' ? 'denied' : null
  if (!to) return false
  const cfg = (await loadChannelsConfig()).imessage
  if (!isAllowed(ev.sender, cfg.allowedHandles)) return false

  const [row] = await useDb().select({ id: channelApprovals.id }).from(channelApprovals).where(and(
    eq(channelApprovals.promptGuid, ev.targetGuid),
    eq(channelApprovals.chatGuid, ev.chatGuid),
    eq(channelApprovals.status, 'pending'),
    gt(channelApprovals.expiresAt, new Date())
  )).limit(1)
  if (!row) return false
  if (await settle(row.id, to)) waiters.get(row.id)?.(to)
  return true
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
