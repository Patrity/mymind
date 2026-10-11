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
import { hostname } from 'node:os'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { useDb } from '../../db'
import { workerCommands, workerHeartbeat } from '../../db/schema'
import type { UndoResult } from '../agent/undo'
import { onListenReady, onNotify } from './listen'

export type InvalidateCache = 'ai-registry' | 'channels' | 'observability' | 'persona' | 'skills' | 'search' | 'imagegen' | 'exec-secrets'

export interface CommandPayloads {
  kick: { conversationId?: string }
  abort: { runId?: string; conversationId?: string }
  'approval-decision': { requestId: string; approved: boolean; pattern?: string }
  undo: { token: string }
  presence: { lastActiveAt: number }
  invalidate: { cache: InvalidateCache }
  'workstream-control': { workstreamId: string; action: 'cancel' | 'resume' | 'steer'; text?: string }
}
export type CommandType = keyof CommandPayloads

/** What each command resolves to (only meaningful with `awaitResult`). */
export interface CommandResults {
  kick: void
  abort: { settled: boolean }
  'approval-decision': void
  undo: UndoResult
  presence: void
  invalidate: void
  'workstream-control': unknown
}

export type CommandHandlers = { [K in CommandType]: (payload: CommandPayloads[K]) => Promise<unknown> }

/** Stored in `worker_commands.result`. */
export type CommandResult = { ok: true; value?: unknown } | { ok: false; error: string; timedOut?: true }

export class CommandTimeoutError extends Error {
  readonly code = 'COMMAND_TIMEOUT' as const
  constructor(readonly commandType: CommandType, readonly commandId: number, readonly timeoutMs: number) {
    super(`the agent worker did not answer "${commandType}" within ${Math.round(timeoutMs / 1000)}s`)
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

async function notify(payload: string) {
  await useDb().execute(sql`select pg_notify('worker_command', ${payload})`)
}

export async function sendCommand<K extends CommandType, T = CommandResults[K]>(
  type: K,
  payload: CommandPayloads[K],
  opts: { awaitResult?: boolean; timeoutMs?: number } = {}
): Promise<T | undefined> {
  const db = useDb()
  if (!opts.awaitResult) {
    const [row] = await db.insert(workerCommands).values({ type, payload }).returning({ id: workerCommands.id })
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
    const [row] = await db.insert(workerCommands).values({ type, payload }).returning({ id: workerCommands.id })
    id = row!.id
    await notify(String(id))
    const read = async () => {
      const [cur] = await db.select({ handledAt: workerCommands.handledAt, result: workerCommands.result })
        .from(workerCommands).where(eq(workerCommands.id, id))
      return cur?.handledAt ? { result: cur.result as CommandResult | null } : null
    }
    const settle = (r: CommandResult | null): T => {
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
    throw new CommandTimeoutError(type, id, timeoutMs)
  } finally {
    off()
  }
}

type Claimed = { id: number; type: string; payload: unknown }

async function claimById(id: number): Promise<Claimed | null> {
  const rows = await useDb().update(workerCommands).set({ claimedAt: new Date() })
    .where(and(eq(workerCommands.id, id), isNull(workerCommands.claimedAt), isNull(workerCommands.handledAt)))
    .returning({ id: workerCommands.id, type: workerCommands.type, payload: workerCommands.payload })
  return rows[0] ?? null
}

async function claimPending(limit = 50): Promise<Claimed[]> {
  const res = await useDb().execute(sql`
    update worker_commands set claimed_at = now()
    where id in (
      select id from worker_commands
      where handled_at is null and claimed_at is null
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

  const sweep = async () => {
    if (stopped) return
    try {
      for (const c of await claimPending()) void run(c)
    } catch (err) {
      console.error('[bus] worker_commands poll failed', err)
    }
  }

  const offNotify = onNotify('worker_command', (p) => {
    if (stopped || p.startsWith(DONE_PREFIX)) return
    const id = Number(p)
    if (!Number.isSafeInteger(id)) return
    claimById(id).then(c => { if (c && !stopped) void run(c) }).catch(err => console.error('[bus] claim failed', err))
  })
  const offReady = onListenReady(() => { void sweep() })
  const timer = setInterval(() => { void sweep() }, pollMs)
  timer.unref?.()
  void sweep()

  return () => {
    stopped = true
    clearInterval(timer)
    offNotify()
    offReady()
  }
}

/** Worker: refresh this boot's heartbeat row (every tick). */
export async function beatWorker(bootId: string): Promise<void> {
  await useDb().insert(workerHeartbeat).values({ bootId, pid: process.pid, host: hostname() })
    .onConflictDoUpdate({ target: workerHeartbeat.bootId, set: { beatAt: sql`now()` } })
}

/** Web: the newest worker heartbeat, and whether it is fresh (≤ staleMs old, by the DB clock). */
export async function workerStatus(staleMs = 30_000): Promise<{ online: boolean; beatAt: Date | null; bootId: string | null }> {
  const res = await useDb().execute(sql`
    select boot_id, beat_at, (now() - beat_at) <= (${staleMs} * interval '1 millisecond') as fresh
    from worker_heartbeat order by beat_at desc limit 1`)
  const r = res.rows[0] as { boot_id: string; beat_at: string | Date; fresh: boolean } | undefined
  if (!r) return { online: false, beatAt: null, bootId: null }
  return { online: !!r.fresh, beatAt: new Date(r.beat_at), bootId: r.boot_id }
}
