// Cycle 81 (spec §3.1): the run-event log — the worker's hub writes here, the web reads it.
//
// One writer per run. `emit` is synchronous and never throws (a run must not die because the
// bus hiccupped); rows go out in emit order, in batches:
//   - consecutive text/reasoning deltas of the same part (same turn, same chunk id, same
//     targeting) merge into ONE row with the concatenated delta, flushed ≤ coalesceMs after the
//     first of them was emitted;
//   - any other frame flushes on the next macrotask (it is a state change the UI should see
//     now), carrying any delta buffered before it, in order.
// Each batch is ONE transaction: rows + `NOTIFY run_event, '<ns>:<conversation_id>:<last id>'`
// (a pointer — the reader fetches rows after its own cursor, so one notify per batch is enough;
// listeners see `<conversation_id>:<last id>`, the ns is stripped by listen.ts). A failed batch is
// retried with backoff at the head of the chain (order preserved); one that fails every attempt
// is reported (onError + the next flush/close rejects) — never dropped silently.
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm'
import { useDb } from '../../db'
import { agentRuns, runEvents } from '../../db/schema'
import type { AgentMessageFrame } from '../../shared/types/agent-ui'
import type { ApprovalRequest } from '../agent/types'
import { notifySql } from './listen'
import { busNs } from './ns'

/** Today's hub frames minus audio (spec §3.1) — what the runner and ws.ts publish to a
 *  conversation's sockets. Audio (`audio-begin`/PCM/`audio-end`) never crosses the bus: TTS runs
 *  in the web process (spec §4). */
export type HubFrame =
  | AgentMessageFrame
  | { type: 'state'; state: 'thinking' | 'speaking' | 'typing' | 'tool' | 'idle' }
  | { type: 'conversation'; conversationId: string; title: string | null }
  | { type: 'persisted'; conversationId: string }
  | { type: 'error'; message: string }
  // An approval card (spec §3.4), published by the worker's approval channel (runtime/
  // bus-approvals.ts) to every socket viewing the thread. ONLY what the card renders is persisted
  // (fix round 1, M3): the worker keeps the full request (args, callId, logSummary, the nonce-bound
  // details) and decides it itself — the web only forwards approved/denied for the requestId.
  | ApprovalCardFrame
  | { type: 'approval-resolved'; requestId: string }

/** The browser's `approval` frame — exactly what ws.ts sent before cycle 81 (app/lib/voice/
 *  messages.ts reads these fields), and exactly what the run-event log stores for a card. */
export interface ApprovalCardFrame {
  type: 'approval'; requestId: string; tool: string; command: string; proposedPattern: string; allowlistable: boolean; title?: string
}
export function clientApprovalFrame(f: { requestId: string } & Pick<ApprovalRequest, 'tool' | 'command' | 'proposedPattern' | 'allowlistable' | 'title'>): ApprovalCardFrame {
  return { type: 'approval', requestId: f.requestId, tool: f.tool, command: f.command, proposedPattern: f.proposedPattern, allowlistable: f.allowlistable === true, ...(f.title !== undefined ? { title: f.title } : {}) }
}

/**
 * The approval cards still OPEN on `conversationId` (fix round 1, I1): every `approval` frame of a
 * still-running run with no `approval-resolved` after it, in order, with its run/seq. A socket that
 * (re)attaches gets these re-sent regardless of its resume cursor — a reconnect resumes PAST the
 * card's seq, so the relay alone would never show it again while the run waits on it. A card whose
 * request the worker has meanwhile dropped (it died) is answered `false` and resolved then.
 */
