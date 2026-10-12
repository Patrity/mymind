// Cycle 81 (spec §3.2): web → worker commands over `worker_commands` + NOTIFY.
//
// Sender: insert a row, `NOTIFY worker_command, '<id>'`. With `awaitResult`, wait for the worker
// to finish it — woken by `NOTIFY worker_command, 'done:<id>'`, with a short re-read poll as the
// missed-notify net — and give up at `timeoutMs` (default 10s) with a CommandTimeoutError. A
// sender that gives up closes the row if no worker has claimed it yet, so the command can never
// run after the user was told it failed (never a silent late success).
//
// Worker: `handleCommands` claims rows atomically (`claimed_at`), on notify AND on a poll (the
// poll is the safety net for a notify sent while the worker was down or reconnecting).
//
// Everything is scoped to the bus namespace (ns.ts): a worker claims only its namespace's rows, a
// sender only hears its namespace's done-notifies, and `workerStatus` reads only its namespace's
// heartbeats — so a test's in-process worker and the dev worker on the shared DB never cross.
//
// Ordering: commands are claimed through one serial intake (notify and poll alike) and run on a
// per-thread queue keyed by `conversationId` (else `runId`): a `kick` and a later `kick` of one
// thread run in send order; commands of different threads, or with no key, run concurrently.
// URGENT commands (`abort`, `approval-decision`) never wait in that queue: they start the moment
// they are claimed — a Stop or an approval must not sit behind a slow handler of the same thread —
// but later commands of the thread still wait for them (an abort then a kick: the kick runs after
// the abort's handler returned).
//
// Handler contract: a handler returns once its action has STARTED (or, for commands with an answer,
// once the answer is known) — never after a long-running consequence. `kick` returns once the pump
// is scheduled, not when the run finishes; a handler that awaited a whole run would block every
// later command of its thread for that long.
import { hostname } from 'node:os'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { useDb } from '../../db'
import { workerCommands, workerHeartbeat } from '../../db/schema'
import type { UndoResult } from '../agent/undo'
import type { ImessageHealth } from '../channels/inbound'
import type { WorkstreamDTO } from '../../shared/types/workstreams'
import type { SandboxHealth } from '../../shared/types/workspaces'
import { busNotify, notifySql, onListenReady, onNotify } from './listen'
import { busNs } from './ns'

export type InvalidateCache = 'ai-registry' | 'channels' | 'observability' | 'persona' | 'skills' | 'search' | 'imagegen' | 'exec-secrets' | 'agent-settings'

export interface CommandPayloads {
  kick: { conversationId?: string }
  /** `expiresAt` (epoch ms, fix round 1 M4): a fire-and-forget Stop is void after it — a worker that
   *  was down and claims it late must not abort a turn Tony started since. `/clear` (awaited, closed
   *  on timeout by the sender) needs none. */
  abort: { runId?: string; conversationId?: string; expiresAt?: number }
  /** Tony's answer to a card (runtime/bus-approvals.ts). `remember`/`pattern` = "always allow";
   *  the worker decides whether that may be saved (only for an allowlistable tool). */
  'approval-decision': { requestId: string; approved: boolean; remember?: boolean; pattern?: string }
  undo: { token: string }
  presence: { lastActiveAt: number }
  invalidate: { cache: InvalidateCache }
  'workstream-control': { workstreamId: string; action: 'cancel' | 'resume' | 'steer'; text?: string }
  /** Cycle 82: Tony re-enables a tainted workspace's network. The WORKER does it (it owns the
   *  sandbox): kills the workspace's tainted runs first, then clears the flag (lib/sandbox/manager). */
  'workspace-reenable-network': { workspaceId: string }
  /** Cycle 82 Task 2: read a text file of a workspace (the sandbox lives in the worker) — what an
   *  approved export_to_document proposal, replayed in the web, copies into a document. */
  'workspace-read-text': { workspaceId: string; path: string; tainted?: boolean }
  /** Cycle 82 Task 3: the Files / Shells UI reads a workspace — in the sandbox, so in the worker
   *  (lib/sandbox/view.ts). `chunk` with length 0 = the file's size only. */
  // `noStart` (final review M5): an API-token read — never start a stopped sandbox for it.
  'workspace-view': (
    | { op: 'tree'; workspaceId: string }
    | { op: 'file'; workspaceId: string; path: string }
    | { op: 'chunk'; workspaceId: string; path: string; offset: number; length: number }
    | { op: 'shell-tail'; workspaceId: string; shellId: string }
  ) & { noStart?: boolean }
  /** Cycle 82 Task 3: Tony stops a background shell from the Shells tab. */
  'workspace-kill-shell': { workspaceId: string; shellId: string }
  /** Cycle 81 Task 2 fix: the iMessage catch-up (and its health/`running` guard) lives in the
   *  executing process. `check` = a forced catch-up (Settings → Test), `reset` = forget the health
   *  snapshot after the channel config changed. */
  'imessage-health': { action: 'check' | 'reset' }
}
export type CommandType = keyof CommandPayloads