export async function openApprovalFrames(conversationId: string): Promise<Array<{ frame: ApprovalCardFrame; runId: string; seq: number }>> {
  const rows = await useDb().select({ runId: runEvents.runId, seq: runEvents.seq, type: runEvents.type, payload: runEvents.payload })
    .from(runEvents).innerJoin(agentRuns, eq(agentRuns.id, runEvents.runId))
    .where(and(eq(runEvents.ns, busNs()), eq(runEvents.conversationId, conversationId), eq(agentRuns.status, 'running'),
      inArray(runEvents.type, ['approval', 'approval-resolved'])))
    .orderBy(asc(runEvents.id))
  const open = new Map<string, { frame: ApprovalCardFrame; runId: string; seq: number }>()
  for (const r of rows) {
    const f = r.payload as HubFrame
    if (f.type === 'approval') open.set(f.requestId, { frame: clientApprovalFrame(f), runId: r.runId, seq: r.seq })
    else if (f.type === 'approval-resolved') open.delete(f.requestId)
  }
  // Cycle 81 (workstreams, review I1): a card PARKED across a worker restart has no running run — its
  // source of truth is the workstream's attention (restored by the worker, workstreams/loop.ts). Shown
  // on the workstream's thread and the chat it was started from, while no segment is running.
  const parked = await useDb().execute(sql`
    select w.attention from workstreams w
    where (w.conversation_id = ${conversationId}::uuid or w.origin_conversation_id = ${conversationId}::uuid)
      and w.state = 'attention' and w.attention->>'kind' = 'approval' and w.attention ? 'request'
      and not exists (select 1 from agent_runs r where r.conversation_id = w.conversation_id
                      and r.kind = 'workstream' and r.status = 'running')`)
  for (const { attention } of parked.rows as Array<{ attention: { requestId?: string; runId?: string; request?: Parameters<typeof clientApprovalFrame>[0] } }>) {
    if (!attention.requestId || !attention.request || open.has(attention.requestId)) continue
    open.set(attention.requestId, { frame: clientApprovalFrame({ ...attention.request, requestId: attention.requestId }), runId: attention.runId ?? '', seq: 0 })
  }
  return [...open.values()]
}

export type RunEventRow = typeof runEvents.$inferSelect

export interface RunEventWriter {
  /** Queue a frame; `only` targets one sink (origin-socket frames). Never throws. */
  emit(frame: HubFrame, only?: string | null): void
  /** Resolves once everything emitted so far is committed and notified. */
  flush(): Promise<void>
  /** Flush, then ignore further emits. */
  close(): Promise<void>
}

export const DEFAULT_COALESCE_MS = 50

interface Pending { frame: HubFrame; only: string | null }

type DeltaChunk = { type: 'text-delta' | 'reasoning-delta'; id: string; delta: string }
function deltaOf(f: HubFrame): DeltaChunk | null {
  if (f.type !== 'chunk') return null
  const c = f.chunk as { type: string }
  return c.type === 'text-delta' || c.type === 'reasoning-delta' ? (f.chunk as DeltaChunk) : null
}

/** Folds `next` into `last` when both are deltas of the same part with the same targeting. */
export function tryMerge(last: Pending | undefined, next: Pending): boolean {
  if (!last || last.only !== next.only) return false
  const a = deltaOf(last.frame)
  const b = deltaOf(next.frame)
  if (!a || !b || a.type !== b.type || a.id !== b.id) return false
  if ((last.frame as { turnId: number }).turnId !== (next.frame as { turnId: number }).turnId) return false
  last.frame = { ...last.frame, chunk: { ...a, delta: a.delta + b.delta } } as HubFrame
  return true
}

export type NewRunEventRow = typeof runEvents.$inferInsert

/** Where a writer's batches go. The default is Postgres; tests inject failures. `append` must be
 *  atomic (all rows + the notify, or nothing) — a retry re-sends the whole batch. */
export interface RunEventStore {
  maxSeq(runId: string): Promise<number>
  append(rows: NewRunEventRow[], conversationId: string): Promise<void>
}

export const dbRunEventStore: RunEventStore = {
  async maxSeq(runId) {
    const [r] = await useDb().select({ max: sql<number | null>`max(${runEvents.seq})` }).from(runEvents).where(eq(runEvents.runId, runId))
    return Number(r?.max ?? 0)
  },
  async append(rows, conversationId) {
    // One transaction: the NOTIFY is delivered on commit, so a reader woken by it always finds
    // the rows, and a failed attempt leaves nothing behind for the retry to duplicate.
    await useDb().transaction(async (tx) => {
      const inserted = await tx.insert(runEvents).values(rows).returning({ id: runEvents.id })
      const lastId = Math.max(...inserted.map(r => r.id))
      await tx.execute(notifySql('run_event', `${conversationId}:${lastId}`))
    })
  }
}

/** A batch that could not be written after every retry. The writer keeps going with later
 *  frames; the run sees this through `onError` and from the next `flush()` / `close()`. */