/** What each command resolves to (only meaningful with `awaitResult`). */
export interface CommandResults {
  kick: void
  abort: { settled: boolean; expired?: true }
  /** Whether the request was still pending in the worker (false: already resolved / unknown). */
  'approval-decision': boolean
  undo: UndoResult
  presence: void
  invalidate: void
  'workstream-control': WorkstreamDTO
  'workspace-reenable-network': { id: string; tainted: boolean }
  'workspace-read-text': { content: string; bytes: number; path: string; tainted: boolean }
  'workspace-view': unknown
  'workspace-kill-shell': { shellId: string; state: string; alreadyEnded: boolean }
  'imessage-health': ImessageHealth
}

/** What the worker publishes with every heartbeat (worker_heartbeat.status). */
export interface WorkerBeatStatus {
  imessage?: ImessageHealth
  /** Cycle 82 final review I6: the sandbox preflight (absent until the worker's first check). */
  sandbox?: SandboxHealth
}

/** One handler per command type. Each returns once its action has STARTED (see the header): the
 *  thread queue waits for it, so it must never await a long-running consequence. */
export type CommandHandlers = { [K in CommandType]: (payload: CommandPayloads[K]) => Promise<unknown> }

/** Commands that bypass the per-thread queue: they must act now, never behind a slow handler. */
export const URGENT_COMMANDS: ReadonlySet<CommandType> = new Set<CommandType>(['abort', 'approval-decision'])

/** Stored in `worker_commands.result`. */
export type CommandResult = { ok: true; value?: unknown } | { ok: false; error: string; timedOut?: true }

export class CommandTimeoutError extends Error {
  readonly code = 'COMMAND_TIMEOUT' as const
  /** `claimed`: a worker picked it up and may still complete it (the UI should say "still
   *  running", not "failed"); false: it was closed unrun and never will run. */
  constructor(readonly commandType: CommandType, readonly commandId: number, readonly timeoutMs: number, readonly claimed = false) {
    super(claimed
      ? `the agent worker is still running "${commandType}" after ${Math.round(timeoutMs / 1000)}s`
      : `the agent worker did not answer "${commandType}" within ${Math.round(timeoutMs / 1000)}s`)
    this.name = 'CommandTimeoutError'
  }
}

export class CommandFailedError extends Error {
  readonly code = 'COMMAND_FAILED' as const
  constructor(readonly commandType: CommandType, readonly commandId: number, message: string) {
    super(message)
    this.name = 'CommandFailedError'
  }
}

export const DEFAULT_COMMAND_TIMEOUT_MS = 10_000
const RESULT_POLL_MS = 500
const DONE_PREFIX = 'done:'

const notify = (payload: string) => busNotify('worker_command', payload)

export async function sendCommand<K extends CommandType, T = CommandResults[K]>(
  type: K,
  payload: CommandPayloads[K],
  opts: { awaitResult?: boolean; timeoutMs?: number; discardResult?: boolean } = {}
): Promise<T | undefined> {
  const db = useDb()
  if (!opts.awaitResult) {
    const [row] = await db.insert(workerCommands).values({ ns: busNs(), type, payload }).returning({ id: workerCommands.id })
    await notify(String(row!.id))
    return undefined
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
  let id = -1
  let wake: (() => void) | null = null
  // Subscribe BEFORE inserting: a fast worker's done-notify must not slip past us.
  const off = onNotify('worker_command', (p) => {
    if (p.startsWith(DONE_PREFIX) && Number(p.slice(DONE_PREFIX.length)) === id) wake?.()
  })
  try {
    const [row] = await db.insert(workerCommands).values({ ns: busNs(), type, payload }).returning({ id: workerCommands.id })
    id = row!.id
    await notify(String(id))
    const read = async () => {
      const [cur] = await db.select({ handledAt: workerCommands.handledAt, result: workerCommands.result })
        .from(workerCommands).where(eq(workerCommands.id, id))
      return cur?.handledAt ? { result: cur.result as CommandResult | null } : null
    }
    const settle = (r: CommandResult | null): T => {
      // `discardResult` (cycle 82 Task 3: download chunks are ~1 MB of base64): the row is deleted
      // once read — nothing else ever reads a handled command's result.
      if (opts.discardResult) void db.delete(workerCommands).where(eq(workerCommands.id, id)).catch(() => {})
      if (r?.ok) return r.value as T
      if (r && 'timedOut' in r && r.timedOut) throw new CommandTimeoutError(type, id, timeoutMs)
      throw new CommandFailedError(type, id, r && !r.ok ? r.error : 'command failed')
    }
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const done = await read()
      if (done) return settle(done.result)
      const left = deadline - Date.now()
      if (left <= 0) break
      await new Promise<void>((resolve) => {
        const t = setTimeout(done, Math.min(RESULT_POLL_MS, left))
        function done() { clearTimeout(t); wake = null; resolve() }
        wake = done
      })
    }
    // Close it if no worker has picked it up; a claimed one is running and will finish on its
    // own (its result is then simply unread).
    const closed = await db.update(workerCommands)
      .set({ handledAt: new Date(), result: { ok: false, error: 'timed out waiting for the agent worker', timedOut: true } satisfies CommandResult })
      .where(and(eq(workerCommands.id, id), isNull(workerCommands.claimedAt), isNull(workerCommands.handledAt)))
      .returning({ id: workerCommands.id })
    if (!closed.length) {
      // Claimed: it may have JUST finished — take the answer if it is there.
      const done = await read()
      if (done) return settle(done.result)
    }
    throw new CommandTimeoutError(type, id, timeoutMs, closed.length === 0)
  } finally {
    off()
  }
}

type Claimed = { id: number; type: string; payload: unknown }

async function claimById(id: number): Promise<Claimed | null> {
  const rows = await useDb().update(workerCommands).set({ claimedAt: new Date() })
    .where(and(eq(workerCommands.ns, busNs()), eq(workerCommands.id, id), isNull(workerCommands.claimedAt), isNull(workerCommands.handledAt)))
    .returning({ id: workerCommands.id, type: workerCommands.type, payload: workerCommands.payload })
  return rows[0] ?? null
}

async function claimPending(limit = 50): Promise<Claimed[]> {
  const res = await useDb().execute(sql`
    update worker_commands set claimed_at = now()
    where id in (
      select id from worker_commands
      where ns = ${busNs()} and handled_at is null and claimed_at is null
      order by id
      limit ${limit}
      for update skip locked
    )
    returning id, type, payload`)
  return (res.rows as Array<{ id: string | number; type: string; payload: unknown }>)
    .map(r => ({ id: Number(r.id), type: r.type, payload: r.payload }))
    .sort((a, b) => a.id - b.id)
}

/** Worker side: run `handlers` for every command — on notify, on listener (re)connect, and on a
 *  `pollMs` poll. Returns the stop function. */