export class RunEventWriteError extends Error {
  readonly code = 'RUN_EVENT_WRITE_FAILED' as const
  constructor(readonly runId: string, readonly frameTypes: string[], override readonly cause: unknown) {
    super(`run_events: lost ${frameTypes.length} frame(s) of run ${runId} (${[...new Set(frameTypes)].join(', ')}): ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'RunEventWriteError'
  }
}

export interface RunEventWriterOptions {
  coalesceMs?: number
  /** Attempts per batch (default 6) and the first backoff (default 100ms, doubling, ≤ 2s). */
  retry?: { attempts?: number; baseMs?: number; maxMs?: number }
  /** Called once per batch that failed every attempt. */
  onError?: (err: RunEventWriteError) => void
  store?: RunEventStore
}

export function createRunEventWriter(runId: string, conversationId: string, opts: RunEventWriterOptions = {}): RunEventWriter {
  const coalesceMs = opts.coalesceMs ?? DEFAULT_COALESCE_MS
  const attempts = Math.max(1, opts.retry?.attempts ?? 6)
  const baseMs = opts.retry?.baseMs ?? 100
  const maxMs = opts.retry?.maxMs ?? 2_000
  const store = opts.store ?? dbRunEventStore
  const ns = busNs()
  let pending: Pending[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let urgent = false
  let closed = false
  let seq: number | null = null
  let failure: RunEventWriteError | null = null
  // Batches commit strictly in order: seq allocation and insert order must match emit order. A
  // batch being retried stays at the head of the chain — later batches wait behind it.
  let chain: Promise<void> = Promise.resolve()

  const attempt = async (batch: Pending[]) => {
    // A run's writer may be re-created (worker restart mid-run), or two writers of one run may
    // overlap (deploy): (re-)read the high-water mark whenever we are not sure of it.
    if (seq === null) seq = await store.maxSeq(runId)
    const base = seq
    const rows: NewRunEventRow[] = batch.map((p, i) => ({
      ns,
      runId,
      conversationId,
      seq: base + i + 1,
      type: p.frame.type,
      payload: p.frame,
      onlySink: p.only
    }))
    await store.append(rows, conversationId)
    seq = base + batch.length
  }

  const writeBatch = async (batch: Pending[]) => {
    let wait = baseMs
    for (let i = 1; ; i++) {
      try {
        await attempt(batch)
        return
      } catch (err) {
        // Includes a (run_id, seq) unique clash with another writer: re-read max(seq) and go on.
        seq = null
        if (i >= attempts) {
          const e = new RunEventWriteError(runId, batch.map(p => p.frame.type), err)
          console.error(`[bus] ${e.message}`)
          failure ??= e
          try { opts.onError?.(e) } catch { /* the reporter must not break the chain */ }
          return
        }
        await new Promise(r => setTimeout(r, wait))
        wait = Math.min(wait * 2, maxMs)
      }
    }
  }

  const kick = () => {
    if (timer) { clearTimeout(timer); timer = null }
    urgent = false
    const batch = pending
    pending = []
    if (batch.length) chain = chain.then(() => writeBatch(batch))
    return chain
  }
  const settled = async () => {
    await kick()
    if (failure) { const f = failure; failure = null; throw f }
  }

  return {
    emit(frame, only = null) {
      if (closed) return
      const p: Pending = { frame, only: only ?? null }
      const isDelta = !!deltaOf(frame)
      if (!(isDelta && tryMerge(pending[pending.length - 1], p))) pending.push(p)
      if (!isDelta) {
        if (!urgent) {
          urgent = true
          if (timer) clearTimeout(timer)
          timer = setTimeout(() => { void kick() }, 0)
        }
      } else if (!timer) {
        timer = setTimeout(() => { void kick() }, coalesceMs)
      }
    },
    flush: settled,
    async close() {
      closed = true
      await settled()
    }
  }
}

/** Rows of the log in id order, this bus namespace only. Scope by conversation and/or run; resume
 *  after `afterId` or, within one run, after `afterSeq`.
 *
 *  ⚠ A bare conversation-scoped `afterId` cursor can SKIP rows: ids are assigned at insert but
 *  become visible at commit, so with two writers on one conversation (abort + new run, steer,
 *  workstream) a higher id may be visible before a lower one. Per run, `afterSeq` is safe (one
 *  writer orders its own seqs). Across runs, use `createRunEventReader`, which re-reads a window
 *  below its cursor and dedupes. */
export async function readRunEvents(q: { conversationId?: string; runId?: string; afterId?: number; afterSeq?: number; limit?: number }): Promise<RunEventRow[]> {
  if (!q.conversationId && !q.runId) throw new Error('readRunEvents needs conversationId or runId')
  if (q.afterSeq !== undefined && !q.runId) throw new Error('readRunEvents: afterSeq needs runId')
  const where = and(
    eq(runEvents.ns, busNs()),
    q.conversationId ? eq(runEvents.conversationId, q.conversationId) : undefined,
    q.runId ? eq(runEvents.runId, q.runId) : undefined,
    q.afterId !== undefined ? gt(runEvents.id, q.afterId) : undefined,
    q.afterSeq !== undefined ? gt(runEvents.seq, q.afterSeq) : undefined
  )
  return useDb().select().from(runEvents).where(where).orderBy(asc(runEvents.id)).limit(q.limit ?? 500)
}

/** The highest run_events id of a conversation in this namespace (0 when it has none) — where a
 *  live reader that must not re-send history starts. */
export async function maxRunEventId(conversationId: string): Promise<number> {
  const [r] = await useDb().select({ max: sql<string | null>`max(${runEvents.id})` }).from(runEvents)
    .where(and(eq(runEvents.ns, busNs()), eq(runEvents.conversationId, conversationId)))
  return Number(r?.max ?? 0)
}

export const DEFAULT_READER_LOOKBACK_IDS = 500

export interface RunEventReader {
  /** Rows not returned before, in id order. */
  next(limit?: number): Promise<RunEventRow[]>
  /** The highest id returned so far (or the starting `afterId`). */
  cursor(): number
}

/** A conversation-scoped reader that does not skip late-committing rows: every read re-scans the
 *  `lookbackIds` ids below its cursor and dedupes by (run_id, seq). Rows at or below the starting
 *  `afterId` are never returned (the caller already has them). */
export function createRunEventReader(q: { conversationId: string; afterId?: number; lookbackIds?: number }): RunEventReader {
  const floor = q.afterId ?? 0
  const lookback = Math.max(0, q.lookbackIds ?? DEFAULT_READER_LOOKBACK_IDS)
  let cur = floor
  const seen = new Map<string, number>() // `${runId}:${seq}` → id
  return {
    cursor: () => cur,
    async next(limit = 500) {
      const from = Math.max(floor, cur - lookback)
      const rows = await readRunEvents({ conversationId: q.conversationId, afterId: from, limit: limit + seen.size })
      const fresh: RunEventRow[] = []
      for (const r of rows) {
        const k = `${r.runId}:${r.seq}`
        if (seen.has(k)) continue
        seen.set(k, r.id)
        fresh.push(r)
        if (r.id > cur) cur = r.id
        if (fresh.length >= limit) break
      }
      for (const [k, id] of seen) if (id <= cur - lookback) seen.delete(k)
      return fresh
    }
  }
}

/** Parses a `run_event` NOTIFY payload (`'<conversation_id>:<id>'`). */
export function parseRunEventNotify(payload: string): { conversationId: string; id: number } | null {
  const i = payload.lastIndexOf(':')
  if (i <= 0) return null
  const id = Number(payload.slice(i + 1))
  return Number.isSafeInteger(id) ? { conversationId: payload.slice(0, i), id } : null
}

/** Retention (spec §3.1): run_events older than this after their run finished are pruned daily. */
export const RUN_EVENTS_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Daily retention (spec §3.1, §5.4): delete this namespace's events of runs that finished more than
 * `olderThanMs` ago — EXCEPT a workstream segment's, kept for as long as its workstream exists (they
 * are its step log; the mirror rows in the origin chat share the run id and go with them). Runs still
 * queued/running are never touched. Batched so one prune never holds a long lock. Returns rows deleted.
 */
export async function pruneRunEvents(olderThanMs = RUN_EVENTS_RETENTION_MS, opts: { batch?: number; onlyRunIds?: string[] } = {}): Promise<number> {
  if (opts.onlyRunIds && !opts.onlyRunIds.length) return 0
  const batch = opts.batch ?? 10_000
  // Test seam: the dev DB is shared, so a test prunes only the runs it made.
  const scope = opts.onlyRunIds ? sql`and r.id in (${sql.join(opts.onlyRunIds.map(id => sql`${id}::uuid`), sql`, `)})` : sql``
  let total = 0
  for (;;) {
    const res = await useDb().execute(sql`
      delete from run_events where id in (
        select e.id from run_events e join agent_runs r on r.id = e.run_id
        where e.ns = ${busNs()}
          and r.status not in ('queued', 'running')
          and r.finished_at < now() - (${olderThanMs} * interval '1 millisecond')
          and not (r.kind = 'workstream' and exists (select 1 from workstreams w where w.conversation_id = r.conversation_id))
          ${scope}
        limit ${batch})`)
    const n = res.rowCount ?? 0
    total += n
    if (n < batch) return total
  }
}