export function handleCommands(handlers: CommandHandlers, opts: { pollMs?: number } = {}): () => void {
  let stopped = false
  const pollMs = opts.pollMs ?? 5_000

  const run = async (c: Claimed) => {
    let result: CommandResult
    const h = (handlers as Record<string, ((p: unknown) => Promise<unknown>) | undefined>)[c.type]
    try {
      if (!h) throw new Error(`no handler for command "${c.type}"`)
      const value = await h(c.payload)
      result = value === undefined ? { ok: true } : { ok: true, value }
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    try {
      await useDb().update(workerCommands).set({ handledAt: new Date(), result }).where(eq(workerCommands.id, c.id))
      await notify(`${DONE_PREFIX}${c.id}`)
    } catch (err) {
      console.error(`[bus] could not record result of command ${c.id} (${c.type})`, err)
    }
  }

  // One serial intake: claims (and the hand-off to a thread queue) happen in claim order.
  let intake: Promise<void> = Promise.resolve()
  const queues = new Map<string, Promise<void>>()
  const keyOf = (c: Claimed): string | null => {
    const p = (c.payload ?? {}) as { conversationId?: unknown; runId?: unknown }
    if (typeof p.conversationId === 'string' && p.conversationId) return `c:${p.conversationId}`
    if (typeof p.runId === 'string' && p.runId) return `r:${p.runId}`
    return null
  }
  // Never skipped once claimed (even if stop() raced the claim): a claimed row nobody runs
  // would stay claimed forever.
  const dispatch = (c: Claimed) => {
    const k = keyOf(c)
    if (!k) { void run(c); return }
    const prev = queues.get(k) ?? Promise.resolve()
    let next: Promise<void>
    if (URGENT_COMMANDS.has(c.type as CommandType)) {
      // Starts now, ahead of whatever the thread is still running; later commands of the thread
      // wait for it AND for everything before it (it is a barrier, not a jump of the whole queue).
      const started = run(c)
      next = Promise.all([prev, started]).then(() => {})
    } else {
      next = prev.then(() => run(c))
    }
    queues.set(k, next)
    void next.finally(() => { if (queues.get(k) === next) queues.delete(k) })
  }
  const enqueue = (claim: () => Promise<Claimed[]>) => {
    intake = intake.then(async () => {
      if (stopped) return
      try {
        for (const c of await claim()) dispatch(c)
      } catch (err) {
        console.error('[bus] worker_commands claim failed', err)
      }
    })
  }
  const sweep = () => enqueue(() => claimPending())

  const offNotify = onNotify('worker_command', (p) => {
    if (stopped || p.startsWith(DONE_PREFIX)) return
    const id = Number(p)
    if (!Number.isSafeInteger(id)) return
    enqueue(async () => { const c = await claimById(id); return c ? [c] : [] })
  })
  const offReady = onListenReady(sweep)
  const timer = setInterval(sweep, pollMs)
  timer.unref?.()
  sweep()

  return () => {
    stopped = true
    clearInterval(timer)
    offNotify()
    offReady()
  }
}

/** Worker: refresh this boot's heartbeat row (every tick). */
export async function beatWorker(bootId: string, status?: WorkerBeatStatus): Promise<void> {
  await useDb().insert(workerHeartbeat).values({ bootId, ns: busNs(), pid: process.pid, host: hostname(), status: status ?? null })
    .onConflictDoUpdate({ target: workerHeartbeat.bootId, set: { beatAt: sql`now()`, ...(status ? { status } : {}) } })
}

/** Web: this namespace's newest worker heartbeat, and whether it is fresh (≤ staleMs old, by the DB clock). */
export async function workerStatus(staleMs = 30_000): Promise<{ online: boolean; beatAt: Date | null; bootId: string | null; status: WorkerBeatStatus | null }> {
  const res = await useDb().execute(sql`
    select boot_id, beat_at, status, (now() - beat_at) <= (${staleMs} * interval '1 millisecond') as fresh
    from worker_heartbeat where ns = ${busNs()} order by beat_at desc limit 1`)
  const r = res.rows[0] as { boot_id: string; beat_at: string | Date; status: WorkerBeatStatus | null; fresh: boolean } | undefined
  if (!r) return { online: false, beatAt: null, bootId: null, status: null }
  return { online: !!r.fresh, beatAt: new Date(r.beat_at), bootId: r.boot_id, status: r.status ?? null }
}

/** How long a fire-and-forget Stop stays valid (fix round 1, M4). */
export const STOP_ABORT_TTL_MS = 15_000

/**
 * Web: Tony's last activity → the worker (spec §3.6) as ONE pending row (fix round 1, M7): the
 * client pings once a minute per tab, and a queue row per ping would grow forever. Earlier presence
 * rows that are handled, or still unclaimed (superseded — the worker keeps the max anyway), are
 * deleted in the same transaction as the insert; one being handled right now is left to finish.
 */
export async function sendPresence(lastActiveAt: number): Promise<void> {
  await useDb().transaction(async (tx) => {
    await tx.delete(workerCommands).where(and(eq(workerCommands.ns, busNs()), eq(workerCommands.type, 'presence'),
      sql`(${workerCommands.handledAt} is not null or ${workerCommands.claimedAt} is null)`))
    const [row] = await tx.insert(workerCommands).values({ ns: busNs(), type: 'presence', payload: { lastActiveAt } satisfies CommandPayloads['presence'] })
      .returning({ id: workerCommands.id })
    await tx.execute(notifySql('worker_command', String(row!.id)))
  })
}

/** Worker maintenance (fix round 1, M7): forget this namespace's handled commands older than
 *  `olderThanMs` (default a day) — nothing reads a result that old — and (cycle 81 Task 5) commands
 *  CLAIMED that long ago but never handled: the worker that claimed them died mid-command, nothing
 *  will ever finish them, and their sender gave up after its 10s timeout. Returns how many went. */
export async function pruneHandledCommands(olderThanMs = 24 * 60 * 60 * 1000): Promise<number> {
  const old = (col: typeof workerCommands.handledAt | typeof workerCommands.claimedAt) => sql`${col} < now() - (${olderThanMs} * interval '1 millisecond')`
  const rows = await useDb().delete(workerCommands)
    .where(and(eq(workerCommands.ns, busNs()), sql`(${old(workerCommands.handledAt)} or (${workerCommands.handledAt} is null and ${old(workerCommands.claimedAt)}))`))
    .returning({ id: workerCommands.id })
  return rows.length
}
